/**
 * The `ipython` tool for hosts that run agents on pi-durable, such as the workflows engine.
 *
 * Each conversation gets its own kernel. A cell's checkpoint ID is an entry of its conversation, so a fork, or a store
 * reopened after a crash, restores the namespace of its own history.
 *
 * The host passes its pi-durable and pi-ai modules, so this package loads no second copy of either. It also passes the
 * event bus that its other extensions share; pi-rlm adds its kernel setup there on `ipython:kernel-starting`.
 */
import type * as Ai from "@earendil-works/pi-ai";
import type * as Durable from "@earendil-works/pi-durable";
import type { ConversationId, Cursor, Tx } from "@earendil-works/pi-durable";
import { cellResult, DESCRIPTION } from "../extensions/cell.ts";
import { describeError, type KernelHost } from "../extensions/kernel-runtime.ts";
import { OUTPUT_MAX_BYTES, OUTPUT_MAX_LINES } from "../extensions/output.ts";
import { createRuntime, type Runtime } from "../extensions/persistence.ts";

export interface DurableHost {
	readonly durable: typeof Durable;
	readonly ai: typeof Ai;
	readonly events: KernelHost["events"];
}

export const CHECKPOINT_ENTRY_KIND = "pi-ipython.checkpoint";

export default function ipython({ durable, ai, events }: DurableHost) {
	const CheckpointEntry = durable.defineEntry<{ checkpoint: string }>(CHECKPOINT_ENTRY_KIND);
	// One kernel per conversation until close(). Hosts with many conversations will need idle eviction.
	const runtimes = new Map<string, Runtime>();
	let closing: Promise<void> | undefined;

	/**
	 * The checkpoint IDs visible from `conversationId`, through its fork ancestry, newest first. This reads the whole
	 * history on every cell; stop at the newest ID if long conversations get slow.
	 */
	async function checkpointIds(tx: Tx, conversationId: ConversationId): Promise<string[]> {
		const ids: string[] = [];
		let cursor: Cursor | undefined;
		do {
			const page = await tx.scanEntries({ conversationId, order: "descending" }, 256, cursor);
			for (const entry of page.items) if (CheckpointEntry.is(entry)) ids.push(entry.data.checkpoint);
			cursor = page.next;
		} while (cursor !== undefined);
		return ids;
	}

	const tool = durable.defineTool({
		name: "ipython",
		description: DESCRIPTION,
		parameters: ai.Type.Object({ code: ai.Type.String({ description: "Python or an IPython cell" }) }),
		executionMode: "sequential",
		// The content is the output tail, already within these limits, so the harness never cuts it again.
		outputLimits: { maxLines: OUTPUT_MAX_LINES, maxBytes: OUTPUT_MAX_BYTES, retain: "tail" },
		async execute(args, api, context) {
			const signal = context.abortSignal;
			const { cwd = process.cwd() } = await api.agent(context);
			if (closing) throw new Error("IPython runtime is shutting down");
			const key = String(api.conversationId);
			let runtime = runtimes.get(key);
			if (!runtime) runtimes.set(key, runtime = createRuntime({ events }, cwd));
			const { kernel, checkpoints } = runtime;

			const candidates = await api.commit((tx) => checkpointIds(tx, api.conversationId), context);
			const notices = await checkpoints.sync(candidates, cwd, signal, () => {});
			let streamed = "";
			const execution = await kernel.execute(api.callId, args.code, cwd, signal, () => {}, (output) => {
				// Running output for viewers. api.output only appends, so after a clear they see the old output, then the new.
				api.output(output.startsWith(streamed) ? output.slice(streamed.length) : output);
				streamed = output;
			});
			const checkpoint = checkpoints.save();
			if (checkpoint !== undefined) {
				await api.commit((tx) => tx.appendEntry(CheckpointEntry, api.conversationId, { data: { checkpoint } }), context);
			}

			// Resets, restores and the truncation line are remarks for the model, which the harness renders after the output.
			const { data, header } = cellResult(execution, notices, (text) => kernel.saveOutput(text));
			const diagnostics: Durable.ToolDiagnostic[] = data.notices.map((message) => ({ severity: "info", message }));
			if (header) diagnostics.push({ severity: "info", code: "output_truncated", message: header });
			const text = data.output || (data.status === "error" && describeError(execution.result.error)) || "[no output]";
			return {
				content: [{ type: "text", text }],
				details: { status: data.status, kernelReset: execution.kernelReset, truncated: data.truncated },
				diagnostics,
				isError: data.status === "error",
			};
		},
	});

	return {
		extensions: [durable.defineExtension({ name: "pi-ipython", tools: [tool] })],
		/** Waits for pending checkpoints, then stops every kernel, also when one of them fails to stop. */
		close(): Promise<void> {
			closing ??= (async () => {
				const results = await Promise.allSettled([...runtimes.values()].map((runtime) => runtime.close()));
				runtimes.clear();
				const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
				if (errors.length > 0) throw new AggregateError(errors, "Some IPython kernels did not stop");
			})();
			return closing;
		},
	};
}

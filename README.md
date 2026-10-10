# pi-ipython

A Pi package providing one `ipython` tool (a single `code` parameter) backed by a
persistent, extension-owned Jupyter/IPython kernel, with top-level `await` and
native IPython magics. It has no RLM support of its own;
[pi-rlm](https://github.com/Vzlentin/pi-rlm) adds it on top. The same tool also
runs in hosts built on pi-durable, see [pi-durable](#pi-durable).

## Install

Requirements:

- macOS or Linux, with Bash and `lockf` (macOS) or `flock` (Linux).
- Node.js 22.19 or newer, npm, Git, and Pi (tested with 1.1.0).
- `uv` on `PATH`. The first tool call provisions an extension-owned Python 3.12
  runtime with ipykernel, jupyter-client, and cloudpickle in `extensions/.python`,
  so it needs network access.

```bash
pi install https://github.com/Vzlentin/pi-ipython
```

For development, from a clone: `npm install`, `npm test`, then run
`pi -ne -e ./extensions/ipython.ts` for an isolated session.

## Extending the kernel

Before every kernel start (including restarts), the extension emits
`ipython:kernel-starting` on `pi.events` with a mutable payload. In a pi-durable
host it goes to the event bus the host passes in:

```ts
interface KernelStartingEvent {
	env: Record<string, string>; // merged into the bridge and kernel environment
	startupCode: string[]; // run hidden once the kernel is ready
	waitFor(promise: Promise<unknown>): void; // awaited before the kernel is spawned
}
```

Listeners must register on the payload before their first `await`. Environment
values can be filled in by a promise passed to `waitFor`. A failing startup
snippet fails the kernel start. The variables reach the kernel, not Pi's own
process.

In pi-durable hosts only, the event also has `conversationId`, the conversation that owns the kernel. Each cell
also emits two events on the host's bus:

- `ipython:cell-start` with `{ conversationId, api, context }`, before the cell runs. `api` and `context` are the
  `ipython` call's, so a listener can use `api.commit(..., context)` while the cell runs, for example to create a
  conversation owned by `api.taskId`.
- `ipython:cell-end` with `{ conversationId }`, after the cell ends, also when it raises, is cancelled or loses its
  kernel.

## Cells in Herdr

In interactive Pi inside Herdr, use `/cells` or `Ctrl+Shift+I` to toggle an IPython console on the right, attached to the same kernel. It first prints the recorded history (code, output, progress, errors, and reset notices), then mirrors each new cell live as Pi runs it. Type at its prompt to inspect the kernel, for example `%whos`, `%history -o`, or a variable name. Cells run while the console is closed remain in the history. Your focus stays in Pi. Repeat `/cells` to close it.

The console is [Euporie Console](https://euporie.readthedocs.io/) 2.10.4, started through `uv tool run` in a separate cached environment. It provides syntax highlighting and rich live output. Previous cells are printed as plain text above Euporie, available through terminal scrollback, not loaded as notebook cells or rerun. Mouse capture is disabled so you can scroll back normally. Use `Ctrl+Enter` to run code at the prompt.

It does not install anything into the extension-owned Python runtime. Opening `/cells` starts the kernel if needed. After a kernel reset, repeat `/cells` to reconnect. Closing the console does not stop the kernel.

History is plain text, recorded from the first tool call after loading the extension. Its private temporary file is limited to 16 MiB. `/reload`, session changes, and exit close the console and delete its temporary files. The model's output limits are unchanged.

**The console is interactive, not read-only.** Code entered there changes the same kernel state as Pi. Do not run code there while Pi is working.

## Interruption

Cancellation and output overflow first send SIGINT to the kernel process group. If the cell stops within 3 seconds, its partial output is returned as an error and kernel state is preserved. Otherwise the kernel and associated child work are killed. Top-level `await` is supported, including a signal-wakeup workaround for ipykernel 7.

On macOS and Linux, the bridge and kernel exit within five seconds after their owning Pi process exits, including SIGKILL during a cell or checkpoint save. Normal shutdown allows up to ten seconds to flush pending checkpoints before stopping the kernel. An abrupt exit can lose an unfinished checkpoint.

## Codemode scripts

In a `codemode` script, `tools.ipython` resolves to an object with `status`, `output`, `executionCount`, `error` (`ename` and `evalue`), `truncated`, `fullOutputPath`, and `notices`. A Python exception or an interrupted cell resolves with `status: "error"`, so the script can check it and keep going on the same kernel. The call rejects when the kernel is lost.

`notices` holds kernel restarts and checkpoint restores that happened before the cell ran. They are also appended to the script's own result, so the model sees them even when the script does not return them.

Cells get their code as a string. To pass script data in, embed it as a JSON string, for example `json.loads(${JSON.stringify(JSON.stringify(data))})`.

## Persistence

By default, each completed Pi `ipython` cell receives a checkpoint ID and its public, supported variables are saved in the background. Before the next cell, the extension waits for that save and finds the nearest IPython checkpoint on the current conversation branch. Navigating with `/tree`, resuming, forking, reloading, or recovering from a crash therefore restores that branch's latest committed cell. If its newest checkpoint is unavailable, the next older committed checkpoint is used; a branch with no IPython cells resets the namespace to its startup state.

Cells that another tool runs, such as a `codemode` script, are checkpointed too. Pi does not save their results, so each checkpoint ID goes into an `ipython-checkpoint` custom entry on the branch. If the script fails later, its earlier cells stay checkpointed because the kernel state already changed.

The result after a restore reports its source cell, restored names, and skipped values. A failed background save does not roll back the live kernel. A failed save is reported with the next result. A cancelled restore is retried on the next call; a restore that fails or times out is not, and the cell runs on the namespace left behind. If restoring a value kills the kernel, that value is deleted from the store and the restore is retried on a fresh kernel, up to three attempts per call.

Checkpointing is best-effort:

- Module aliases are re-imported. Cell-defined functions and classes are saved by value with cloudpickle, and restored functions use the current kernel globals.
- Names beginning with `_`, IPython internals, startup names supplied by extensions, and live files, sockets, generators, coroutines, and tasks are not saved.
- Values are limited to **64 MiB each** and **256 MiB of pickled data per cell**. Separate names are serialized independently, so aliases can restore as separate objects even though unchanged serialized content is deduplicated on disk.
- Files written by cells are not rewound. Neither are live resources or process state such as `sys.path`, `os.environ`, the working directory, monkeypatches, imported module globals, or threads.
- Input entered directly in `/cells` is included in the next Pi cell's checkpoint. If you navigate before another Pi cell, that console-only input is not followed to the other branch.

Content-addressed blobs and per-cell manifests live in `${XDG_CACHE_HOME:-~/.cache}/pi-ipython/checkpoints/`. A global lock serializes saves, restores, and cleanup across sessions; a restored value's `__setstate__` runs under it, so a slow one blocks other sessions for up to the 10-second restore deadline plus the 3-second interrupt grace. Manifests unused for 30 days are removed, and least-recently-used manifests are evicted when the store exceeds 2 GiB; unreferenced blobs are then deleted. Manifest access during restore refreshes its recency.

Disable all checkpoint saves, restores, and checkpoint result details with either:

```bash
export PI_IPYTHON_PERSISTENCE=0
```

or `.pi/pi-ipython.json` in the working directory or an ancestor up to the Git root:

```json
{ "persistence": false }
```

Opt-out leaves existing cache data untouched and otherwise restores the extension's non-persistent behavior.

**Checkpoint security:** pickles can execute code and may contain sensitive data. Store directories are `0700`, files are `0600`, and symlinks, unowned paths, non-private paths, and malformed checkpoint IDs are refused. Do not place untrusted files in the checkpoint cache or share it with another user.

## pi-durable

Hosts that run agents on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable), such as
[workflows](https://github.com/Vzlentin/workflows), get the same `ipython` tool from `durable/index.ts`. The
package declares it in its own field, which Pi does not read:

```json
"piDurable": { "extensions": ["./durable/index.ts"] }
```

The default export takes the host's pi-durable and pi-ai modules and its event bus. It imports neither module at
run time, so the host's copies are the only ones.

```ts
import * as ai from "@earendil-works/pi-ai";
import * as durable from "@earendil-works/pi-durable";
import ipython from "pi-ipython/durable/index.ts";

const tool = ipython({ durable, ai, events });
for (const extension of tool.extensions) registry.install(extension);
// When the host stops: waits for pending checkpoints, then stops every kernel.
await tool.close();
```

- Each conversation gets its own kernel, in the conversation's working directory.
- A cell's checkpoint ID is a `pi-ipython.checkpoint` entry of its conversation. A fork, or a store reopened after
  a crash, restores the latest checkpoint of its own history, with the same notices as in Pi.
- The output of a result is the output tail. Kernel resets, checkpoint restores and the line that names the file
  with the full output are diagnostics, which the harness shows after it.
- The kernel-starting event names the conversation, and each cell emits `ipython:cell-start` and `ipython:cell-end`.
  See [Extending the kernel](#extending-the-kernel).
- Results have structured output: the `CellResult`, as in Pi. A tool that runs a cell through `api.executeTool`
  gets it as `structuredOutput`.
- There is no `/cells` console.

## Security

The kernel is not sandboxed. Code runs with your user permissions and can access local files, environment variables, and the network. The separate Python runtime isolates dependencies, not system access.

## Tests

```bash
npm test
```

Model-free: typechecking and real kernels for state, working directory, synchronous and asynchronous interruption, overflow capture, reset cleanup, the startup hook, the Herdr console, and the pi-durable tool with a faux model. See [tests/README.md](tests/README.md).

## License

MIT

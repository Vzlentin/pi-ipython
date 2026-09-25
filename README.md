# pi-ipython

A Pi package providing one `ipython` tool (a single `code` parameter) backed by a
persistent, extension-owned Jupyter/IPython kernel, with top-level `await` and
native IPython magics. It has no RLM support of its own;
[pi-rlm](https://github.com/Vzlentin/pi-rlm) adds it on top.

## Install

Requirements:

- macOS or Linux, with Bash and `lockf` (macOS) or `flock` (Linux).
- Node.js 22.19 or newer, npm, Git, and Pi (tested with 0.87.1).
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
`ipython:kernel-starting` on `pi.events` with a mutable payload:

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

## Cells in Herdr

In interactive Pi inside Herdr, use `/cells` or `Ctrl+Shift+I` to toggle an IPython console on the right, attached to the same kernel. It first prints the recorded history (code, output, progress, errors, and reset notices), then mirrors each new cell live as Pi runs it. Type at its prompt to inspect the kernel, for example `%whos`, `%history -o`, or a variable name. Cells run while the console is closed remain in the history. Your focus stays in Pi. Repeat `/cells` to close it.

The console is [Euporie Console](https://euporie.readthedocs.io/) 2.10.4, started through `uv tool run` in a separate cached environment. It provides syntax highlighting and rich live output. Previous cells are printed as plain text above Euporie, available through terminal scrollback, not loaded as notebook cells or rerun. Mouse capture is disabled so you can scroll back normally. Use `Ctrl+Enter` to run code at the prompt.

It does not install anything into the extension-owned Python runtime. Opening `/cells` starts the kernel if needed. After a kernel reset, repeat `/cells` to reconnect. Closing the console does not stop the kernel.

History is plain text, recorded from the first tool call after loading the extension. Its private temporary file is limited to 16 MiB. `/reload`, session changes, and exit close the console and delete its temporary files. The model's output limits are unchanged.

**The console is interactive, not read-only.** Code entered there changes the same kernel state as Pi. Do not run code there while Pi is working.

## Interruption

Cancellation and output overflow first send SIGINT to the kernel process group. If the cell stops within 3 seconds, its partial output is returned as an error and kernel state is preserved. Otherwise the kernel and associated child work are killed. Top-level `await` is supported, including a signal-wakeup workaround for ipykernel 7.

## Persistence

By default, each completed Pi `ipython` cell receives a checkpoint ID and its public, supported variables are saved in the background. Before the next cell, the extension waits for that save and finds the nearest IPython result on the current conversation branch. Navigating with `/tree`, resuming, forking, reloading, or recovering from a crash therefore restores that branch's latest committed cell. If its newest checkpoint is unavailable, the next older committed checkpoint is used; a branch with no IPython cells resets the namespace to its startup state.

The result after a restore reports its source cell, restored names, and skipped values. A failed background save does not roll back the live kernel. Each result also records the previous cell's save duration as `details.checkpointSaveMs` when available.

Checkpointing is best-effort:

- Module aliases are re-imported. Cell-defined functions and classes are saved by value with cloudpickle, and restored functions use the current kernel globals.
- Names beginning with `_`, IPython internals, startup names supplied by extensions, and live files, sockets, generators, coroutines, and tasks are not saved.
- Values are limited to **64 MiB each** and **256 MiB of pickled data per cell**. Separate names are serialized independently, so aliases can restore as separate objects even though unchanged serialized content is deduplicated on disk.
- Files written by cells are not rewound. Neither are live resources or process state such as `sys.path`, `os.environ`, the working directory, monkeypatches, imported module globals, or threads.
- Input entered directly in `/cells` is included in the next Pi cell's checkpoint. If you navigate before another Pi cell, that console-only input is not followed to the other branch.

Content-addressed blobs and per-cell manifests live in `${XDG_CACHE_HOME:-~/.cache}/pi-ipython/checkpoints/`. A global lock serializes saves and cleanup. Manifests unused for 30 days are removed, and least-recently-used manifests are evicted when the store exceeds 2 GiB; unreferenced blobs are then deleted. Manifest access during restore refreshes its recency.

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

## Security

The kernel is not sandboxed. Code runs with your user permissions and can access local files, environment variables, and the network. The separate Python runtime isolates dependencies, not system access.

## Tests

```bash
npm test
```

Model-free: typechecking and real kernels for state, working directory, synchronous and asynchronous interruption, overflow capture, reset cleanup, the startup hook, and the Herdr console. See [tests/README.md](tests/README.md).

## License

MIT

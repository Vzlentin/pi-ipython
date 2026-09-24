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
  runtime with ipykernel and jupyter-client in `extensions/.python`, so it needs
  network access.

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

## Security

The kernel is not sandboxed. Code runs with your user permissions and can access local files, environment variables, and the network. The separate Python runtime isolates dependencies, not system access.

## Security

The kernel is not sandboxed. Code runs with your user permissions and can access local files, environment variables, and the network. The separate Python runtime isolates dependencies, not system access.

## Tests

```bash
npm test
```

Model-free: typechecking, and real kernels for state, working directory, reset,
cleanup, the startup hook, and the Herdr console. See [tests/README.md](tests/README.md).

## License

MIT

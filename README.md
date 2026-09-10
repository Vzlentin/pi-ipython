# pi-ipython-rlm

A local Pi package providing one `ipython` tool with:

- a persistent, extension-owned Jupyter/IPython kernel;
- top-level `await` and native IPython behavior;
- focused depth-1 child calls through `rlm.spawn` and `rlm.gather`;
- terminating values through `rlm.final`.

## Local install

Requirements:

- macOS or Linux, with Bash and `lockf` (macOS) or `flock` (Linux).
- Node.js 22.18 or newer, npm, Git, and Pi 0.84.3.
- `uv` on `PATH`. The first tool call downloads an extension-owned Python 3.12 runtime and Jupyter dependencies, so it needs network access.
- `python3` on `PATH` to run the tests.

From the repository root:

```bash
npm install
npm test
pi install "$PWD"
```

`librlm/` is a `git subtree` of [alexzhang13/rlm](https://github.com/alexzhang13/rlm). Commit changes to it like any other directory. To pull upstream changes:

```bash
git subtree pull --prefix=librlm https://github.com/alexzhang13/rlm.git main --squash
```

`pi install` is needed once. Local packages are referenced by absolute path, not copied. After editing extension code, use `/reload` in Pi. Run `npm install` again only when dependencies change.

For an isolated development run without touching the installed package:

```bash
pi -ne -ns -nc -nbt -e ./extensions/rlm.ts
```

## Cells in Herdr

In interactive Pi inside Herdr, use `/cells` or `Ctrl+Shift+I` to toggle an IPython console on the right, attached to the same kernel. It first prints the recorded history (code, output, child progress, errors, and reset notices), then mirrors each new cell live as Pi runs it. Type at its prompt to inspect the kernel, for example `%whos`, `%history -o`, or a variable name. Cells run while the console is closed remain in the history. Your focus stays in Pi. Repeat `/cells` to close it.

The console is [Euporie Console](https://euporie.readthedocs.io/) 2.10.4, started through `uv tool run` in a separate cached environment. It provides syntax highlighting and rich live output. Previous cells are printed as plain text above Euporie, available through terminal scrollback, not loaded as notebook cells or rerun. Mouse capture is disabled so you can scroll back normally. Use `Ctrl+Enter` to run code at the prompt.

It does not install anything into the extension-owned Python runtime. Opening `/cells` starts the kernel if needed. After a kernel reset, repeat `/cells` to reconnect. Closing the console does not stop the kernel.

History is plain text, recorded from the first tool call after loading the extension. Its private temporary file is limited to 16 MiB. `/reload`, session changes, and exit close the console and delete its temporary files. The model's output limits are unchanged.

**The console is interactive, not read-only.** Code entered there changes the same kernel state as Pi. Do not run code there while Pi is working. RLM child progress and terminating values remain available in Pi and in the history.

## Security

The kernel is not sandboxed. Code runs with your user permissions and can access local files, environment variables, and the network. The separate Python runtime isolates dependencies, not system access.

## Tests

Fast, model-free checks:

```bash
npm test
```

## Paper benchmarks

Run the public OOLONG and LongBench-v2 CodeQA profiles from the Recursive Language Models paper:

```bash
npm run eval:oolong -- --model openai-codex/gpt-5.6-sol
npm run eval:longbench -- --model openai-codex/gpt-5.6-sol
```

OOLONG defaults to all 400 held-out test cases at 131K tokens. LongBench defaults to all 50 CodeQA cases. Both evals are opt-in and can consume substantial time and tokens. See [`benchmarks/README.md`](benchmarks/README.md) for the paper's 50-case `trec_coarse` profile, smaller runs, and result fields.

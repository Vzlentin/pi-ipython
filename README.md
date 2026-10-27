# pi-ipython

A persistent Python workspace for [Pi](https://github.com/earendil-works/pi).

The package adds one tool, `ipython`, that runs code in a Jupyter kernel. The kernel stays alive between calls, so the agent loads data once and keeps working on it. Variables, imports and functions are still there in the next cell.

```python
# cell 1
orders = hs.charge("orders.xlsx", sheet="2026")
hs.decris(orders)
```

```python
# cell 2, later in the conversation
monthly = orders.groupby("month")["amount"].sum()
monthly.plot()  # the model sees the chart
```

What you get:

- State that follows the conversation. Each cell is checkpointed, so `/tree`, `/fork`, resume, `/reload` and a crash bring back the variables of the current branch.
- Top-level `await` and IPython magics.
- Figures sent back to the model as images.
- `hs`, a small pandas toolkit to load, save, inspect and check data, ready in every kernel.
- `/cells` in Herdr: a live IPython console on the same kernel.
- A Python 3.12 environment of its own, separate from your project.

[pi-rlm](https://github.com/Vzlentin/pi-rlm) adds recursive model calls on top of this tool. Hosts built on pi-durable get the same tool, see [pi-durable hosts](#pi-durable-hosts).

## Install

You need:

- macOS or Linux
- Pi (tested with 1.4.0), Node.js 22.19 or later, and Git
- [uv](https://docs.astral.sh/uv/) 0.7.12 or later on your `PATH`

```bash
pi install https://github.com/Vzlentin/pi-ipython
```

The first `ipython` call creates the kernel's Python environment with uv, so it needs network access. After that, each session only checks the environment, offline.

The environment is in `core/.python` inside the package. uv installs the packages of `core/pyproject.toml` at the versions in `core/uv.lock`. Packages that you add yourself stay.

## The `ipython` tool

The tool takes one parameter, `code`: a Python or IPython cell. Each cell runs in the working directory of the session.

| When a cell | The tool |
| --- | --- |
| prints more than 2000 lines or 50 KiB | gives the model the tail, and saves the full output to a temporary file whose path is in the result |
| prints more than 1 MiB | interrupts the cell |
| shows more than 4 figures or 8 MiB of figures | drops the others, and tells the model how many |

Matplotlib always uses the inline backend, even when `MPLBACKEND` is set.

When you cancel a cell, the kernel gets SIGINT. If the cell stops within 3 seconds, the result gives its partial output and the kernel keeps its state. If not, the kernel and its child processes are killed, and the next cell starts on a new kernel with the last checkpoint.

The kernel stops within 5 seconds after Pi exits, also when Pi is killed. On a normal exit, pending checkpoints get up to 10 seconds to finish. A hard exit can lose the last one.

## `hs`, the data toolkit

Every kernel starts with `headstart` imported as `hs`. The tool description gives the agent the same list, and tells it to use Pi's `write`, `edit` and `bash` tools for files and commands, not Python.

| Function | What it does |
| --- | --- |
| `hs.charge(path, sheet=None)` | Loads csv, json, jsonl, toml, parquet, xlsx, xlsm, xls, xlsb or ods. Codes with leading zeros, such as `00042`, stay text. It skips bad jsonl lines and says how many, and lists the other sheets of a workbook. |
| `hs.sauve(path, data)` | Saves a DataFrame or records to csv, json, jsonl, parquet or xlsx, without the index. json also takes a plain value. A dict of frames gives one xlsx sheet per key, with a frozen header, a filter and fitted column widths. It refuses text: use Pi's `write` tool. |
| `hs.montre(x, n=40)` | Prints a short view of any value, head and tail, and returns it. As the last line of a cell, it shows the view once. |
| `hs.combien(df, key, *keys, n=20)` | Counts the `n` most common groups of the keys, with the count `n` and the `share` of all rows. Missing values count as a group. |
| `hs.compare(a, b, key)` | Lists the rows that differ between two frames, with `state` set to `only a`, `only b` or `changed`. |
| `hs.joins(a, b, key, how="left", validate=None)` | Merges two frames and prints the matched, only a and only b row counts. A left or inner join that would give more rows than `a` raises, unless you pass `validate=` as in pandas `merge`. |
| `hs.decris(df)` | Gives one row per column: type, share of missing values, distinct count, top 3 values, min and max. |
| `hs.verifie({"name": cond})` | Runs every check and prints each result. If any fail, it then raises one `AssertionError` that names them all. Each condition must be one bool, such as `(df.x > 0).all()`. |
| `hs.interroge(sql, cap=None)` | Runs a BigQuery query, always after a dry run. Without `cap`, it prints the statement type and the estimated bytes, and runs nothing. With `cap`, as bytes or text such as `"20 GB"`, it runs the query billed at most `cap`. |

Every function that takes a frame also takes records, a list of dicts.

`hs.interroge` needs `GOOGLE_APPLICATION_CREDENTIALS` and `CLOUDSDK_CORE_PROJECT`. Start Pi in a folder whose environment sets them.

Checkpoints skip `hs`, so do not use `hs` as a variable name. A value that you bind to `hs` is not saved, and a restore does not clear it.

## `/cells`: a console on the kernel

In interactive Pi inside Herdr, `/cells` or `Ctrl+Shift+I` opens an IPython console on the right, attached to the same kernel. Run it again to close it. Your focus stays in Pi.

The console first prints the cells run so far: code, output, progress, errors and reset notices. Then it shows each new cell live. You can type at its prompt, for example `%whos`, `%history -o` or a variable name. `Ctrl+Enter` runs the code.

Code that you run in the console changes the kernel that Pi uses. Do not run code there while Pi is working.

Good to know:

- The console is [Euporie Console](https://euporie.readthedocs.io/) 2.10.4. It runs with `uv tool run` in its own cached environment, and adds nothing to the kernel's environment.
- Earlier cells are plain text in the terminal scrollback. They are not notebook cells and do not run again. Mouse capture is off, so you can scroll normally.
- History starts at the first tool call after the extension loads, and stops at 16 MiB.
- Opening the console starts the kernel if needed. Closing it does not stop the kernel. After a kernel reset, run `/cells` again to reconnect.
- `/reload`, a session change and exit close the console and delete its temporary files.

## Checkpoints

After each cell, the extension saves the variables of the kernel in the background. Before the next cell, it restores the latest checkpoint of the current conversation branch, if the kernel does not already have it. The result after a restore names the cell it came from, the names it restored and the values it skipped.

Cells that other tools run, such as `codemode` scripts, are checkpointed too. Their checkpoint goes into an `ipython-checkpoint` entry of the session, because Pi does not save their results.

What a checkpoint keeps:

- Public variables, saved with cloudpickle.
- Functions and classes defined in cells, saved by value. A restored function uses the globals of the current kernel.
- Imported modules, imported again.

What it does not keep:

- Names that start with `_`, IPython internals, `hs` and other names that extensions add at startup.
- Live objects: open files, sockets, generators, coroutines and tasks.
- A value bigger than 64 MiB, or a cell with more than 256 MiB of saved data.
- Anything outside the namespace: files on disk, `sys.path`, `os.environ`, the working directory, monkeypatches, module globals and threads.

Each name is saved on its own, so two names for one object come back as two objects. Code that you run in `/cells` joins the checkpoint of the next Pi cell.

When something goes wrong:

- A failed save does not change the live kernel. The next result reports it.
- When the newest checkpoint of a branch is gone, the next older one is used. A branch with no cells goes back to the startup state of the kernel.
- A cancelled restore runs again with the next cell. A restore that fails or times out does not, and the cell runs on what the restore left.
- When a value kills the kernel during a restore, that value is deleted from the store, and the restore runs again on a new kernel, up to 3 times.

Checkpoints are in `${XDG_CACHE_HOME:-~/.cache}/pi-ipython/checkpoints/`, and each value is stored once. Checkpoints unused for 30 days are deleted. Above 2 GiB, the least recently used ones are deleted first. One lock covers every session, so a slow `__setstate__` during a restore can block other sessions for up to 13 seconds.

To turn checkpoints off, set an environment variable:

```bash
export PI_IPYTHON_PERSISTENCE=0
```

Or add `.pi/pi-ipython.json` to the working directory, or to a parent folder up to the Git root:

```json
{ "persistence": false }
```

This turns off all checkpoint saves and restores. It does not delete the cache.

Pickles can run code when they load, and can hold sensitive data. The store folders are `0700` and the files `0600`. The store refuses symlinks, paths that you do not own or that are not private, and malformed checkpoint IDs. Do not put files from others in the cache, and do not share it with another user.

## Security

The kernel is not sandboxed. Code runs with your user permissions and can read your files, your environment variables and the network. The separate Python environment isolates packages, not access.

## Build on it

### Codemode scripts

In a `codemode` script, `await tools.ipython({ code })` gives an object:

```ts
{
	status: "ok" | "error"; // "error" when the cell raised or was interrupted
	output: string; // the output tail, without ANSI codes
	executionCount?: number;
	error?: { ename: string; evalue: string };
	truncated: boolean;
	fullOutputPath?: string;
	notices: string[]; // kernel resets and checkpoint restores before the cell ran
}
```

A Python exception or an interrupt gives `status: "error"`, so the script can check it and go on with the same kernel. The call rejects only when the kernel is lost. The `notices` are also added to the result of the script, so the model sees them even when the script does not return them.

A cell gets its code as a string. To pass data in, embed it as a JSON string:

```js
await tools.ipython({ code: `import json\ndata = json.loads(${JSON.stringify(JSON.stringify(data))})` });
```

### Kernel startup hook

Before each kernel start, restarts included, the extension emits `ipython:kernel-starting` on `pi.events`. Listeners can change the payload:

```ts
interface KernelStartingEvent {
	env: Record<string, string>; // added to the environment of the bridge and the kernel, not of Pi
	startupCode: string[]; // runs hidden once the kernel is ready
	waitFor(promise: Promise<unknown>): void; // the kernel starts after the promise settles
}
```

- Change the payload before your first `await`. To fill a value later, pass a promise to `waitFor`.
- If a startup snippet fails, the kernel start fails.
- Names that startup code defines are not checkpointed.

pi-rlm uses this hook to set up `rlm` in the kernel.

### pi-durable hosts

Hosts that run agents on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable), such as [workflows](https://github.com/Vzlentin/workflows), get the same tool from `durable/index.ts`. The package declares it in a field that Pi does not read:

```json
"piDurable": { "extensions": ["./durable/index.ts"] }
```

The host passes in its own pi-durable and pi-ai modules and its event bus, so the package loads no second copy of either:

```ts
import * as ai from "@earendil-works/pi-ai";
import * as durable from "@earendil-works/pi-durable";
import ipython from "pi-ipython/durable/index.ts";

const tool = ipython({ durable, ai, events });
for (const extension of tool.extensions) registry.install(extension);

// When the host stops: wait for pending checkpoints, then stop every kernel.
await tool.close();
```

Differences from Pi:

- Each conversation gets its own kernel, in the working directory of the conversation.
- Checkpoint IDs are `pi-ipython.checkpoint` entries of the conversation. A fork, or a store that opens again after a crash, restores the latest checkpoint of its own history.
- Kernel resets, restore notes and the truncation line are diagnostics, which the host shows after the output.
- A tool that runs a cell through `api.executeTool` gets the result object of [Codemode scripts](#codemode-scripts) as `structuredOutput`.
- `ipython:kernel-starting` also has `conversationId`. Each cell also emits `ipython:cell-start` with `{ conversationId, api, context }` before it runs, and `ipython:cell-end` with `{ conversationId }` after it ends, also when it fails. While the cell runs, a listener can use `api.commit(..., context)`, for example to create a conversation owned by `api.taskId`.
- There is no `/cells` console.

## Development

```bash
npm install
npm test                             # lint, typecheck, then real kernels with no model
pi -ne -e ./extensions/ipython.ts    # a Pi session with only this extension
```

[tests/README.md](tests/README.md) lists what each test covers. [AGENTS.md](AGENTS.md) has the rules for changes.

## License

MIT

# Verification

`npm test` is model-free. It runs typechecking and real kernels.

- `test_output.mjs` checks that the copied output truncation in `extensions/output.ts` cuts output exactly like Pi's `truncateTail`: final newlines, line and byte limits, lines that fill the byte limit exactly, and cuts inside multi-byte characters.
- `test_kernel.mjs` covers cross-cell state, per-cell working directories, expression evaluation, synchronous and asynchronous interruption, evaluate timeouts, SIGINT-resistant fallback kills, one-shot reset reporting, output overflow, process-group cleanup, and the `ipython:kernel-starting` contract, including runtime startup code that runs after the listener's.
- `test_cells.mjs` covers the Herdr console lifecycle and extension wiring.
- `test_persistence.mjs` covers owner SIGKILL during startup, a quiet cell, a blocked checkpoint save, stalled bridge cleanup, and a stalled launch before Jupyter records the child, normal shutdown flushing a delayed save, namespace round trips, live function globals, classes, module aliases, deletion, content deduplication, LRU garbage collection with shared blobs, strict checkpoint IDs, symlink refusal, ownership modes, linked cache bases, both opt-outs, and a clear error for a malformed `.pi/pi-ipython.json`.
- `test_branches.mjs` drives the extension through Pi's real `SessionManager`: edited prompts, branches before any cell, later leaves, copied `/fork` history, evicted-checkpoint fallback, retry after a cancelled restore, crash recovery, failed saves, no-op synchronization on the current branch, and cells that a codemode script runs as nested tool calls: structured results, Python exceptions as data, cancellation and crash recovery inside a script, and reset notices in the script's result.
- `test_durable.mjs` drives the pi-durable tool through a real Harness on SQLite with a faux model: state across cells, Python exceptions as error results, a kernel crash and the restore after it, a reopened store that restores from the conversation's entries, a fork that restores the state at its fork entry, and long output that keeps its tail and names the file with all of it.
- `test_checkpoint_limits.mjs` covers protocol-5 buffers, nested and rebound functions, live-resource refusal, 64 MiB value and 256 MiB cell limits, content-addressed disk use, recovery after a hung restore, deletion of an unpickler that ignores interrupts after it kills the kernel, and three such values exhausting the restore attempts while the next cell is still checkpointed.

A missing extension-owned interpreter is provisioned through `uv` by the first kernel test. `npm run test:persistence` runs the three persistence-focused files.

Do not add tests that match source strings, pin method names, import spellings, or merely restate compiler success. Test public boundaries with independent inputs and observable failure recovery.

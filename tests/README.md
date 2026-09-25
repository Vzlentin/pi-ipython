# Verification

`npm test` is model-free. It runs typechecking and real kernels.

- `test_kernel.mjs` covers cross-cell state, per-cell working directories, expression evaluation, synchronous and asynchronous interruption, evaluate timeouts, SIGINT-resistant fallback kills, one-shot reset reporting, output overflow, process-group cleanup, and the `ipython:kernel-starting` contract, including runtime startup code that runs after the listener's.
- `test_cells.mjs` covers the Herdr console lifecycle and extension wiring.
- `test_persistence.mjs` covers namespace round trips, live function globals, classes, module aliases, deletion, content deduplication, LRU garbage collection with shared blobs, strict checkpoint IDs, symlink refusal, ownership modes, linked cache bases, both opt-outs, and a clear error for a malformed `.pi/pi-ipython.json`.
- `test_branches.mjs` drives the extension through Pi's real `SessionManager`: edited prompts, branches before any cell, later leaves, copied `/fork` history, evicted-checkpoint fallback, retry after a cancelled restore, crash recovery, failed saves, and no-op synchronization on the current branch.
- `test_checkpoint_limits.mjs` covers protocol-5 buffers, nested and rebound functions, live-resource refusal, 64 MiB value and 256 MiB cell limits, content-addressed disk use, recovery after a hung restore, deletion of an unpickler that ignores interrupts after it kills the kernel, and three such values exhausting the restore attempts while the next cell is still checkpointed.

A missing extension-owned interpreter is provisioned through `uv` by the first kernel test. `npm run test:persistence` runs the three persistence-focused files.

Do not add tests that match source strings, pin method names, import spellings, or merely restate compiler success. Test public boundaries with independent inputs and observable failure recovery.

# Verification

`npm test` is model-free. It runs typechecking and real kernels: cross-cell
state, per-cell working directory, errors, synchronous/async interruption,
SIGINT-resistant fallback kills, overflow capture, and process-group cleanup.
It also covers the `ipython:kernel-starting` hook (environment and startup code
after every start, startup failure) and the Herdr console. A missing
extension-owned interpreter is provisioned through `uv` on the first kernel test.

Do not add tests that match source strings, pin method names, or merely restate
implementation constants. Test public boundaries with independent inputs and
observable results.

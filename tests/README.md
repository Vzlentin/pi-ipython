# Verification

`npm test` is model-free. It runs typechecking, host cancellation tests, custom-provider dispatch, relocated librlm discovery, benchmark data-isolation tests, and real kernel tests for working-directory changes, cross-cell state, cancellation/reset, and cleanup. A missing extension-owned interpreter is provisioned through `uv` on the first kernel test.

Do not add tests that match source strings, pin method names, or merely restate implementation constants. Test public boundaries with independent inputs and observable results. Keep provider mocks at the provider boundary; do not mock the behavior under test.

Model-backed acceptance (explicitly opt-in):

```sh
PI_RLM_TEST_MODEL=openai-codex/gpt-5.6-sol npm run test:integration
```

This runs real Pi CLI/RPC sessions, child completions, usage attribution, concurrent gather, retained handles, release, cancellation, recovery and process/socket cleanup. The large-context case is excluded; `test:integration:full` enables it and consumes substantial model input.

Optional settings:

- `PI_RLM_TEST_THINKING`: defaults to `low`.
- `PI_RLM_TEST_TIMEOUT`: per-run seconds, defaults to `300`.
- `PI_RLM_TEST_AGENT_DIR`: credentials and provider settings directory.
- `PI_RLM_TEST_PROVIDER_EXTENSION`: explicit custom-provider extension; all other extension discovery is disabled.

`RLM_LIBRLM_ROOT` selects the standalone librlm checkout for both development and installed-package tests. By default it is `~/Dev/librlm`, never relative to this repository. Run librlm and Hermes adapter tests from their own runtimes in that checkout.

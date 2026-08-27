# pi-ipython-rlm

A local Pi package providing one `ipython` tool with:

- a persistent, extension-owned Jupyter/IPython kernel;
- top-level `await` and native IPython behavior;
- focused depth-1 child calls through `rlm.spawn` and `rlm.gather`;
- terminating values through `rlm.final`.

## Local install

```bash
npm install
npm test
pi install "$PWD"
```

`pi install` is needed once. Local packages are referenced by absolute path, not copied. After editing extension code, use `/reload` in Pi. Run `npm install` again only when dependencies change.

For an isolated development run without touching the installed package:

```bash
pi -ne -ns -nc -nbt -e ./extensions/rlm.ts
```

## Tests

Fast, model-free checks:

```bash
npm test
```

Model-backed Slice 2 acceptance checks are opt-in:

```bash
PI_RLM_TEST_MODEL=openai-codex/gpt-5.6-sol npm run test:integration
```

The large-context case is excluded by default because it sends a substantial context to child models:

```bash
PI_RLM_TEST_MODEL=openai-codex/gpt-5.6-sol npm run test:integration:full
```

Optional environment variables:

- `PI_RLM_TEST_THINKING` — defaults to `low`.
- `PI_RLM_TEST_TIMEOUT` — per-run seconds, defaults to `300`.
- `PI_RLM_TEST_AGENT_DIR` — Pi agent directory used for credentials and provider settings.

# Contributing

## Getting set up

```bash
corepack enable && corepack prepare pnpm@10.28.0 --activate
pnpm install
pnpm dev
```

Node 22 (see `.nvmrc`), pnpm 10.28.0. `pnpm run doctor` tells you what your machine is
missing.

## Before you open a pull request

```bash
pnpm typecheck        # both programs: node-side and renderer
pnpm boundary-check   # dependency direction
pnpm test             # unit + contract + integration + offline + failure
pnpm provider:test --all
pnpm license-audit
pnpm todo-report
```

All of these run in CI and fail closed. A check is never downgraded to a warning to get
a merge through.

## House rules

- **New code is strict TypeScript.** `exactOptionalPropertyTypes` is on: spread optional
  properties conditionally rather than assigning `undefined`. No unexplained `any`.
- **Respect the boundaries.** Providers never render or import UI/Electron/raw network.
  Renderers never fetch providers. The UI consumes the typed IPC client only. Packages
  import each other as `@worldview/<name>`, never by relative path.
- **Frozen contracts need an ADR.** `world-model`, `provider-sdk`,
  `render-core/contract.ts`, `ipc-contract`, `runtime/contract.ts` and `identity` are
  tagged `architecture-contract-v1`. Changing them means a new or amended ADR in
  `docs/adr/` and a review from the code owners.
- **A provider is not done without evidence.** Its checklist report
  (`artifacts/verification/providers/<id>.json`) is the completion criterion, and its
  data policy must match `config/licenses/providers.json` exactly — the audit enforces it.
- **No placeholders.** A visible control either works or is explicitly marked
  experimental. `pnpm todo-report` must stay at zero markers in the production trees.
- **No fake data.** Mock data belongs in tests, fixtures and demo mode. Demo mode is
  labelled RECORDED DATA. Live mode shows "unavailable" rather than something invented.
- **Redact by default.** Nothing that could be a credential goes into a log, an error
  message or a diagnostics bundle.

## Adding a data source

Read [docs/providers/BUILDING-A-PROVIDER.md](docs/providers/BUILDING-A-PROVIDER.md).
Short version: manifest → data policy (plus a record in `config/licenses/providers.json`
with the real terms) → normalizer → fixtures → contract plan → `pnpm provider:test <dir>`
→ register. If the source's terms are unclear, the provider ships off by default with
`commercialReview: "manual-review-required"` — uncertainty is recorded, never hidden
behind an attribution line.

## Commits and branches

`feature/*` and `fix/*` branch from `develop`; `develop` is the integration branch;
`main` is released. Conventional-commit style subjects (`feat(scope): …`). The PR
template asks about architecture, licensing, security, tests and rollback — answer it
honestly; "none" is a fine answer when it is true.

## Reporting bugs and vulnerabilities

Bugs: the issue templates. Vulnerabilities: privately, per [SECURITY.md](SECURITY.md).

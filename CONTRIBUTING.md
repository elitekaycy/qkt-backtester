# Contributing

Thanks for helping. This project is a browser workspace around the [qkt](https://github.com/elitekaycy/qkt) CLI. Rule one: **it never modifies qkt**; it only uses qkt's CLI, `qkt lsp` and the files qkt writes.

## Setup

```bash
pnpm install
pnpm -r build && pnpm -r test
QKT_BIN=qkt WORKSPACE=./workspace QKT_DATA_HOME=~/.qkt/data pnpm --filter @qkt-studio/server dev
pnpm --filter @qkt-studio/web dev      # http://localhost:5173
```

Node 22.5 or newer. Tests that need a real `qkt` binary and a data store (`~/.qkt/data`) skip themselves when those are missing, so the suite runs anywhere; run it with both present before touching the runner, the data scanner or anything that shells out to qkt.

## Where things live

- `packages/core`: pure, browser-safe logic (bars decoder, trade pairing, analytics, filters, run identity). Tested against real qkt output in `test/fixtures`.
- `packages/server`: Fastify app: the run pipeline, data scanner, per-symbol sources, workspace files, terminal, LSP bridge.
- `packages/web`: React UI. Design tokens are in `src/theme.css`; state is in `src/state`.
- `docs/specs/`: the design, the probe evidence for every qkt behaviour we rely on, and the edge-case register. Read the "Facts about qkt" list in `AGENTS.md` before simplifying anything: each item was probed.

## Pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(web): ...`, `fix(server): ...`, `docs: ...`, `test(core): ...`, `refactor`, `chore`, `perf`, `ci`. Scope is the package or area. Imperative, lower case, no trailing period.
- One logical change per commit. Add or update tests with the change; a bug fix starts with a failing test.
- Keep comments sparse and about **why**. TypeScript is strict and ESM; windows are `[from, to)` and times are UTC.
- Anything user-supplied that becomes a path goes through `resolveInJail`.
- UI changes: check light and dark, keyboard access, and include a screenshot in the PR.

## Reporting bugs

Include the qkt version (`qkt --version`), whether the run was on bars or ticks, the strategy (or a reduced one), and the failing step in the Pipeline tab.

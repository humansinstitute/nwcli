# Repository Guidelines

## Project Structure & Module Organization
- Root entrypoints: `index.ts` (CLI) and `api.ts` (HTTP API).
- Utilities: `utils/` (e.g., `io.ts`, `nostr.ts`, `lnurl.ts`, `async.ts`).
- Examples and docs: `examples/`, `docs/` (developer notes, sample code, assets).
- Config: `tsconfig.json`, `bunfig.toml`, `package.json`, `bun.lock`.
- Local state: `nwc.json` (ignored) and `.env` (ignored). Do not commit secrets.

## Build, Test, and Development Commands
- Install deps: `bun install` — installs project dependencies.
- Run CLI: `bun start` — executes `index.ts`.
- Dev mode: `bun dev` — hot-reloads `index.ts`.
- Run API: `bun run api` — starts the HTTP API from `api.ts`.
- Type check: `bun run typecheck` — `tsc --noEmit` with strict settings.

## Coding Style & Naming Conventions
- Language: TypeScript (ESNext modules), `strict` enabled.
- Indentation: 2 spaces; keep lines under ~100 chars where reasonable.
- Naming: files lowercase; use hyphens for multiword modules (e.g., `wallet-service.tsx`).
- Functions: prefer explicit return types for exported APIs; use async/await over Promise chains.
- Imports: use relative paths within repo; keep import groups ordered: std/libs → external → internal.

## Testing Guidelines
- Framework: none configured yet. Add lightweight tests as needed.
- Location: `tests/` or colocated `*.spec.ts` next to the module.
- Conventions: name tests after modules (e.g., `lnurl.spec.ts`); keep tests deterministic and unit-focused.
- Run: for now, rely on `bun test` if added, and `bun run typecheck` for type-safety.

## Commit & Pull Request Guidelines
- Commits: concise, imperative mood (e.g., "add", "fix", "refactor"); group related changes; reference issues (`#123`) when relevant.
- PRs: include clear description, rationale, and testing notes; add screenshots or CLI output when UI/UX or API behavior changes; link related issues.
- CI expectations: PRs must type-check and run locally without errors (`bun start` / `bun run api`).

## Security & Configuration Tips
- Secrets: keep NWC URIs and tokens out of VCS. `.env` supports `AUTH_API` for the API; `nwc.json` stores local wallet entries. Both are git-ignored.
- API auth: when `AUTH_API` is set, pass a `Bearer` token or `?auth=...` query to protected endpoints.

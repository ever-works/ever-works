# `@ever-works/web-e2e` — Playwright acceptance suite

End-to-end tests for `apps/web`. Bootstrapped in **EW-641 Phase 1B/d row
19a** as the harness for the KB acceptance suite (A12-A17, rows 19-24
of the KB Phase 1B/d handoff).

## Layout

```
apps/web-e2e/
├── package.json          # @ever-works/web-e2e (private)
├── playwright.config.ts  # chromium-only, env-driven baseURL
├── tsconfig.json
└── tests/
    └── smoke.spec.ts     # harness sanity check (no app required)
```

## Running locally

```bash
# 1. From the repo root, install workspaces (Playwright lands as a dev dep)
pnpm install

# 2. One-time: download the Chromium binary (~200 MB, cached under
#    ~/.cache/ms-playwright). Not run by `pnpm install` because the
#    binary is large and most contributors don't need it.
pnpm --filter @ever-works/web-e2e exec playwright install chromium

# 3. Start the platform (separate terminal):
pnpm dev              # web on :3000 + api on :3100

# 4. Run tests:
pnpm --filter @ever-works/web-e2e test
# or:
cd apps/web-e2e && pnpm test
```

### Pointing at a different deployment

```bash
PLAYWRIGHT_BASE_URL=https://kb-preview.vercel.app pnpm --filter @ever-works/web-e2e test
```

### UI mode for debugging

```bash
pnpm --filter @ever-works/web-e2e exec playwright test --ui
```

### Viewing the last HTML report

```bash
pnpm --filter @ever-works/web-e2e test:report
```

## Writing tests

- One spec per acceptance row (A12 → `kb-upload.spec.ts`, A13 → `kb-autosave.spec.ts`, etc).
- Use the stable `data-testid` selectors locked by the implementation
  PRs (search the codebase for `data-testid="kb-…"` for the canonical
  list). Avoid hard-coding visible text — translations would break it.
- Auth fixtures and shared setup live in `tests/_fixtures/`. Add as
  needed; don't repeat login flows per test.

## CI

This package is **not yet wired into `.github/workflows/ci.yml`**. The
acceptance suite runs in its own opt-in workflow once row 19b lands
(spins up Postgres + the API + the web server, runs `playwright test`,
uploads the report as an artifact). Until then, run locally before
shipping KB UI changes that affect user-visible flows.

## Versioning

`@playwright/test` is pinned in `package.json`. Bumping it requires a
sweep of `tests/` because the assertion + locator APIs have changed
between recent majors.

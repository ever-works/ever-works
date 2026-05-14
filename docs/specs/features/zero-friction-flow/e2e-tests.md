# EW-617 — Zero-friction flow E2E tests

> Parent epic: **EW-617**. Tracks the cross-cutting Playwright suite
> that exercises the full prompt → deployed Work happy path once all
> sub-task PRs land.

## Goal

Provide one end-to-end test file that proves the EW-617 acceptance
criteria from a fresh-incognito browser:

```
ever.works/  → type prompt → Generate
  ↓ URL fragment hand-off
app.ever.works/onboarding#prompt=…
  ↓ wizard reads hash, mints anon user, jumps to Generate-now
POST /api/works/quick-create  →  202 + work.id + generation.historyId
  ↓ poll
GET /api/works/:id/generation-history  →  status transitions
  ↓
GET https://<slug>.ever.works/  →  200 (after CNAME + cluster ready)
```

## Status

The suite at `apps/web/e2e/zero-friction-flow.spec.ts` is **gated as
`.skip` in three describes** until the upstream PRs all merge:

| PR                    | Gap                              | Status |
| --------------------- | -------------------------------- | ------ |
| #752                  | G6 default deploy provider       | open   |
| #756                  | G2 anonymous auth                | open   |
| #757                  | G3 claim-account (stacked on G2) | open   |
| #758                  | G4 quick-create + wizard         | open   |
| #759                  | G5 Cloudflare DNS                | open   |
| #760                  | G8 telemetry + runbook           | open   |
| #761                  | G7 captcha verifier              | open   |
| ever-works-website#37 | G1 landing prompt                | open   |

Once each lands, flip the `.skip` on the matching `test.describe` to
activate it in CI. Each spec uses Playwright's route mocking where
needed so the wizard contract is exercised even when the deploy
pipeline isn't live in the CI environment.

## Test sections

1. **UI surface** — landing page renders, submit gating, fragment URL
   hand-off, wizard hydration.
2. **API contract** — `POST /api/auth/anonymous` returns the right
   shape, throttling kicks in at 5/hour, `POST /api/works/quick-create`
   returns 202 with the right body shape, `POST /api/auth/claim`
   flips an anon user and rejects duplicate-email collisions with 409.
3. **Full UI journey** — landing → app → Generate-now → wizard
   closes. Uses route mocking for the quick-create endpoint so the
   test runs even when the actual AI pipeline isn't connected.

## Environment

| Var                      | Default                 | Purpose                           |
| ------------------------ | ----------------------- | --------------------------------- |
| `PLAYWRIGHT_APP_URL`     | `http://localhost:3000` | The app under test (Next.js dev). |
| `PLAYWRIGHT_WEBSITE_URL` | `http://localhost:4000` | The website (landing page).       |

Production smoke runs hit `https://app.ever.works` /
`https://ever.works` — set the envs in the workflow secrets.

## Out of scope

- The actual cluster deploy verification (cert-manager wildcard,
  Cloudflare propagation) — those run as a separate ops smoke spec
  outside this E2E suite, on a real cluster + DNS zone.
- Visual regression of the wizard step — covered separately by
  Playwright's screenshot snapshots in the existing
  `dashboard-comprehensive.spec.ts`.

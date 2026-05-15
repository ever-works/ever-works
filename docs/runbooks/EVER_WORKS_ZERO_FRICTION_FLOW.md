# Zero-friction flow runbook (EW-617)

> Companion to the EW-617 spec series. Lives in the platform repo so
> it ships with the code; mirrored to
> `Workspace/knowledge/runbooks/EVER_WORKS_ZERO_FRICTION_FLOW.md` on
> the next Workspace sync.

## What's wired up

| Gap | What it does                                      | PR / status                   |
| --- | ------------------------------------------------- | ----------------------------- |
| G1  | Landing prompt + URL hand-off                     | ever-works-website#37         |
| G2  | Anonymous (TTL) users + cleanup task              | platform #756                 |
| G3  | Claim-account flow                                | platform #757 (stacked on G2) |
| G4  | Wizard "Generate now" + `/api/works/quick-create` | platform #758                 |
| G5  | `*.ever.works` subdomain + Cloudflare DNS         | platform #759                 |
| G6  | Default `deployProvider = 'ever-works'`           | platform #752                 |
| G7  | Captcha + global caps                             | tracked, follow-up            |
| G8  | Funnel telemetry + this runbook                   | platform (this PR)            |

## End-to-end demo

```
1. Open https://ever.works/ in a fresh-incognito window.
2. Type a directory description into the hero textarea.
3. Click Generate.
   → Browser redirects to https://app.ever.works/onboarding#prompt=…
4. Wizard mounts:
   - Reads the prompt out of the URL fragment.
   - Mints a temporary user via POST /api/auth/anonymous (G2).
   - Jumps to the final "Generate now" step.
5. Click Generate now.
   → POST /api/works/quick-create (G4) creates the Work and starts
     generation. Response: { work, generation.historyId }.
6. Background: the agent pushes 3 repos to ever-works-cloud (EW-614),
   the deploy workflow runs (G5), Cloudflare CNAME is provisioned, and
   the site comes up at https://<slug>.ever.works/.
7. Optional: post-deploy banner offers Claim Account
   (POST /api/auth/claim, G3).
```

## Debugging by stage

Each stage emits a `[zero-friction]` JSON log line via
`ZeroFrictionFunnelService.emit` (G8). All eight events share a
`correlationId` so a single `correlationId=…` filter follows one user
across services. Until the emit call sites land in their respective
PRs, fall back to the per-component logs below.

### Stage 1 — landing prompt (G1)

- Browser console: form submit posts no XHR; it just sets
  `window.location.href`. Open Network → Doc to see the redirect.
- If the form doesn't appear: confirm the website build deployed
  `LandingPromptForm` — check the rendered HTML in DevTools for
  `data-testid="landing-prompt-form"`.

### Stage 2 — anon user (G2)

- `POST /api/auth/anonymous` should return 201 with `{ access_token,
user.isAnonymous: true }`.
- 429 → the per-IP throttle (5/hour) tripped. Log in or wait.
- 500 → check `AnonymousAuthService` logs; common cause is the
  `users` table not yet having `is_anonymous` / `anonymous_expires_at`
  columns. Run the G2 migration step or set
  `database.autoMigrate=true` in dev.

### Stage 3 — wizard finished (G4)

- The wizard reads the URL fragment on mount via the
  `EverWorksOnboardingWizard` effect. If the prompt doesn't pre-fill,
  the most likely cause is a hash-fragment URL encoding issue — open
  DevTools and inspect `window.location.hash` before any redirect.

### Stage 4 — work created (G4)

- `POST /api/works/quick-create` returns 202 with `{ status:
'pending', work, generation }`. The work id from the response is
  what to use for downstream polling.
- 400 → slug regex failed. The wizard derives slug from the prompt;
  if it produced an invalid slug log a bug.

### Stage 5 — repos pushed (EW-614)

- Search `WorkLifecycleService` logs for
  `EverWorksGitProvider.createRepository` lines. Three repos should be
  created in `ever-works-cloud`.

### Stage 6 — deploy started (G5)

- `DeployService.deploy` logs the workflow dispatch. The
  `K8S_INGRESS_HOST` Action variable should be set to
  `${slug}.ever.works`.
- Cloudflare CNAME provisioning: search
  `CloudflareDns CNAME created/updated` in
  `EverWorksDnsService` logs.

### Stage 7 — deploy ready

- `DeploymentVerifierService` polls the cluster for `Ready`. The site
  should respond on `https://<slug>.ever.works/` within ~2 min after
  the workflow finishes.

### Stage 8 — claim account (G3)

- Authenticated `POST /api/auth/claim` with `{ email, password }`.
  409 → email already taken by a different user.
  403 → the caller's session is already non-anonymous.

## Rolling back per gap

| Gap | Roll-back                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1  | Revert ever-works-website#37 and redeploy the website. The platform side keeps working — wizard hash-hydration is a no-op when no `prompt` is in the URL.    |
| G2  | Revert platform #756. Existing anonymous rows orphan in the DB; safe to leave (the nightly cleanup task still runs once the schema columns exist).           |
| G3  | Revert platform #757. Anonymous users stay anonymous; they can sign up normally via `/register`.                                                             |
| G4  | Revert platform #758. The wizard falls back to the legacy `/works/new` hand-off automatically (the "Generate now" button only renders when `prompt` is set). |
| G5  | Unset `CLOUDFLARE_API_TOKEN` (or rotate it). `EverWorksDnsService.getProvider()` returns null and the deploy pipeline reverts to the LB hostname fallback.   |
| G6  | Revert platform #752. New rows go back to defaulting `deployProvider='vercel'`; existing rows are untouched.                                                 |
| G7  | (Not yet wired.)                                                                                                                                             |
| G8  | Revert this PR. `[zero-friction]` log lines disappear; nothing else breaks.                                                                                  |

## Configuration cheat-sheet

| Env var                         | Owned by | Notes                                                                     |
| ------------------------------- | -------- | ------------------------------------------------------------------------- |
| `ANONYMOUS_USER_TTL_DAYS`       | G2       | Default 7. Garbage values fall back to 7.                                 |
| `CLOUDFLARE_API_TOKEN`          | G5       | Scoped: DNS:Edit on the `ever.works` zone only. Never the global key.     |
| `CLOUDFLARE_ZONE_ID`            | G5       | 32-char hex.                                                              |
| `EVER_WORKS_DEPLOY_LB_HOSTNAME` | G5       | Cluster ingress LB DNS name. Required for DNS automation.                 |
| `EVER_WORKS_DOMAIN`             | G5       | Defaults to `ever.works`.                                                 |
| `DEPLOY_EVER_WORKS_ENABLED`     | EW-608   | Gates the `ever-works` deploy provider end-to-end.                        |
| `NEXT_PUBLIC_APP_URL`           | G1       | Where the landing page sends users. Defaults to `https://app.ever.works`. |

## Dashboards

- PostHog board for the funnel: TBD (G8 wires emit calls; dashboard
  follow-up).
- Cloudflare → `ever.works` zone → DNS records: shows the CNAME pool.
- k8s-works → ingress → `*.ever.works` cert: verify cert-manager is
  serving the wildcard.

## Known sharp edges

- The 6-char random suffix on quick-create slugs is meant to dodge
  collisions across users typing the same prompt — but two users
  hitting the same suffix is still ~one-in-a-million per attempt. The
  Cloudflare PUT path handles that gracefully (idempotent update) but
  the platform write hits a unique-constraint error first; ops will
  see a 409 from `POST /api/works/quick-create`. Resolve by retrying;
  long-term fix is a stronger suffix or a server-side UUID slug.
- Anonymous users created during a DB outage that prevented the
  `users.is_anonymous` column from being created may end up with
  null email but `isAnonymous=false` (the default). Detection query:
  `SELECT id FROM users WHERE email IS NULL AND is_anonymous = false`.
  Repair: set `is_anonymous=true` and seed an `anonymous_expires_at`
  in the past so the nightly cleanup picks them up.

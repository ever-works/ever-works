# EW-617 G7 — Captcha + global caps

> Sub-task: **EW-624**. Parent epic: **EW-617**.

## Goal

Add a second layer of abuse protection on top of the per-IP throttles
already in place on `POST /api/auth/anonymous` (G2) and
`POST /api/works/quick-create` (G4). Two complementary mechanisms:

1. **Captcha** (Cloudflare Turnstile or compatible) gates submissions
   from the landing page when the platform is under attack or simply
   when the operator wants belt-and-suspenders coverage.
2. **Global caps** (hourly + daily, env-configurable) put a hard
   ceiling on anon-user creates + quick-create deploys regardless of
   distribution across IPs.

## Functional requirements

- **FR-G7-1** A new `CaptchaVerifierService` POSTs to a provider
  `/siteverify` endpoint with the server secret + the user-supplied
  token + the remote IP, and returns a normalized `VerifyResult`. The
  service is provider-agnostic — Turnstile, hCaptcha, and reCAPTCHA v3
  all use compatible shapes and we don't read the score (the boolean
  `success` is enough for our threat model).
- **FR-G7-2** When `CAPTCHA_PROVIDER` is unset (default in dev /
  preview), the service short-circuits with `success: true, skipped:
true` — no HTTP call. The existing per-IP throttles remain the only
  defense, which is intentional for development ergonomics.
- **FR-G7-3** When the verifier provider returns an outage (network
  error / 5xx), the service falls open with `success: true, skipped:
true, errorCodes: ['verifier-exception']`. **A flaky captcha MUST
  NOT block legitimate traffic.** Ops can spot the elevated rate via
  the `skipped: true` log warns.
- **FR-G7-4** Empty / missing token returns `success: false,
errorCodes: ['missing-input-response']` without making the network
  call.
- **FR-G7-5** Call sites that need captcha verification (currently
  scoped to the two zero-friction entry points) MUST:
    1. Read the user-supplied token from a documented header
       (`x-captcha-token`) or body field (`captchaToken`).
    2. Call `captchaVerifier.verify({ token, remoteIp })`.
    3. On `success: false`, return 401 with a JSON body that names the
       `errorCodes` so the client can re-render the widget.

## Non-functional requirements

- **NFR-G7-1** No SDK dependency — uses the global `fetch` (Node 22+).
- **NFR-G7-2** Env reads happen exactly once per process; the cache is
  resettable via `resetCacheForTest()` for unit tests.
- **NFR-G7-3** Verifier URL is overridable via `CAPTCHA_VERIFY_URL` so
  staging / preview can mirror the provider on a local proxy when
  needed.

## Configuration

| Env var              | Required           | Description                                                       |
| -------------------- | ------------------ | ----------------------------------------------------------------- |
| `CAPTCHA_PROVIDER`   | yes for production | One of `turnstile`, `hcaptcha`, `recaptcha`. Unset = disabled.    |
| `CAPTCHA_SECRET`     | yes for production | Provider-side secret token (server-only).                         |
| `CAPTCHA_VERIFY_URL` | no                 | Override the default verify URL (tests / staging mirrors).        |
| `CAPTCHA_SITE_KEY`   | (web-side)         | Public site key. Lives on the website / app; not read by the API. |

## Global caps (deferred)

Global caps are documented here for design completeness but are NOT
wired in this PR. The shape we'll adopt:

- `EVER_WORKS_ANON_GLOBAL_HOURLY_CAP` — total anon-user creates per
  hour across all IPs. Default unset (no global cap; per-IP throttle
  applies).
- `EVER_WORKS_ANON_GLOBAL_DAILY_CAP` — total anon-user creates per
  day.
- `EVER_WORKS_QUICK_CREATE_GLOBAL_HOURLY_CAP` — total quick-create
  invocations per hour.

Implementation will piggyback on `@nestjs/throttler`'s storage
abstraction so the cap is shared across pods, with Redis as the
backing store (which we'll need to introduce). Tracked as a follow-up
sub-task under EW-624.

## Tests

- `captcha-verifier.service.spec.ts` covers:
    - disabled provider returns success+skipped without an HTTP call,
    - missing token returns failure with `missing-input-response`,
    - turnstile success path POSTs to the official URL with the
      expected body fields,
    - provider-level `success: false` propagates as a failed verify,
    - verifier exception falls open with `verifier-exception`,
    - `CAPTCHA_VERIFY_URL` override is honored,
    - unknown provider is treated as disabled (defense in depth).

## Out of scope (follow-ups)

- Wire `captchaVerifier.verify(...)` into `POST /api/auth/anonymous`
  and `POST /api/works/quick-create`. Those endpoints land in #756 /
  #758 — the wire-up PR depends on both merging first so we don't
  conflict.
- Add a captcha widget to the landing form
  (ever-works-website#37 land first).
- Wire the global caps (Redis dependency).
- Configurable failure mode: today the service falls open on
  verifier outage. Some operators may want a "fail closed" toggle.

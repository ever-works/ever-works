# Implementation Plan: Integrations — GitHub App

**Feature ID**: `integrations-github-app`
**Spec**: `./spec.md`
**Tasks**: `./tasks.md`
**Status**: `Done` (retrospective — surface already shipped)
**Last updated**: 2026-05-08

---

## 1. Architecture Summary

```mermaid
flowchart TD
    GH[GitHub<br/>github.com / api.github.com] -->|setup redirect| Setup[GET /api/github-app/setup]
    GH -->|callback redirect| Callback[GET /api/github-app/callback]
    GH -->|webhooks| Webhook[POST /api/github-app/webhooks]

    User[Authenticated platform user] -->|browser| Setup
    User -->|browser| Callback
    User -->|REST| Mgmt[/installations/*]

    Setup --> Onboarding[GitHubAppOnboardingService<br/>HMAC state + 10m TTL]
    Callback --> Onboarding
    Onboarding --> Service[GitHubAppService<br/>JWT minting + HTTP]
    Service -->|app JWT| GH
    Service -->|installation token| GH
    Service -->|user OAuth code exchange| GH

    Onboarding -->|find-or-create| UserRepo[UserRepository]
    Onboarding -->|provider account| AuthAccount[AuthAccountRepository]
    Onboarding -->|user link| UserLink[GitHubAppUserLinkRepository]
    Onboarding -->|claim ownership| InstRepo[GitHubAppInstallationRepository]

    Mgmt --> Sync[GitHubAppSyncService]
    Webhook --> Sync
    Sync --> InstRepo
    Sync --> RepoRepo[GitHubAppInstallationRepoRepository]
    Sync --> Service
    Sync --> Analyzer[SourceRepoAnalyzerService<br/>@ever-works/agent/import]
    Sync --> Import[WorkImportService.onboardLinkedRepository<br/>@ever-works/agent/services]

    Callback -->|issueSession| AuthProvider[AuthProvider]
```

## 2. Tech Choices

| Concern             | Choice                                                                                                    | Rationale                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Module scope        | Local Nest module (`GitHubAppModule`) — NOT `@Global()`                                                   | The integration's services are only consumed by `apps/api` itself + the agent-onboarding flow which imports the module explicitly.       |
| HTTP client         | `@nestjs/axios` (`HttpService` + `firstValueFrom`)                                                        | Same shape as the rest of `apps/api`'s outbound calls. RxJS observables get unwrapped at call sites for readability.                     |
| App JWT minting     | `createGitHubAppJwt({appId, privateKey})` from `@ever-works/agent/utils`                                  | Centralised in the agent package so both `apps/api` and `packages/tasks` re-use one implementation.                                      |
| Installation token  | `requestGitHubAppInstallationAccessToken(installationId, credentials)` from `@ever-works/agent/utils`     | Same package — keeps the JWT short-TTL cache in one place.                                                                               |
| State signing       | `crypto.createHmac('sha256', config.auth.secret()).update(<base64url>).digest('base64url')`               | Reuses the platform-wide auth secret; no new secret to provision. base64url avoids URL encoding noise.                                   |
| State verification  | `crypto.timingSafeEqual` after a fixed-length guard                                                       | Constant-time comparison + length-pre-check matches GitHub's own webhook verification pattern.                                           |
| Auth gate           | App-wide `AuthSessionGuard` (controllers do NOT carry method-level decorators except `@Public()`)         | The setup + callback endpoints are explicitly `@Public()`; the management endpoints inherit the global guard.                            |
| Webhook signature   | `verifyGitHubWebhookSignature(rawBody, secret, header)` from `@ever-works/agent/utils`                    | Same agent helper, same constant-time comparison. The signature header is `x-hub-signature-256`.                                         |
| Raw-body capture    | Global raw-body parser configured in `apps/api/src/main.ts` (already in place for Stripe-style verifiers) | Without `req.rawBody`, signature verification is impossible. The webhook controller defends the invariant by 400-ing on missing rawBody. |
| User-OAuth fallback | `resolveGitHubAccountEmail(httpService, accessToken, primaryEmail)` from `apps/api/src/auth/utils`        | Shared with the social-login `github` OAuth flow — handles `null` primary email by hitting `/user/emails`.                               |
| Webhook event scope | Only `installation` + `installation_repositories`                                                         | These cover all the persisted-state changes the platform needs. Other events (push, repository, deployment) belong elsewhere.            |
| Race safety         | `claimOwnershipIfUnassigned` uses `WHERE createdByUserId IS NULL` in the UPDATE                           | Concurrent two-leg OAuth handshakes for the same installation deterministically pick a single owner — no advisory locks needed.          |

## 3. Data Model

### Entities (already shipped)

- `GitHubAppInstallation` —
  [`packages/agent/src/entities/github-app-installation.entity.ts`](../../../../packages/agent/src/entities/github-app-installation.entity.ts).
  PK uuid `id`, unique `installationId` (string), `appSlug`,
  `accountLogin`, `accountType`, `targetType`, `createdByUserId`
  (nullable), `createdByGithubUserId` (nullable), `suspendedAt`
  (nullable), `deletedAt` (nullable), `rawPayload` jsonb, standard
  `createdAt`/`updatedAt`.
- `GitHubAppInstallationRepository` —
  [`packages/agent/src/entities/github-app-installation-repository.entity.ts`](../../../../packages/agent/src/entities/github-app-installation-repository.entity.ts).
  Per-installation repo. `installationEntityId` FK,
  `(installationEntityId, githubRepoId)` unique. Fields: `owner`,
  `repo`, `fullName`, `isPrivate`, `defaultBranch`, `selected`.
- `GitHubAppUserLink` —
  [`packages/agent/src/entities/github-app-user-link.entity.ts`](../../../../packages/agent/src/entities/github-app-user-link.entity.ts).
  Unique on `githubUserId`. Holds the user-OAuth-app token, distinct
  from the installation access token.

### DTOs / contracts

- `GitHubAppSetupQueryDto` and `GitHubAppCallbackQueryDto` in
  [`dto/github-app.dto.ts`](../../../../apps/api/src/integrations/github-app/dto/github-app.dto.ts) —
  query-string DTOs validated by the global `ValidationPipe`.
- No `@ever-works/contracts` additions. The integration consumes
  `User` and `GitHubAppInstallation` from
  `@ever-works/agent/entities`.

### Migrations

- The three GitHub-App tables already shipped via prior migrations
  in `packages/agent/src/database/migrations/`. This feature does
  NOT add new schema.

## 4. API Surface

### Auth-bearing controller (`GitHubAppController`)

| Method | Endpoint                                                                           | Auth         | Status  |
| ------ | ---------------------------------------------------------------------------------- | ------------ | ------- |
| `GET`  | `/api/github-app/setup`                                                            | `@Public()`  | Shipped |
| `GET`  | `/api/github-app/callback`                                                         | `@Public()`  | Shipped |
| `GET`  | `/api/github-app/installations`                                                    | Global guard | Shipped |
| `POST` | `/api/github-app/installations/:installationId/sync`                               | Global guard | Shipped |
| `POST` | `/api/github-app/installations/:installationId/repositories/:repositoryId/onboard` | Global guard | Shipped |

### Webhook controller (`GitHubAppWebhookController`)

| Method | Endpoint                   | Auth                                             | Status  |
| ------ | -------------------------- | ------------------------------------------------ | ------- |
| `POST` | `/api/github-app/webhooks` | `@Public()` (signature verification IS the gate) | Shipped |

## 5. Plugin Surface (if any)

None today. The integration lives in `apps/api/integrations/github-app/`
and exposes services through `@nestjs/common` Module exports.

A future migration to `packages/plugins/github-app` would let other
deployments swap in alternate git providers (GitLab Apps, Bitbucket
Apps) by writing a sibling plugin. That move is gated on the plugin
SDK exposing a session-issuance capability — today, only `apps/api`
can mint sessions via `AuthProvider`.

## 6. Web / CLI Surface

- **Web**: `apps/web` consumes the integration via the GitHub-App
  install button + an installations page. The setup URL
  (`config.githubApp.setupUrl()`) is what the Install button points
  to; GitHub bounces back through `setup` → `callback`, the web app
  captures the auth payload, and the installations page reads
  `GET /api/github-app/installations` to render the list.
- **CLI / MCP**: not consumed today. The MCP onboarding flow uses
  the underlying services indirectly via the agent-zero-friction
  onboarding spec.

## 7. Background Jobs

None today. Webhook reception is in-band — `handleWebhook` runs to
completion before the controller returns 200.

A future enhancement could move webhook processing into a
Trigger.dev queue (for retry semantics + replay tooling) — that
would belong in `packages/tasks` and would not change the public
HTTP surface.

## 8. Security & Permissions

- **AuthN**: `setup`/`callback` are `@Public()` — they're the entry
  points BEFORE a session exists. All other endpoints inherit the
  global `AuthSessionGuard`.
- **AuthZ**: `syncInstallation` and `onboardInstallationRepository`
  enforce ownership via `installation.createdByUserId === user.id`
  in the service layer (the controller does NOT route this through
  a guard — the per-row check is the auth gate).
- **Secrets**: All five required env vars are read via
  `config.githubApp.*` getters. The credentials are NEVER logged
  and NEVER returned in any response payload.
- **State signing**: 10-minute TTL + HMAC-SHA-256 + constant-time
  comparison. Replays beyond the window are rejected; tampered
  payloads fail signature verification before any external call.
- **Webhook signing**: `verifyGitHubWebhookSignature` uses
  `crypto.timingSafeEqual` against the configured secret.
- **Email-link safety**: The platform refuses to link a GitHub-App
  user to an existing local user via email unless GitHub has
  marked that email verified — preventing attacker-controlled
  GitHub accounts from claiming existing platform users by setting
  the victim's email as their primary.
- **Race safety**: `claimOwnershipIfUnassigned` uses
  `WHERE createdByUserId IS NULL` in the UPDATE — only the first
  concurrent call wins.

## 9. Observability

- **Activity log**: this integration does NOT emit
  activity-log entries today. Installation creation is a once-per-
  workspace event; if an audit trail is required, the spec would
  need extension (see OQ-7 in `tasks.md`).
- **Logger**: no per-call logging in `GitHubAppService` —
  outbound calls flow through `nestjs/axios`'s default request
  logger when enabled. Failures bubble as Nest exceptions and the
  global exception filter logs them with the request span.
- **Metrics**: standard Nest request-duration histograms cover
  every endpoint. No new metrics are added.

## 10. Phased Rollout

The feature has shipped. There is no rollout to plan.

The env-var gate (missing `GITHUB_APP_*` causes the integration to
500 on first GitHub call rather than self-disabling) is a known
weakness — see OQ-2 in `spec.md`. A `GitHubAppSyncGuard` analogous
to `CrmSyncGuard` would let deployments without GitHub-App
credentials surface a clean `503 Service Unavailable` instead.

## 11. Risks & Mitigations

| Risk                                                    | Likelihood | Impact                                               | Mitigation                                                                                                                                                                |
| ------------------------------------------------------- | ---------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing env var leaks as 500 from `getCredentials`      | Medium     | Operator-visible noise; users see opaque error       | OQ-2 follow-up — add a `GitHubAppSyncGuard` that promotes the missing-credentials case to a 503 at the controller boundary.                                               |
| State payload TTL too short for slow GitHub redirect    | Low        | Legitimate users see "expired state" mid-flow        | 10 minutes is generous for the OAuth redirect. If reports surface, raise to 30 min — but never beyond GitHub's `code` TTL (10 min from issue).                            |
| Concurrent claim-ownership races                        | Low        | Wrong user owns the installation                     | `claimOwnershipIfUnassigned` uses `WHERE createdByUserId IS NULL` — atomic. ✅                                                                                            |
| GitHub renames `installation` event in the future       | Low        | Webhook silently drops events                        | OQ-6 follow-up — log unsupported event names at `debug` so renames are spottable in production logs.                                                                      |
| `selected: true` default floods the platform with repos | Medium     | Org with hundreds of repos clogs the UI              | OQ-9 follow-up — preserve prior `selected: false` rows during `replaceForInstallation`.                                                                                   |
| Synthetic noreply email collision across deployments    | Low        | Two deployments could write the same synthetic email | OQ-4 follow-up — derive the suffix from `webAppUrl()`. Today, the synthetic email is never sent to, so collision is harmless until a future feature uses these addresses. |
| Installation-repo onboarding limited to `data_repo`     | Medium     | Users can't onboard website / agent / pipeline repos | OQ-8 follow-up + spec extension — the analyzer can already detect those types; the gate is in `onboardInstallationRepository`.                                            |
| Installation token leaks into a log line                | Low        | Credential exposure                                  | The token is only set in the request `headers` getter of `GitHubAppService`. Any change to that file should be reviewed for log additions.                                |
| Email-not-verified rejection surfaces as a generic 401  | Medium     | Confused user — they don't see why the link refused  | OQ-3 follow-up — render this case as a setup-error page in the web UI rather than a callback 401.                                                                         |

## 12. Constitution Reconciliation

- **Principle I (Plugin-first)**: PARTIAL — implementation lives
  in `apps/api/integrations/github-app/` rather than
  `packages/plugins/github-app`. Same reasoning as
  `integrations-twenty-crm`: the integration touches platform-side
  user/auth resolution which is core API responsibility today.
- **Principle II (Capability-driven)**: N/A — no new capability.
- **Principle III (Source-of-truth repos)**: ✅ — GitHub remains
  authoritative; the platform mirrors a snapshot.
- **Principle IV (Trigger.dev for long work)**: N/A — webhook
  reception and OAuth handshakes are request-scoped.
- **Principle V (Forward-only migrations)**: ✅ — three GH-App
  tables already shipped via prior migrations.
- **Principle VI (Tests)**: ✅ — 22 controller tests + 3
  service-level suites in `apps/api/src/integrations/github-app/`.
- **Principle VII (Secrets via `x-secret`)**: ✅ — credentials in
  env vars only.
- **Principle VIII (Plugin counts in canonical doc)**: N/A — not a
  plugin yet.
- **Principle IX (Behaviour-first spec)**: ✅ — `spec.md`
  describes observable behaviour only.
- **Principle X (Backwards-compatible)**: ✅ — additive,
  env-gated.

## 13. References

- Spec: `./spec.md`
- Tasks: `./tasks.md`
- Source: see `spec.md` §10.
- Tests: 22 controller-level + 3 service-level unit suites in
  `apps/api/src/integrations/github-app/*.spec.ts` — see PR
  [#502](https://github.com/ever-works/ever-works/pull/502).
- External: see `spec.md` §10.
- Related specs:
    - [`auth-jwt-oauth`](../auth-jwt-oauth/spec.md)
    - [`agent-zero-friction-onboarding`](../agent-zero-friction-onboarding/spec.md)
    - [`work-import`](../work-import/spec.md)
    - [`integrations-twenty-crm`](../integrations-twenty-crm/spec.md)

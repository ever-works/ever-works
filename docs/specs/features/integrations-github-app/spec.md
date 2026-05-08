# Feature Specification: Integrations — GitHub App

**Feature ID**: `integrations-github-app`
**Branch**: `docs/spec-integrations-github-app`
**Status**: `Retrospective`
**Created**: 2026-05-08
**Last updated**: 2026-05-08
**Owner**: Ever Works Team

---

## 1. Overview

The GitHub App integration is the platform's primary onboarding path
for repositories that the user does **not** already authorise via the
classic OAuth `github` social login. A configured GitHub App lets a
workspace owner install the app on their personal account or
organisation, grant repository-level access without exposing a PAT,
and have the platform discover, persist, and onboard those repositories
as Works through `WorkImportService.onboardLinkedRepository`. The
integration also reconciles installation state via GitHub webhooks
(`installation` and `installation_repositories` events) so deletions,
suspensions, and repository-list changes propagate without operator
action.

The integration is implemented inside `apps/api/src/integrations/github-app/`
as a Nest module and depends on three databases entities owned by the
agent package — `GitHubAppInstallation`, `GitHubAppInstallationRepo`,
and `GitHubAppUserLink`. It is gated by five environment variables
(`GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`); the slug,
setup URL, and callback URL are derived with sensible defaults from
`web app URL`.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** I am a workspace owner with the GitHub App installed,
  **when** GitHub redirects me to `GET /api/github-app/setup?installation_id=<id>&setup_action=install`,
  **then** the platform calls GitHub's `GET /app/installations/:id`
  with an app JWT, upserts the installation row via
  `GitHubAppInstallationRepository.upsertFromGithub`, signs an HMAC
  state payload (10-minute TTL), and returns a JSON envelope
  `{ url: 'https://github.com/login/oauth/authorize?...' }` so the
  client can complete the OAuth handshake.
- **Given** GitHub redirects me back to
  `GET /api/github-app/callback?code=<c>&state=<s>` after the user
  authorises the app, **when** the controller verifies the HMAC state
  and exchanges the `code`, **then** the platform resolves or creates
  a local `User` (via the GitHub user link repository → auth account
  → email lookup chain), upserts the corresponding `auth_account`
  row with `providerId: 'github'`, persists the GitHub-App user-link
  row with the OAuth-app token (separate from the app installation
  token), then claims ownership of the installation row for the
  resolved user via
  `GitHubAppInstallationRepository.claimOwnershipIfUnassigned`. The
  controller then issues a session via `AuthProvider.issueSession`
  and returns `{ ...auth, installationId, redirectTo }`.
- **Given** I am signed in, **when** I `GET /api/github-app/installations`,
  **then** the controller returns every installation I own (only
  rows where `createdByUserId === auth.userId`, ordered by
  `createdAt DESC`, soft-deleted rows excluded), each enriched with
  the latest `installation_repositories` rows from
  `GitHubAppInstallationRepoRepository.listForInstallation`.
- **Given** I have a stale repository list, **when** I
  `POST /api/github-app/installations/:installationId/sync`,
  **then** the platform mints a fresh installation access token
  (`/app/installations/:id/access_tokens`), pages through
  `/installation/repositories?per_page=100&page=N` until the page
  count drops below `100` (or `total_count` is met), and replaces
  the platform-side repo list atomically via
  `replaceForInstallation`.
- **Given** I want to onboard a discovered repository, **when** I
  `POST /api/github-app/installations/:installationId/repositories/:repositoryId/onboard`,
  **then** the platform analyses the repo with
  `SourceRepoAnalyzerService.analyzeRepository` (using the fresh
  installation access token), and — only if the analyzer reports
  `detectedType === 'data_repo'` — calls
  `WorkImportService.onboardLinkedRepository` with the
  `mode: 'github_app_installation'` auth payload so the resulting
  Work knows to mint installation tokens at runtime instead of
  carrying a user-bound PAT.
- **Given** GitHub posts an `installation` webhook event with a
  valid `x-hub-signature-256`, **when** the public webhook controller
  runs, **then** the platform applies the right action: `created`/
  `new_permissions_accepted`/`unsuspend` → upsert + sync;
  `deleted` → soft-delete; `suspend` → mark `suspendedAt`;
  `unsuspend` → clear `suspendedAt`.
- **Given** GitHub posts an `installation_repositories` webhook event
  with a valid signature, **when** the controller runs, **then** the
  platform calls `syncInstallation(<installationId>, undefined)` —
  no `userId` filter, since GitHub is the trigger — to reconcile the
  per-installation repo list.

### 2.2 Edge cases & failures

- **Given** the GitHub App credentials are unset (`GITHUB_APP_ID` or
  `GITHUB_APP_PRIVATE_KEY` missing), **when** any code path calls
  `GitHubAppService.getCredentials`, **then** it throws
  `Error('GitHub App credentials are not configured')` and the
  controller surfaces a 500 — there is NO env-gate guard equivalent
  to `CrmSyncGuard`.
- **Given** the OAuth `state` is missing the `.` separator OR the
  signature length differs from the expected length OR the HMAC does
  not match (constant-time `timingSafeEqual`), **when**
  `GitHubAppOnboardingService.verifyState` runs, **then** it throws
  `BadRequestException('Invalid GitHub App state')`/
  `'Invalid GitHub App state signature'` BEFORE any external call.
- **Given** the OAuth `state` payload is older than 10 minutes,
  **when** `verifyState` reads `payload.issuedAt`, **then** it
  throws `BadRequestException('GitHub App setup state expired')`.
- **Given** the OAuth `state` payload has `installationId` empty or
  `issuedAt` falsy, **when** `verifyState` parses the body, **then**
  it throws `BadRequestException('Invalid GitHub App state payload')`.
- **Given** GitHub responds to the access-token exchange with
  `{ error, error_description }`, **when**
  `GitHubAppService.exchangeUserCode` reads `data.error`, **then**
  it throws `UnauthorizedException(error_description ?? \`GitHub App authorization failed: ${error}\`)`.
- **Given** GitHub responds to the access-token exchange with no
  `access_token` and no `error`, **when** `exchangeUserCode` checks
  the body, **then** it throws
  `BadRequestException('GitHub App authorization did not return an access token')`.
- **Given** the resolved GitHub user's primary `email` is `null`,
  **when** the platform falls back to
  `resolveGitHubAccountEmail(httpService, accessToken, null)`,
  **then** the helper hits `/user/emails`, picks the verified
  primary, and returns `{email, emailVerified}` — when the helper
  returns no email, the onboarding service synthesises
  `github-app-${githubUserId}@users.noreply.ever.works` and creates
  the user with `emailVerified: false`.
- **Given** an existing local user is found by email but the
  GitHub-resolved email is NOT verified, **when**
  `findOrCreateLocalUser` checks the link/auth-account chain,
  **then** the service throws
  `UnauthorizedException('Unable to link this GitHub App user because the provider email is not verified')`.
- **Given** a local user already has an email under
  `@users.noreply.ever.works` but the GitHub user provides a real
  email, **when** the onboarding update path runs, **then**
  `nextEmail` adopts the real email; otherwise the existing email
  is preserved.
- **Given** the requested local username is already taken, **when**
  `resolveUniqueUsername` runs, **then** it appends `-2`, `-3`, …
  until `userRepository.findByUsername` returns `null`. An empty/
  whitespace base falls back to the literal `'github-user'`.
- **Given** the installation has been deleted (`deletedAt != null`)
  or suspended (`suspendedAt != null`), **when**
  `syncInstallation`/`onboardInstallationRepository` is called,
  **then** they short-circuit and return `null`.
- **Given** a `userId` is passed to `syncInstallation` but the
  installation's `createdByUserId` differs, **when** the service
  checks ownership, **then** it returns `null`. The controller
  promotes this `null` into an `UnauthorizedException`.
- **Given** the analyzer flags a repo whose `detectedType` is NOT
  `'data_repo'`, **when** `onboardInstallationRepository` runs,
  **then** it returns
  `{status:'error', message: 'Only existing data repositories can be onboarded from GitHub App installations right now'}` —
  the controller promotes this into `BadRequestException`.
- **Given** the analyzer returns a generic `error` field, **when**
  `onboardInstallationRepository` runs, **then** it returns
  `{status:'error', message: <analysis.error>}` and the controller
  surfaces it as `BadRequestException`.
- **Given** the webhook controller receives a payload with no
  `x-hub-signature-256` header AND no `GITHUB_APP_WEBHOOK_SECRET`
  configured, **when**
  `GitHubAppService.verifyWebhookSignature(rawBody, undefined)` runs,
  **then** it returns `false` (because `secret` is empty) and the
  controller throws `UnauthorizedException('Invalid GitHub webhook signature')`.
- **Given** the webhook payload's `req.rawBody` is undefined, **when**
  the controller runs, **then** it throws
  `BadRequestException('Missing raw webhook payload')` BEFORE
  `verifyWebhookSignature` is called.
- **Given** the webhook payload's `x-github-event` header is
  missing, **when** the controller runs, **then** it throws
  `BadRequestException('Missing GitHub event header')` BEFORE
  signature verification.
- **Given** the webhook event name is anything other than
  `installation` or `installation_repositories`, **when**
  `handleWebhook` runs, **then** the method silently returns
  `undefined` — the platform does not error on unsupported events
  so GitHub's retry logic does not amplify them.
- **Given** the `installation` webhook payload has no
  `installation.id`, **when** `handleWebhook` runs, **then** it
  silently returns `undefined`.
- **Given** the `installation_repositories` webhook payload has no
  `installation.id`, **when** `handleWebhook` runs, **then** it
  silently returns `undefined`.

## 3. Functional Requirements

- **FR-1** The integration MUST be a non-global Nest module
  registered as `GitHubAppModule` in
  [`github-app.module.ts`](../../../../apps/api/src/integrations/github-app/github-app.module.ts).
  It MUST import `DatabaseModule`, `HttpModule`, `AuthModule`,
  `WorkModule`, and `ImportModule`, and MUST export
  `GitHubAppService`, `GitHubAppOnboardingService`, and
  `GitHubAppSyncService` so other API features (e.g. agent
  onboarding) can re-use them.

- **FR-2** `GitHubAppService.getConfiguration` MUST return the live
  five-field tuple `{appId, clientId, slug, setupUrl, callbackUrl}`
  from `config.githubApp`.

- **FR-3** Required env vars:
    - `GITHUB_APP_ID` (numeric app id, no default — credentials
      method throws if missing).
    - `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` (used
      ONLY by the user-OAuth `exchangeUserCode` flow).
    - `GITHUB_APP_PRIVATE_KEY` (PEM with literal `\n` sequences;
      `config.githubApp.privateKey()` MUST replace `\\n` with `\n`
      before passing to `jsonwebtoken`).
    - `GITHUB_APP_WEBHOOK_SECRET` (HMAC-SHA-256 secret;
      `verifyWebhookSignature` MUST return `false` if missing — the
      webhook controller treats that as `401`).

- **FR-4** Optional env vars (with defaults):
    - `GITHUB_APP_SLUG` (default `'ever-works'`).
    - `GITHUB_APP_SETUP_URL` (default `${webAppUrl}/api/github-app/setup`).
    - `GITHUB_APP_CALLBACK_URL` (default `${webAppUrl}/api/github-app/callback`).

- **FR-5** `GitHubAppService.getUserAuthorizationUrl(state)` MUST
  build `https://github.com/login/oauth/authorize?client_id=<>&redirect_uri=<>&state=<>`
  with `client_id` defaulting to `''` if env var unset (so the URL
  encodes a blank query parameter rather than the literal
  `'undefined'`).

- **FR-6** `GitHubAppService.exchangeUserCode(code)` MUST `POST`
  `https://github.com/login/oauth/access_token` with
  `application/x-www-form-urlencoded` body
  (`client_id`, `client_secret`, `code`, `redirect_uri`) and
  `Accept: application/json` header. Errors MUST be coerced as
  per the rules in §2.2.

- **FR-7** `GitHubAppService.getAuthenticatedGithubUser(token)` MUST
  GET `https://api.github.com/user` with
  `createGitHubOAuthHeaders(token)`, then resolve the email via
  `resolveGitHubAccountEmail(httpService, accessToken, data.email || null)`
  (which falls back to `/user/emails` when the primary is null).
  The returned shape MUST be
  `{githubUserId: String(data.id), login, displayName: data.name || data.login,
  email, emailVerified, avatarUrl: data.avatar_url || null,
  nodeId: data.node_id || null, accessToken}`.

- **FR-8** `GitHubAppService.getInstallation(installationId)` MUST
  call `GET https://api.github.com/app/installations/:id` with the
  app JWT (created via `createGitHubAppJwt({appId, privateKey})`)
  and `createGitHubAppHeaders(jwt)`.

- **FR-9** `GitHubAppService.createInstallationAccessToken(installationId)`
  MUST proxy to the agent-package helper
  `requestGitHubAppInstallationAccessToken(installationId, {appId, privateKey})`
  so JWT minting + token exchange logic stays in one place.

- **FR-10** `GitHubAppService.listInstallationRepositories(installationId)`
  MUST page through `/installation/repositories?per_page=100&page=N`
  until either (a) a page has fewer than 100 entries OR (b)
  `repositories.length >= total_count` (when `total_count` is a
  number). The page cursor MUST start at `1` and increment by `1`.

- **FR-11** `GitHubAppService.verifyWebhookSignature(rawBody, signature?)`
  MUST short-circuit to `false` when the configured webhook secret
  is empty. Otherwise it MUST delegate to
  `verifyGitHubWebhookSignature(rawBody, secret, signatureHeader)`.

- **FR-12** `GitHubAppOnboardingService.beginSetup(input)` MUST
  call `getInstallation(input.installationId)` first, then
  `upsertFromGithub` with the payload — even though no user is
  bound yet — so the row exists when the user returns from the
  OAuth handshake. The `state` MUST be HMAC'd with `config.auth.secret()`
  via `createHmac('sha256', secret).update(encodedPayload).digest('base64url')`.

- **FR-13** `redirectTo` MUST be normalised: only strings starting
  with `/` survive — anything else (relative paths without leading
  slash, full URLs, `null`/`undefined`, non-string values) becomes
  `undefined`.

- **FR-14** `GitHubAppOnboardingService.completeUserAuth(input)` MUST
  - verify the state (HMAC + 10-minute TTL),
  - exchange the user code,
  - resolve the GitHub user (via `getAuthenticatedGithubUser`),
  - find-or-create the local user (the four-step chain in §2.1
    + email-not-verified rejection),
  - upsert the `auth_accounts` row with `providerId: 'github'`,
    `accountId: <githubUserId>`, `tokenType: 'Bearer'`, full
    OAuth-token fields, and `metadata: {nodeId, providerUserId, login}`,
  - upsert the `github_app_user_links` row with the OAuth-app token
    (kept distinct from the app installation token because GitHub
    issues separate JWTs for each),
  - re-call `getInstallation` so the row payload is fresh on the
    second leg of the handshake,
  - call `upsertFromGithub` again,
  - call `claimOwnershipIfUnassigned(installationId, user.id, githubUserId)`
    which atomically writes `createdByUserId`/`createdByGithubUserId`
    only when the row's `createdByUserId IS NULL` (the WHERE clause
    is the race-safety guarantee — concurrent claim attempts deterministically
    pick a single owner).

- **FR-15** When `claimOwnershipIfUnassigned` returns `null` (no
  matching row), the onboarding service MUST throw
  `BadRequestException('GitHub App installation could not be persisted')`.

- **FR-16** When the find-or-create chain creates a new user, the
  password MUST be a `bcrypt.hash(randomUUID(), 10)` placeholder
  (the user can't sign in with credentials — they always come back
  through the GitHub App OAuth flow). `registrationProvider` MUST
  be `'github'`.

- **FR-17** When updating an existing user, the email MUST follow
  the noreply rule (§2.2): replace `@users.noreply.ever.works`
  emails with the real one, otherwise preserve. `lastLoginAt` MUST
  be set to `new Date()` and `registrationProvider` re-asserted as
  `'github'` even if previously different.

- **FR-18** `GitHubAppController.setup` MUST be `@Public()` (no
  session required — GitHub redirects unauthenticated users here).
  `GitHubAppController.callback` MUST be `@Public()` for the same
  reason. Both MUST validate query params via `class-validator`
  DTOs (`GitHubAppSetupQueryDto.installation_id` is required,
  `setup_action` is `'install' | 'request'` if present;
  `GitHubAppCallbackQueryDto.code` and `state` are both required).

- **FR-19** `GitHubAppController.callback` MUST issue a session via
  `authProvider.issueSession(user.id)` AFTER `completeUserAuth`
  succeeds, and the response envelope MUST be
  `{...auth, installationId, redirectTo}` so the client knows where
  to bounce next.

- **FR-20** `GitHubAppController.listInstallations` and downstream
  endpoints MUST rely on the global `AuthSessionGuard` (no class- or
  method-level `@UseGuards`) — the guard is applied app-wide, so
  these routes are private by virtue of NOT carrying `@Public()`.

- **FR-21** `GitHubAppController.syncInstallation` MUST 401 with
  `UnauthorizedException('GitHub App installation not found for this user')`
  when the service returns `null` (covers the not-found, deleted,
  suspended, and ownership-mismatch cases — the controller does
  NOT distinguish them, by design, to avoid leaking ownership info).

- **FR-22** `GitHubAppController.onboardRepository` MUST 404 with
  `NotFoundException('GitHub App repository not found for this user')`
  when `onboardInstallationRepository` returns `null`. When the
  service returns `{status:'error', message}`, the controller MUST
  promote it to `BadRequestException(message)`.

- **FR-23** `GitHubAppSyncService.listInstallationsForUser(userId)`
  MUST hydrate every returned installation with its repo list by
  fanning out via `Promise.all` to
  `GitHubAppInstallationRepoRepository.listForInstallation(installation.id)`.

- **FR-24** `GitHubAppSyncService.syncInstallation(installationId, userId?)`
  MUST short-circuit to `null` for missing/deleted/suspended/
  ownership-mismatch installations BEFORE calling
  `listInstallationRepositories`. The replace shape MUST set
  `selected: true` for every repo (the platform UI will toggle this
  later). The repo's `owner` MUST default to `installation.accountLogin`
  when GitHub's payload omits it; `fullName` MUST default to
  `'<owner>/<repo>'` when GitHub's payload omits it.

- **FR-25** `GitHubAppSyncService.onboardInstallationRepository`
  MUST mint a fresh installation access token per call (no token
  caching at this layer — `WorkImportService` is responsible for
  refresh) and pass it to `analyzeRepository(sourceUrl, token)` so
  the analyzer can read private repos. The auth payload forwarded
  to `WorkImportService.onboardLinkedRepository` MUST be
  `{mode: 'github_app_installation', providerId: 'github', installationId,
  installationRepositoryId: repository.id, repoFullName: repository.fullName}`
  — explicitly carrying the platform-side repo entity id so the
  Work can re-resolve the row for token refresh.

- **FR-26** `GitHubAppSyncService.handleWebhook` MUST handle the
  `installation` event by:
    - returning early if `payload.installation?.id` is falsy,
    - on `action === 'deleted'`, calling
      `installationRepository.markDeleted(<id>, new Date())` and
      returning,
    - otherwise calling `upsertFromGithub` with the installation
      shape — including `createdByGithubUserId` from
      `payload.sender?.id` ONLY when `action === 'created'`,
    - then for `action in {created, new_permissions_accepted, unsuspend}`
      firing a `syncInstallation` (no `userId` filter).

- **FR-27** The `suspendedAt` field on `upsertFromGithub` MUST
  follow the action-specific rules: `'suspend'` → `new Date()`;
  `'unsuspend'` → `null`; otherwise → `payload.suspended_at`
  if present, else `undefined` (which `removeUndefinedValues` will
  drop).

- **FR-28** `GitHubAppSyncService.handleWebhook` MUST handle the
  `installation_repositories` event by extracting
  `payload.installation?.id`, returning early if falsy, and calling
  `syncInstallation(String(installationId))` with NO user filter.

- **FR-29** The webhook controller route MUST be `POST /api/github-app/webhooks`,
  marked `@Public()` (signature verification IS the auth gate). It
  MUST require `req.rawBody` (set up by the global raw-body parser
  in main.ts) — without a raw body, signature verification is
  impossible and the controller MUST 400.

- **FR-30** `GitHubAppController` and `GitHubAppWebhookController`
  MUST share the prefix `/api/github-app` but be DISTINCT controller
  classes — the OAuth-flow + management endpoints live in
  `GitHubAppController`, the webhook receiver lives in
  `GitHubAppWebhookController`. This split exists so the auth-bearing
  endpoints can later be moved under a different prefix without
  affecting the public webhook path.

## 4. Non-Functional Requirements

- **Performance**: `listInstallationRepositories` paginates server-side
  100-at-a-time. The default cap matches GitHub's documented max
  page size; for installations with > 1 000 repos, the page count
  is unbounded — by design, since GitHub's documented per-installation
  cap is 1 000 repos and exceeding it would be an upstream issue
  rather than a platform constraint. Webhook handlers MUST be
  non-blocking — `handleWebhook` is fire-and-forget from the
  caller's perspective; the controller still awaits to ensure errors
  are logged in the same request span.
- **Reliability**: The integration relies on GitHub's webhook
  delivery retry semantics for installation reconciliation. If a
  webhook delivery fails, GitHub will retry; the operator can also
  re-sync manually via `POST /api/github-app/installations/:id/sync`.
  The `claimOwnershipIfUnassigned` query is the race-safety
  guarantee for concurrent two-leg OAuth handshakes — the SQL
  `WHERE createdByUserId IS NULL` ensures only the first claim
  succeeds.
- **Security**: GitHub App credentials live in env vars only. The
  app JWT is minted on every call to `getInstallation` /
  `createInstallationAccessToken` (no JWT caching in `apps/api`;
  the agent helper handles its own short-lived JWT). The OAuth
  state is HMAC-signed with `config.auth.secret()` and TTL-bound
  to 10 minutes — replays beyond that window are rejected.
  Webhook signature verification MUST always use a constant-time
  comparison (`verifyGitHubWebhookSignature` delegates to
  `crypto.timingSafeEqual`). The state-payload signature comparison
  in `verifyState` ALSO uses `timingSafeEqual` after a fixed-length
  guard. The user-OAuth `client_secret` MUST be sent in the request
  body, never in a URL query.
- **Privacy**: Auto-created users without a verified email get a
  synthetic `@users.noreply.ever.works` address and `emailVerified:
  false`. This prevents accidental cross-account linking via
  unverified emails. The user-OAuth-app token is stored in BOTH
  the `auth_accounts` row (for user-bound API calls) and the
  `github_app_user_links` row (for installation-time bookkeeping)
  — the duplication is intentional because the two tables have
  different lifecycle owners. The webhook secret is read once per
  call; the constant-time signature check prevents secret-extraction
  via timing oracles.
- **Observability**: `GitHubAppService` does NOT log per-call
  (HTTPS calls flow through `nestjs/axios` and Nest's request
  middleware). Failures bubble as Nest exceptions, which the global
  exception filter logs. Webhook signature failures surface as
  `UnauthorizedException` with `'Invalid GitHub webhook signature'`
  — operators see the rejection in the API request log.
- **Compatibility**: The integration targets the GitHub REST API
  v3 (`api.github.com`). The base URL is currently hard-coded;
  GitHub Enterprise Server support would require new env vars
  (`GITHUB_APP_BASE_URL`, `GITHUB_APP_API_BASE_URL`) and threading
  them through every `firstValueFrom(httpService.*)` call.

## 5. Key Entities & Domain Concepts

| Entity / concept                           | Description                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GitHubAppInstallation`                    | Platform row mirroring GitHub's installation. PK `id` (uuid), unique `installationId` (string from GitHub), `appSlug`, `accountLogin`, `accountType`, `targetType`, `createdByUserId` (nullable), `createdByGithubUserId` (nullable), `suspendedAt` (nullable), `deletedAt` (nullable), `rawPayload` jsonb. |
| `GitHubAppInstallationRepo`                | Per-installation repo. `installationEntityId` FK → `GitHubAppInstallation.id`, unique `(installationEntityId, githubRepoId)`, fields: `owner`, `repo`, `fullName`, `isPrivate`, `defaultBranch`, `selected`.                                                                                                |
| `GitHubAppUserLink`                        | Maps GitHub-App-OAuth users to platform users. Unique on `githubUserId`. Fields: `userId`, `githubLogin`, `githubNodeId`, `accessToken`, `refreshToken`, `accessTokenExpiresAt`, `refreshTokenExpiresAt`, `scope`. Distinct from `auth_accounts.providerId='github'` because the GH-App OAuth client is a separate app from the social-login OAuth app. |
| `auth_accounts` (`providerId='github'`)    | Platform-wide social-login row. The GitHub-App callback also writes here so the user's session-level GitHub auth survives even if the App is uninstalled.                                                                                                                                                |
| `SetupStatePayload`                        | `{installationId, redirectTo?, setupAction?, issuedAt}` — HMAC-signed and base64url-encoded into the OAuth `state` parameter. 10-minute TTL.                                                                                                                                                            |
| `GitHubAppSetupQueryDto`                   | Validated query for `GET /api/github-app/setup`. `installation_id` required; `setup_action` ∈ `{install, request}`; `redirectTo` optional (normalised by the service).                                                                                                                                  |
| `GitHubAppCallbackQueryDto`                | Validated query for `GET /api/github-app/callback`. `code` and `state` both required; `class-validator` decorators ensure they are strings.                                                                                                                                                            |
| `GitHubAppService`                         | HTTP client + JWT minting. Stateless.                                                                                                                                                                                                                                                                  |
| `GitHubAppOnboardingService`               | OAuth state signing, `findOrCreateLocalUser`, `claimOwnershipIfUnassigned`. The user-resolution chain.                                                                                                                                                                                                  |
| `GitHubAppSyncService`                     | Installation lifecycle, repo-list reconciliation, webhook handler, repo onboarding handoff to `WorkImportService`.                                                                                                                                                                                      |
| `WorkImportService.onboardLinkedRepository`| Down-stream consumer. The auth payload `{mode:'github_app_installation', ...}` lets the new Work mint installation tokens at runtime.                                                                                                                                                                  |
| `SourceRepoAnalyzerService`                | Static analyser. Reads the repo's `works.yml` to determine `detectedType` ∈ `{data_repo, website, …}`. Only `'data_repo'` is onboardable today.                                                                                                                                                        |

## 6. Out of Scope

- GitHub App **creation** (no automation for `/settings/apps/new` —
  the operator registers the app in GitHub and copies the
  credentials into env vars).
- GitHub Enterprise Server — base URLs are hard-coded to
  `api.github.com` / `github.com`.
- App installation **uninstall** initiated from the platform UI —
  GitHub's `/settings/installations/:id` page is the only path.
  When the user uninstalls there, GitHub fires
  `installation.deleted` and the platform soft-deletes the row.
- Installation **token caching** at the API layer — the agent-package
  helper handles short-lived JWT caching internally; the API
  re-mints on every endpoint call.
- **Bulk** repo onboarding — the controller endpoint is per-repo;
  bulk onboarding is a future feature gated behind
  `WorkImportService` enhancements.
- Onboarding **non-data-repo** GitHub repos — the analyzer's
  `detectedType !== 'data_repo'` branch surfaces as a
  `400 BadRequest`. Website / agent / pipeline repos are not yet
  onboardable from the GitHub App surface (they require manual
  Work creation today).
- **Multi-org switching** UI — `listInstallations` returns every
  installation a user owns, ordered by `createdAt DESC`; the web
  client picks one.
- **Per-repo selection** at sync time — the `selected: true`
  default on `replaceForInstallation` is intentional. Selection
  toggling is a future enhancement.
- **Webhook event coverage** beyond `installation` and
  `installation_repositories` — `installation_target`, `repository`,
  `push`, etc. are silently ignored today.

## 7. Acceptance Criteria

- [ ] Setting all five env vars (`GITHUB_APP_ID`,
      `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
      `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`) lets
      `GET /api/github-app/setup?installation_id=…` return a
      well-formed authorize URL.
- [ ] An expired (>10-minute) state payload yields
      `BadRequestException('GitHub App setup state expired')`.
- [ ] A tampered state payload yields
      `BadRequestException('Invalid GitHub App state signature')`.
- [ ] `POST /api/github-app/installations/:id/sync` against an
      installation owned by a different user returns 401 (not 404).
- [ ] `POST /api/github-app/installations/:id/repositories/:repoId/onboard`
      against a non-data-repo returns 400 with the service's
      verbatim message.
- [ ] `POST /api/github-app/webhooks` without `x-hub-signature-256`
      returns 401 (when secret is configured) or 401 (when secret
      is not configured) — both paths short-circuit via
      `verifyWebhookSignature` returning `false`.
- [ ] `POST /api/github-app/webhooks` with an `installation.deleted`
      payload soft-deletes the platform row via `markDeleted(<id>, new Date())`.
- [ ] `POST /api/github-app/webhooks` with an `installation_repositories`
      payload triggers a fresh `syncInstallation` with no user filter.
- [ ] All 22 unit tests in PR
      [#502](https://github.com/ever-works/ever-works/pull/502)
      remain green (controller surface + the three pre-existing
      service-level suites).

## 8. Open Questions

- `[NEEDS CLARIFICATION: OQ-1]` `GitHubAppService.getCredentials`
  throws an *unwrapped* `Error('GitHub App credentials are not configured')`,
  not a `NestException`. With the global exception filter this
  surfaces as a 500. Should it be promoted to
  `ServiceUnavailableException` so the response code reflects the
  configuration gap rather than an internal server error?
- `[NEEDS CLARIFICATION: OQ-2]` There is no `GitHubAppSyncGuard`
  equivalent to `CrmSyncGuard`. When `GITHUB_APP_*` is not
  configured, `setup` and `callback` endpoints will throw 500 on
  the first GitHub call. Should the integration self-disable with
  a `ServiceUnavailableException` at the controller boundary?
- `[NEEDS CLARIFICATION: OQ-3]` `findOrCreateLocalUser` throws
  `UnauthorizedException` for unverified-email link refusals but
  surfaces it as the **callback** response — the user sees a
  generic 401 instead of a redirect to a friendlier UI. A web-only
  follow-up would render this case as a setup-error page.
- `[NEEDS CLARIFICATION: OQ-4]` The synthetic
  `github-app-${githubUserId}@users.noreply.ever.works` email is
  hard-coded. If multiple Ever Works deployments run in parallel
  with different `webAppUrl()`s, those emails could collide. Should
  the suffix be derived from `webAppUrl()` (e.g.
  `@users.noreply.<host>`) instead?
- `[NEEDS CLARIFICATION: OQ-5]` `claimOwnershipIfUnassigned` returns
  the existing row when `createdByUserId` is already set — even if
  it differs from the current `user.id`. This means a
  second user installing the same GitHub App will see
  `completeUserAuth` succeed for them but the installation
  remains owned by the first user. The user-link row is still
  written, so the second user can still authenticate with GitHub
  — but they can't manage the installation. Is this intended? Or
  should the second user receive a `Conflict` response?
- `[NEEDS CLARIFICATION: OQ-6]` `handleWebhook` silently returns
  for unsupported event names. We could log the event name at
  `debug` to make payload-shape changes (e.g. GitHub renaming
  `installation` to `app_installation`) easier to spot.
- `[NEEDS CLARIFICATION: OQ-7]` The webhook controller does NOT
  emit any activity-log entry when an installation is
  created/deleted/suspended. Should it? Currently, the only
  visible artefact is the changed row in `github_app_installations`.
- `[NEEDS CLARIFICATION: OQ-8]` `onboardInstallationRepository`
  refuses non-`data_repo` types with a hard-coded English message.
  Should the message be moved into a constant / i18n key for
  future translation?
- `[NEEDS CLARIFICATION: OQ-9]` `selected: true` on every
  `replaceForInstallation` is an aggressive default — operators
  who add the GitHub App to an org with hundreds of repos will see
  every repo in the platform. A future enhancement should respect
  the user's prior selection (e.g. preserve `selected: false` for
  rows where `(installationId, githubRepoId)` already had
  `selected: false`).

## 9. Constitution Gates

- [x] Plugin-first if introducing an external integration
      (Principle I): **partial** — the integration lives in
      `apps/api/integrations/github-app/` not
      `packages/plugins/github-app`. This matches the same
      decision as `integrations-twenty-crm` (the integration
      touches platform-side user/auth resolution chains, which are
      core API responsibilities). A future migration is plausible
      once the plugin SDK exposes a `Platform` capability for
      session-issuance.
- [x] Capability-driven resolution: N/A — no plugin capability is
      declared.
- [x] Source-of-truth repos preserved: GitHub remains the source of
      truth for repo state; the platform mirrors a snapshot via the
      sync endpoint and the two webhook events. ✅
- [x] Long-running work via Trigger.dev: N/A — installation +
      onboarding flows are request-scoped. Bulk onboarding (future)
      would belong in `packages/tasks` instead.
- [x] Schema changes ship as forward-only migrations: ✅ — the
      three GitHub-App tables already shipped via prior migrations
      in `packages/agent/src/database/migrations/`.
- [x] Tests accompany the change: ✅ — 22 controller-level + the
      three pre-existing service-level suites in
      [`apps/api/src/integrations/github-app/`](../../../../apps/api/src/integrations/github-app/).
      See PR [#502](https://github.com/ever-works/ever-works/pull/502).
- [x] Secrets handled per `x-secret` rules: ✅ — App ID, client
      secret, private key, and webhook secret all read from env
      vars. None are echoed in responses or logs.
- [x] Plugin counts touch the canonical doc only: N/A — not a
      plugin yet.
- [x] Behaviour-first — no implementation in this spec. ✅
- [x] Backwards-compatible API/SDK/schema changes: ✅ — additive,
      env-gated. No existing endpoint is affected.

## 10. References

- Source:
    - [`apps/api/src/integrations/github-app/`](../../../../apps/api/src/integrations/github-app/)
    - [`apps/api/src/integrations/github-app/github-app.module.ts`](../../../../apps/api/src/integrations/github-app/github-app.module.ts)
    - [`apps/api/src/integrations/github-app/github-app.service.ts`](../../../../apps/api/src/integrations/github-app/github-app.service.ts)
    - [`apps/api/src/integrations/github-app/github-app-onboarding.service.ts`](../../../../apps/api/src/integrations/github-app/github-app-onboarding.service.ts)
    - [`apps/api/src/integrations/github-app/github-app-sync.service.ts`](../../../../apps/api/src/integrations/github-app/github-app-sync.service.ts)
    - [`apps/api/src/integrations/github-app/github-app.controller.ts`](../../../../apps/api/src/integrations/github-app/github-app.controller.ts)
    - [`apps/api/src/integrations/github-app/github-app-webhook.controller.ts`](../../../../apps/api/src/integrations/github-app/github-app-webhook.controller.ts)
    - [`apps/api/src/integrations/github-app/dto/github-app.dto.ts`](../../../../apps/api/src/integrations/github-app/dto/github-app.dto.ts)
    - [`apps/api/src/config/constants.ts`](../../../../apps/api/src/config/constants.ts) (`config.githubApp`)
    - [`apps/api/src/auth/utils/github-email.utils.ts`](../../../../apps/api/src/auth/utils/github-email.utils.ts)
    - [`packages/agent/src/database/repositories/github-app-installation.repository.ts`](../../../../packages/agent/src/database/repositories/github-app-installation.repository.ts)
    - [`packages/agent/src/database/repositories/github-app-installation-repository.repository.ts`](../../../../packages/agent/src/database/repositories/github-app-installation-repository.repository.ts)
    - [`packages/agent/src/database/repositories/github-app-user-link.repository.ts`](../../../../packages/agent/src/database/repositories/github-app-user-link.repository.ts)
- Tests: 22 controller-level unit tests + 3 service-level unit suites
  in `apps/api/src/integrations/github-app/*.spec.ts` — see PR
  [#502](https://github.com/ever-works/ever-works/pull/502).
- External:
    - [GitHub Apps — REST API](https://docs.github.com/en/rest/apps)
    - [Webhook events — `installation`, `installation_repositories`](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
    - [Authenticating as a GitHub App installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- Related specs:
    - [`auth-jwt-oauth`](../auth-jwt-oauth/spec.md) — the platform's
      session-issuance contract that this integration plugs into.
    - [`agent-zero-friction-onboarding`](../agent-zero-friction-onboarding/spec.md)
      — the higher-level onboarding flow that consumes the
      installation + repo lists.
    - [`work-import`](../work-import/spec.md) — the consumer of
      `WorkImportService.onboardLinkedRepository`.
    - [`integrations-twenty-crm`](../integrations-twenty-crm/spec.md)
      — sibling integration with the same `apps/api/integrations/`
      module pattern.

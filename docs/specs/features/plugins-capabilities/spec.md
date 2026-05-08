# Feature Specification: Plugins Capabilities (HTTP Surface)

**Feature ID**: `plugins-capabilities`
**Branch**: `docs/spec-plugins-capabilities`
**Status**: `Implemented`
**Created**: 2026-05-08
**Last updated**: 2026-05-08
**Owner**: Ever Works Team

---

## 1. Overview

The `plugins-capabilities` HTTP surface exposes the platform's six capability
families — **deploy**, **search**, **screenshot**, **oauth**, **git-provider**,
**device-auth** — to authenticated users through `/api/<capability>/*`
endpoints. Each sub-module is a thin HTTP shell that resolves the right
plugin via the matching agent-package facade, applies a four-level settings
cascade (work → user → admin → environment), validates the user's
permission against the work, and returns an envelope with `status: 'success'
| 'pending' | 'partial' | 'error'`. The plugin system itself is documented
in [`plugin-system`](../plugin-system/spec.md); this feature pins the user-facing
HTTP contract on top of it.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** I have configured Tavily as my search provider, **when** I
  `POST /api/search/`, **then** results from Tavily are returned with the
  provider name in the envelope.
- **Given** I have a Vercel deploy token configured for my work,
  **when** I `POST /api/deploy/works/:id`, **then** the website
  deployment is dispatched, the verifier polls until it reaches a
  terminal state, and an activity-log entry pins the dispatch with
  `actionType: DEPLOYMENT, action: 'work.deployed'`.
- **Given** I have OAuth-connected my GitHub account, **when** I
  `GET /api/git-providers/github/repositories?page=1&perPage=30`, **then**
  the response is a paginated list of repositories with the user's
  permissions on each.
- **Given** I have a screenshot plugin enabled (e.g. ScreenshotOne) and
  configured for my work, **when** I `POST /api/screenshot/capture`,
  **then** the response carries either a `cacheUrl` (provider-hosted) or a
  base64-encoded `imageBase64` payload.
- **Given** I want to connect a new OAuth provider, **when** I
  `GET /api/oauth/:providerId/connect/url`, **then** the response carries a
  ready-to-redirect authorization URL with state.
- **Given** a plugin requires device-auth (e.g. Claude Code OAuth),
  **when** I `POST /api/device-auth/:pluginId/start`, **then** the response
  carries the device-flow code and verification URL the user needs to
  paste into the provider's UI.

### 2.2 Edge cases & failures

- **Given** no search plugin has all required settings filled,
  **when** I `GET /api/search/check-availability`, **then** the response
  is `{available: false, activeProvider: null, message: <reason>}` —
  the message distinguishes "none enabled" from "enabled but
  unconfigured".
- **Given** I am NOT the work creator AND the work owner has not
  configured a deploy token, **when** I `POST /api/deploy/works/:id`,
  **then** I get a `BadRequest` with the message `"The work owner has
not configured <Provider> credentials."` (i.e. the message points at
  the owner, not at me).
- **Given** the deploy verifier hits its 13-minute hard cap with no
  terminal state from the provider, **when** the timeout fires, **then**
  the verifier emits `DeploymentFailedEvent` with `terminalState:
'TIMEOUT'`, persists `deploymentState: 'TIMEOUT'`, and the
  `ActivityLogListener` records a failed entry.
- **Given** I trigger a second deploy for the same work while a
  verification poll is still in flight, **when** `startVerification`
  fires, **then** the prior verifier is cancelled (`CANCELED` terminal
  event emitted exactly once via the `terminated` idempotency guard) and
  a fresh poll loop replaces it in the in-memory queue.
- **Given** the GitHub workflow dispatch fails on the first attempt,
  **when** `dispatchWithRetry` runs, **then** the service updates the
  website repository, writes a `.deployment-trigger` file, commits +
  pushes, waits 3 seconds, and retries each candidate workflow filename;
  if both passes fail, the controller returns `BadRequest` and NO
  `DeploymentDispatchedEvent` is emitted.
- **Given** a screenshot capture returns `success: false` from the
  provider, **when** the controller runs, **then** it throws
  `BadRequest` with the provider's `error` field (or `"Failed to capture
screenshot"` fallback) — the response is NEVER `{success: false}`
  inside a 200.
- **Given** my OAuth callback `code` is missing or empty, **when** I
  `GET /api/oauth/:providerId/callback/plugins?state=…`, **then** the
  controller returns `BadRequest` with `{status: 'error', message:
'Authorization code is required'}` BEFORE any service call.
- **Given** I request `/api/git-providers/:providerId/user` and my OAuth
  token has been revoked upstream, **when** `getUser` throws, **then**
  the controller returns `{success: false, error: <message>}` inside a
  200 (NOT a 4xx) — the success/error envelope is the contract.
- **Given** a batch deploy with 7 works, **when** `POST /api/deploy/batch`
  runs, **then** the service runs them in two rolling batches of 5 with
  a 2-second sleep between batches; the controller returns `status:
'success' | 'partial' | 'error'` based on the success/fail counts.

## 3. Functional Requirements

### 3.1 Cross-cutting

- **FR-1** Every endpoint under `/api/{deploy,search,screenshot,oauth,git-providers,device-auth}/*`
  MUST be wrapped by the global `AuthSessionGuard` and resolve the user
  via the `@CurrentUser()` decorator.
- **FR-2** Every endpoint MUST return one of the four envelope shapes:
  `{status: 'success', …}`, `{status: 'pending', …}`,
  `{status: 'partial', …}`, or `{status: 'error', message: …}`
  (the last one inside a `BadRequestException` body).
- **FR-3** Every controller MUST delegate provider resolution to its
  matching agent-package facade (`DeployFacadeService`,
  `SearchFacadeService`, `ScreenshotFacadeService`, `OAuthFacadeService`,
  `GitFacadeService`) and the per-user `PluginRegistryService` /
  `PluginSettingsService` — controllers MUST NOT reach into a specific
  plugin directly except through the registry.
- **FR-4** Every facade lookup MUST honour the four-level settings
  cascade: **work → user → admin → environment**, with environment
  variables resolved via the `x-envVar` extension on the JSON Schema.
  Settings flagged `x-secret: true` MUST NOT be returned in any
  response or activity-log entry.
- **FR-5** Endpoints that touch a specific work MUST validate ownership
  via `WorkOwnershipService.ensureCanEdit` (mutating) or `.ensureCanView`
  (read-only) BEFORE the service call. If the user is NOT the creator,
  facade calls MUST be made with `userId = work.user.id` (the owner's
  scope), not the caller's `userId`.

### 3.2 Deploy (`/api/deploy/*`)

- **FR-6** `GET /api/deploy/providers` MUST return
  `{status, providers: getAvailableProvidersForUser(userId)}` —
  per-user list (not the global registry).
- **FR-7** `GET /api/deploy/providers/:providerId/configured` MUST
  return a four-flag envelope: `{configured, available, enabled,
message}` distinguishing _provider not registered_, _registered but
  disabled_, and _enabled but missing settings_.
- **FR-8** `POST /api/deploy/works/:id` MUST run the chain
  `ensureCanEdit → isConfigured → validateToken → deploy →
startVerification → activityLogService.log({action: 'work.deployed'})`.
  Failure at any step short-circuits with a `BadRequest`.
- **FR-9** `POST /api/deploy/works/:id` MUST emit a fire-and-forget
  activity-log entry with `actionType: DEPLOYMENT, action:
'work.deployed', status: COMPLETED, summary: 'Triggered deployment for
<work.name> via <providerName>'` ONLY when `deploymentInitiated ===
true`.
- **FR-10** The deploy service MUST set the four required GitHub Actions
  secrets on every dispatch (`TENANT_ID = work.id`, `DATA_REPOSITORY =
work.getDataRepo()`, `<PROVIDER>_TOKEN = deployToken`, `DEPLOY_TOKEN =
deployToken`) and one repository variable (`DEPLOY_PROVIDER =
work.deployProvider || 'vercel'`). `DEPLOY_PROVIDER` is set as a
  variable, not a secret, because GitHub Actions templates need it
  available in `if:` conditions.
- **FR-11** The deploy service MUST set two optional secrets when their
  inputs are non-empty: `DEPLOY_TEAM_SCOPE = teamScope` and `GH_TOKEN =
gitToken`.
- **FR-12** The deploy service MUST always generate and set a fresh
  `CRON_SECRET` (32 bytes, hex-encoded) on every dispatch — the existing
  value is replaced, not preserved.
- **FR-13** The deploy service MUST call the optional plugin contract
  `plugin.getDeploymentSecrets(settings)` if defined; the returned
  `Record<string, string>` MUST be pushed as additional GitHub Actions
  secrets. Failure inside `getDeploymentSecrets` MUST be caught and
  logged; it MUST NOT abort the dispatch.
- **FR-14** The deploy service MUST resolve the workflow filenames to
  dispatch via `plugin.getWorkflowFilenames()` if defined, falling back
  to `['deploy_prod.yaml']` for legacy plugins. Each filename is tried
  in order; the first successful dispatch wins.
- **FR-15** When the first dispatch pass fails, the deploy service MUST
  update the website repository via `WebsiteUpdateService.updateRepository`,
  write `.deployment-trigger` (file content: a single ISO-timestamp
  line), commit + push it, wait 3 000 ms, then retry the dispatch loop
  exactly once.
- **FR-16** On successful dispatch, the deploy service MUST emit
  `DeploymentDispatchedEvent` with payload `{work, userId, providerId,
providerName: plugin.providerName ?? plugin.name ?? plugin.id}`. On
  failure, NO event is emitted.
- **FR-17** `POST /api/deploy/batch` MUST run `ensureCanEdit` for each
  item BEFORE calling the service, run the underlying deploys in
  rolling batches of `MAX_CONCURRENT = 5` with a `2 000 ms` sleep
  between batches, then start verification for every result whose
  `status === 'pending'`.
- **FR-18** `POST /api/deploy/batch` MUST emit a single fire-and-forget
  activity-log entry with `action: 'deployment.batch_started', summary:
'Triggered batch deploy for <N> works', details: {workIds: [...]}`
  regardless of per-work outcome.
- **FR-19** `POST /api/deploy/batch` MUST coerce the response status
  from the success/fail counts: `failed === 0` → `'success'`;
  `successfullyStarted > 0` → `'partial'`; otherwise → `'error'`.
- **FR-20** The deployment verifier MUST poll
  `deployFacade.lookupExistingDeployment` every 10 seconds, with two
  hard caps: `FETCH_LIMIT = 18` consecutive `found: false` responses
  before declaring `TIMEOUT`, and a wall-clock cap of 13 minutes.
- **FR-21** The deployment verifier MUST persist intermediate
  `deploymentState` values (`INITIALIZING`, `BUILDING`, `QUEUED`, …)
  via `WorkRepository.update` and the resolved `website` URL on every
  poll cycle that returns one.
- **FR-22** The deployment verifier MUST emit exactly one terminal
  event per verification run: `DeploymentCompletedEvent` for `'READY'`;
  otherwise `DeploymentFailedEvent` with `terminalState ∈ {'ERROR',
'TIMEOUT', 'CANCELED', 'UNKNOWN'}`. The `terminated` boolean guard
  prevents duplicate emissions when `cancel()` and a poll resolution
  race.
- **FR-23** When `startVerification` is called for a work that already
  has an active poller in `queue`, the active poller MUST be cancelled
  (emitting `CANCELED`) before the new one is registered.
- **FR-24** The deploy controller's domain endpoints (`GET/POST/DELETE`
  `/works/:id/domains[/:domain[/verify]]`) MUST short-circuit with a
  `BadRequest` when `work.website` is empty (i.e. before any
  `deployFacade.*Domain` call), with the message `"No deployment exists
for this work. Deploy first before managing domains."`.
- **FR-25** The deploy controller's `addDomain` body MUST validate the
  `domain` field against the regex
  `/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/`
  and reject malformed input with `BadRequest` BEFORE controller code
  runs.

### 3.3 Search (`/api/search/*`)

- **FR-26** `GET /api/search/check-availability` MUST resolve the
  `activeProvider` by enumerating SEARCH-capability plugins via
  `pluginRegistry.getEnabledPluginsScoped(SEARCH, undefined, userId)`,
  sorting `defaultForCapabilities`-first, and returning the FIRST
  plugin whose required settings are all populated.
- **FR-27** Required-settings checks MUST skip fields flagged
  `x-envVar` or `x-adminOnly` and treat `undefined`/`null`/`""` as
  missing.
- **FR-28** `GET /api/search/check-availability` MUST distinguish two
  failure messages: `"Search plugins are enabled but none have all
required settings configured (e.g. API key)."` (some enabled, none
  configured) and `"No search provider is enabled. Enable a search
plugin (e.g. Tavily, Linkup, Brave, Exa) in settings."` (none
  enabled).
- **FR-29** `POST /api/search/` MUST run `resolveConfiguredProvider`
  BEFORE forwarding to `searchFacade.search`, throwing a `BadRequest`
  with `"No search provider with all required settings configured is
available."` if no provider resolves.
- **FR-30** `POST /api/search/` MUST forward the resolved provider via
  `providerOverride` so the facade short-circuits its own resolution
  step.
- **FR-31** `searchFacade.search` errors of type `NoProviderError`
  MUST be remapped to `"No search provider configured. Enable a search
plugin in settings."` with status `'error'`. All other Errors MUST
  surface their `message`; non-Error throws MUST coerce to
  `"Search failed"`.

### 3.4 Screenshot (`/api/screenshot/*`)

- **FR-32** `GET /api/screenshot/check-availability?workId=…` MUST
  enumerate all enabled SCREENSHOT plugins (scoped by `workId` if
  provided), evaluate each one's configured-status against fully
  resolved settings, and return them as `ProviderOption[]` with `available`
  true iff at least one is configured.
- **FR-33** Provider list ordering MUST be the three-tier sort:
  default-first (active per `getDefaultForCapabilityScoped`, else
  `defaultForCapabilities` flag, else `systemPlugin`), configured-second,
  alphabetical-by-name third.
- **FR-34** `activeProvider` MUST resolve as: matching the active
  plugin id → matching the `isDefault` flag → `null`.
- **FR-35** `POST /api/screenshot/capture` MUST short-circuit with
  `BadRequest` `"No screenshot provider configured"` when no provider
  in the resolved list is configured.
- **FR-36** `POST /api/screenshot/capture` MUST forward the full DTO
  (`url`, viewport sizing, `format`, `fullPage`, `delay`, ad/tracker/cookie
  blocks) plus `{userId, workId, providerOverride}` context to
  `screenshotFacade.capture`.
- **FR-37** `POST /api/screenshot/capture` MUST prefer
  `result.cacheUrl` over `result.imageUrl` when constructing the
  response `imageUrl`. When `result.imageBuffer` is present, return
  `imageBase64 = result.imageBuffer.toString('base64')`; otherwise
  `imageBase64: null`.
- **FR-38** `POST /api/screenshot/capture` MUST remap `NoProviderError`
  to `"No screenshot provider configured or available"` and rethrow
  every other error unchanged.
- **FR-39** `POST /api/screenshot/get-url` MUST follow the same
  resolution + error-mapping contract as `capture`, but return only
  `{status, imageUrl}` and reject `null`/empty `imageUrl` with a
  `BadRequest` `"Failed to generate screenshot URL"`.

### 3.5 OAuth (`/api/oauth/*`)

- **FR-40** `GET /api/oauth/providers` MUST return `{configured:
oauthFacade.isConfigured(), providers: getAvailableProviders()}` so
  the UI can grey out disabled providers.
- **FR-41** `GET /api/oauth/:providerId/connection` MUST resolve the
  user's connected provider account via
  `AuthAccountRepository.findConnectedProviderAccount(userId, providerId,
{usePluginProviderId: true})`, and validate the cached `accessToken`
  by calling `oauthFacade.getAuthenticatedUser(providerId, accessToken)`.
  Failure to resolve a user MUST coerce to `connected: false` (NOT a
  4xx).
- **FR-42** `connectionSource` MUST be derived from the account's
  `providerId` prefix: `plugin:` → `'plugin'`, otherwise `'social'`.
- **FR-43** `GET /api/oauth/:providerId/connect/url` MUST generate a
  16-byte hex `state` when none is supplied, resolve OAuth credentials
  from plugin settings (clientId, clientSecret, redirectUri, scopes),
  and reject with `BadRequest` when `clientId` or `clientSecret` is
  absent.
- **FR-44** `forceConsent` MUST be parsed strict-`'true'`: only the
  literal string `'true'` enables it; `'false'`/`''`/`undefined`/`'TRUE'`
  all map to `false`.
- **FR-45** `GET /api/oauth/:providerId/callback/plugins` MUST short-
  circuit with `BadRequest` `"Authorization code is required"` BEFORE
  any service call when `code` is missing or empty.
- **FR-46** `handleOAuthCallback` MUST upsert the resolved
  `AuthAccount` row with `providerId = buildPluginProviderId(providerId)`
  (i.e. with the `plugin:` prefix), `accountId = oauthUser.id`, and
  populate `accessToken`, `refreshToken`, `tokenType`, `scope`,
  `accessTokenExpiresAt = now + expiresIn * 1000`, `email`, `username`,
  `metadata: {oauthUserId, name, avatarUrl}`.
- **FR-47** `DELETE /api/oauth/:providerId` MUST return 204-style
  `undefined` on success; the OAuth facade is expected to revoke the
  upstream token.
- **FR-48** Any service-layer error in `getOrganizations` /
  `getRepositories` / `getUser` / `disconnectProvider` MUST be wrapped
  into `{success: false, error: <message>}` inside a 200 response —
  these endpoints NEVER throw 4xx.

### 3.6 Git Provider (`/api/git-providers/*`)

- **FR-49** `GET /api/git-providers` MUST return `{configured:
gitFacade.isConfigured(), providers: getAvailableProviders()}`.
- **FR-50** `GET /api/git-providers/:providerId/connection` MUST
  resolve auth in two parallel branches: (a) OAuth via
  `AuthAccountRepository.findConnectedProviderAccount(usePluginProviderId:
true)`; (b) PAT via `gitFacade.hasValidCredentials({userId,
providerId})`. The user-resolution call differs by branch:
  OAuth-branch passes `{providerId, token: accessToken}`; PAT-branch
  passes `{userId, providerId}`. The response reports `authMethod`
  accordingly: `'oauth'` when an OAuth token is present (even if
  user-resolution fails), else `'personal-access-token'`.
- **FR-51** `GET /api/git-providers/:providerId/repositories` MUST
  parse `page` and `perPage` query params with `parseInt(_, 10)` each
  independently undefined-able, and forward them as the second/third
  positional arguments to `gitFacade.listRepositories`.
- **FR-52** Like the OAuth controller, every git-provider response
  endpoint MUST wrap service errors in `{success: false, error:
<message>}` inside a 200 — NEVER 4xx.

### 3.7 Device Auth (`/api/device-auth/*`)

- **FR-53** `GET /api/device-auth/:pluginId/status` and `POST
/api/device-auth/:pluginId/start` MUST be thin two-line passthroughs
  to `pluginOperationsService.getPluginDeviceAuthStatus(pluginId,
userId)` / `startPluginDeviceAuth(pluginId, userId)` respectively.
  Errors MUST propagate unwrapped.
- **FR-54** Both endpoints MUST forward `(pluginId, userId)` in
  positional order — NOT `(userId, pluginId)` — because the underlying
  service expects `pluginId` first.

## 4. Non-Functional Requirements

- **Performance**: provider resolution and settings cascade are
  in-memory after the first lookup per request via the
  `PluginRegistryService` cache. Search and screenshot capture latency
  is dominated by the upstream provider, not the resolver.
- **Reliability**: the deploy verifier survives short upstream
  outages: a single `lookupExistingDeployment` failure short-circuits
  to `cleanup('ERROR')`, but transient provider blips during the
  10-second poll window are absorbed by the next tick. The
  verification queue is in-memory only — process restarts cancel
  in-flight verifications (documented limitation; see Open Questions).
- **Security**:
    - All endpoints behind `AuthSessionGuard`; ownership enforced via
      `WorkOwnershipService` on every per-work mutation.
    - Plugin-supplied `getDeploymentSecrets` output is pushed into
      GitHub Actions secrets via `setActionSecret`, NEVER logged. Even
      the count is logged as a number, not the keys.
    - `CRON_SECRET` is regenerated on every deploy — old workflows
      cannot reuse stale values.
    - OAuth tokens persist in `auth_accounts.accessToken` /
      `refreshToken`; rotation is the OAuth provider's responsibility
      (we re-upsert on each successful exchange).
    - Domain regex on `addDomain` rejects path/scheme/whitespace
      payloads upfront.
- **Observability**:
    - Deploy: `DeploymentDispatchedEvent`, `DeploymentCompletedEvent`,
      `DeploymentFailedEvent` are emitted via NestJS `EventEmitter2`;
      the `ActivityLogListener` translates them into `actionType:
DEPLOYMENT` rows. The single `'work.deployed'` activity-log entry
      is emitted directly from the controller (fire-and-forget).
    - Search/screenshot/OAuth/git-provider/device-auth: NO activity-log
      emission (per-call CRUD-style traffic is too high-volume to audit).
    - Errors are logged via the per-service `Logger` with the work id
      and provider id where applicable.
- **Compatibility**: facade APIs are versioned via the `@ever-works/agent`
  package. New plugin contract methods (`getDeploymentSecrets`,
  `getWorkflowFilenames`) are optional — older plugins continue to
  work via the fallback paths.

## 5. Key Entities & Domain Concepts

| Entity / concept            | Description                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability                  | One of: `deploy`, `search`, `screenshot`, `oauth`, `git-provider`, `device-auth`. Maps 1:1 to a sub-module under `apps/api/src/plugins-capabilities/`.      |
| Capability facade           | Agent-package service that resolves the right plugin and orchestrates the call (`DeployFacadeService`, `SearchFacadeService`, …).                           |
| `RepoContext`               | `{owner, repo, token, publicKey}` bundle used by `DeployService` to push secrets/variables to a single GitHub repo.                                         |
| `RegisteredPlugin`          | Wrapper over a loaded plugin with manifest + state + plugin instance, returned by `PluginRegistryService`.                                                  |
| `ProviderOption`            | `{id, name, description, configured, isDefault, icon}` — the projected provider shape returned by `/check-availability`.                                    |
| `DeploymentReadyState`      | `'BUILDING' \| 'ERROR' \| 'INITIALIZING' \| 'QUEUED' \| 'READY' \| 'CANCELED' \| 'TIMEOUT'`. Authoritative for `work.deploymentState`.                      |
| `OAuthConnectionInfo`       | `{connected, providerId, username?, email?, avatarUrl?, connectionSource: 'plugin' \| 'social', authMethod?}` envelope returned by `/connection` endpoints. |
| `GitProviderConnectionInfo` | Same shape as `OAuthConnectionInfo`, plus `authMethod ∈ {'oauth', 'personal-access-token'}`.                                                                |
| `BatchDeployItemResultDto`  | `{workId, slug, status: 'pending' \| 'error', message, owner?, repository?}` per-work record returned in the batch envelope.                                |
| `BatchDeployResponseDto`    | `{status: 'success' \| 'partial' \| 'error', message, totalRequested, successfullyStarted, failed, results[]}`.                                             |
| `DeviceAuthStatus`          | `{state, userCode?, verificationUri?, expiresAt?, …}` envelope returned by the device-auth flow.                                                            |

## 6. Out of Scope

- The **plugin system itself** (registration, discovery, loading,
  settings cascade) — see [`plugin-system`](../plugin-system/spec.md).
- The **plugin-management HTTP surface** (`/api/plugins/*`) for
  enable/disable/configure operations — see the `plugins.controller`
  spec line in [`COVERAGE-TRACKER.md`](../../../../COVERAGE-TRACKER.md).
- The **content-extractor** capability — currently has no dedicated
  HTTP controller; surfaces via the work generation pipeline only.
- The **AI-provider / pipeline / prompt-provider** capabilities —
  surfaced via `apps/api/src/works/*` and `apps/api/src/plugins/*`,
  not under `plugins-capabilities/`.
- Persistent verification queue across restarts (current queue is
  in-memory; see OQ-3 for the planned migration).

## 7. Acceptance Criteria

- [x] All 6 capability sub-modules are mounted in `api.module.ts`
      (`DeployModule`, `SearchModule`, `ScreenshotModule`,
      `GitProviderModule`, `OAuthModule`, `DeviceAuthModule`).
- [x] All endpoints are protected by `AuthSessionGuard` and resolve
      the user via `@CurrentUser()`.
- [x] `WorkOwnershipService.ensureCanEdit` / `.ensureCanView` is the
      single source of truth for per-work permission gating.
- [x] Per-controller specs cover every endpoint: `deploy.service.spec`
      (capability contract), `search.controller.spec`,
      `screenshot.controller.spec`, `oauth.controller.spec` /
      `oauth.service.spec`, `git-provider.controller.spec` /
      `.service.spec`, `device-auth.controller.spec` /
      `.service.spec`.
- [x] Plugin-driven workflow filenames + plugin-driven extra deploy
      secrets ship behind the optional contract methods (`getWorkflowFilenames`,
      `getDeploymentSecrets`); legacy plugins fall back to defaults
      (`['deploy_prod.yaml']`, no extras).
- [x] `DeploymentDispatchedEvent` / `DeploymentCompletedEvent` /
      `DeploymentFailedEvent` are emitted via `EventEmitter2`; the
      `ActivityLogListener` is the only consumer the deploy services
      know about (no hard dependency on `ActivityLogService` from
      `DeployService` / `DeploymentVerifierService`).
- [x] Per-controller spec exists for the deploy controller (status:
      MISSING — see follow-up T-DEPLOY-CTRL).

## 8. Open Questions

- `[NEEDS CLARIFICATION: should the deploy verifier persist its
in-memory queue across API restarts via Trigger.dev so a redeploy
doesn't silently abandon in-flight verifications?]` — see OQ-3.
- `[NEEDS CLARIFICATION: should the OAuth/git-provider/device-auth
controllers ever return 4xx responses for downstream errors, or is
the `{success: false, error}`-in-200 envelope the canonical
contract?]` — current code is asymmetric (deploy/search/screenshot
  throw 4xx; OAuth/git-provider/device-auth wrap into 200).
- `[NEEDS CLARIFICATION: should the search endpoint expose
`providerOverride`from the DTO instead of always falling through
to`resolveConfiguredProvider`?]` — search currently has no
  per-call provider override; screenshot does.
- `[NEEDS CLARIFICATION: should the deploy controller emit a separate
activity-log entry on `validateToken` rejection so users can see
failed-credentials attempts in the audit trail?]` — currently no
  log entry until `deploymentInitiated === true`.
- `[NEEDS CLARIFICATION: should `/api/deploy/teams`(the workless
variant) be removed since it always returns`{teams: []}` and
redirects users to the work-specific endpoint?]` — see OQ-1.

## 9. Constitution Gates

- [x] **I (Plugin-first)**: every capability is implemented via plugins
      under `packages/plugins/`. Controllers are thin shells over
      facades; no provider-specific logic leaks into `apps/api/`.
- [x] **II (Capability-driven resolution)**: every endpoint resolves
      through a facade + the `PluginRegistryService` capability lookup.
- [x] **III (Source-of-truth repos)**: deploy writes via `WebsiteUpdateService`
      to the website repo; OAuth/git-provider write to `auth_accounts`
      (not user repos).
- [x] **IV (Long-running work via Trigger.dev)**: NOT applied here —
      verification is in-memory polling. Flagged in OQ-3 for future
      migration to a durable Trigger.dev task.
- [x] **V (Schema changes ship as forward-only migrations)**: no
      schema changes — `auth_accounts` and `works` already exist.
- [x] **VI (Tests accompany the change)**: 5 controller specs + 4
      service specs ship with this surface; deploy controller spec is
      flagged as a follow-up.
- [x] **VII (Secrets handled per `x-secret` rules)**: plugin settings
      with `x-secret: true` are read with `includeSecrets: true` only
      on the server, never echoed in responses; deploy-time
      provider-supplied extras (`getDeploymentSecrets`) are pushed
      into GitHub Actions secrets via the GitHub plugin's
      libsodium-encrypted `setActionSecret`, never logged.
- [x] **VIII (Plugin counts touch the canonical doc only)**: not
      applicable — this spec discusses the HTTP surface, not the plugin
      catalog.
- [x] **IX (Behaviour-first)**: §§ 1–4 are observable behaviour;
      implementation details (exact class names, file paths, package
      mappings) live in `plan.md`.
- [x] **X (Backwards-compatible API/SDK/schema changes)**: optional
      plugin contract methods (`getWorkflowFilenames`, `getDeploymentSecrets`)
      preserve compatibility with older plugins.

## 10. References

- Implementation: [`apps/api/src/plugins-capabilities/`](../../../../apps/api/src/plugins-capabilities/)
- Related feature: [`plugin-system`](../plugin-system/spec.md) (registry, discovery, settings cascade)
- Related feature: [`auth-jwt-oauth`](../auth-jwt-oauth/spec.md) (`AuthSessionGuard`, `AuthAccountRepository`)
- Related feature: [`activity-log`](../activity-log/spec.md) (`ActivityLogListener` for deploy events)
- Related feature: [`integrations-github-app`](../integrations-github-app/spec.md) (alternative GitHub auth path)
- Constitution: [`.specify/memory/constitution.md`](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md)
- Coverage tracker: [`COVERAGE-TRACKER.md`](../../../../COVERAGE-TRACKER.md)

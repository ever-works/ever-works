# Feature Specification: Integrations — Twenty CRM

**Feature ID**: `integrations-twenty-crm`
**Branch**: `docs/spec-integrations-twenty-crm`
**Status**: `Retrospective`
**Created**: 2026-05-08
**Last updated**: 2026-05-08
**Owner**: Ever Works Team

---

## 1. Overview

The Twenty CRM integration lets the platform mirror its native domain
objects (clients, companies, items) to a self-hosted or cloud
[Twenty](https://twenty.com) CRM workspace via Twenty's REST API.
Once configured, authenticated platform users can drive
companies / contacts / deals / products through the integration's
HTTP surface (`/api/twenty-crm/companies`,
`/api/twenty-crm/people`), which proxies to the Twenty workspace's
`/rest` and `/rest/metadata` endpoints. The integration is gated by
three required environment variables (base URL, API key, workspace
id) — when any are missing the integration self-disables and the
`CrmSyncGuard` refuses any inbound request without surfacing the
internal error to clients.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** a workspace administrator has set
  `TWENTY_CRM_BASE_URL`, `TWENTY_CRM_API_KEY`, and
  `TWENTY_CRM_WORKSPACE_ID`, **when** the API process starts,
  **then** `CrmConfigService.isEnabled` returns `true` and
  `CrmSyncGuard.canActivate` returns `true` for any inbound request.
- **Given** I am signed in, **when** I `GET /api/twenty-crm/companies`,
  **then** the controller proxies to Twenty's
  `GET <apiUrl>/rest/companies` with the workspace's bearer token and
  workspace header, and returns the company list.
- **Given** I `POST /api/twenty-crm/companies` with a
  `TwentyOrganization` body, **when** the controller forwards the
  body, **then** Twenty returns the created organization with its
  generated `id`, and the controller relays it verbatim.
- **Given** I `PATCH /api/twenty-crm/companies/:id`, **when** Twenty
  applies the partial update, **then** the response body is the
  updated organization. (Note: the controller forwards via `PUT`
  internally — see OQ-3.)
- **Given** I `DELETE /api/twenty-crm/companies/:id`, **when** Twenty
  removes the row, **then** the controller returns the empty body
  Twenty replies with.
- **Given** the integration is enabled and an item-mapper is run,
  **when** `MappingUtils.mapClientToContact(client)` is invoked,
  **then** the first space-separated token of `client.name` becomes
  `firstName` and the rest becomes `lastName`.
- **Given** an `EverWorksItem` has no `currency`, **when**
  `MappingUtils.mapItemToProduct` or `mapItemToDeal` runs, **then**
  the resulting Twenty entity defaults to `currency: 'USD'`.
- **Given** an `EverWorksCompany` has a non-URL `website` field
  (e.g. `"acme.com"`), **when**
  `MappingUtils.mapCompanyToOrganization` runs, **then** the helper
  prepends `https://` before parsing so `domainName` is set to the
  hostname.
- **Given** the `TwentyCrmService` makes a request and Twenty
  responds with a 5xx, **when** wrapped by `RetryUtils.withRetry`,
  **then** the call retries up to `maxAttempts` times with
  exponential backoff at `delayMs * backoffMultiplier^(attempt-1)`.
- **Given** a tenant context resolver runs with a `workId`, **when**
  `CrmTenantService.resolveTenantContext(workId, userId)` is
  called, **then** `tenantId` is built as `work_<workId>` and the
  endpoint prefix is `/tenants/work_<workId>`.

### 2.2 Edge cases & failures

- **Given** any of the three required env vars is missing, **when**
  any controller endpoint is hit, **then** `CrmSyncGuard` returns
  `false` and the global guard layer answers `403 Forbidden` —
  the request never reaches `ClientService`.
- **Given** the env vars are present but `CrmConfigService.validateConfig`
  throws (e.g. blank-string-vs-undefined), **when** the guard catches
  the throw, **then** it logs `'CRM configuration validation failed'`
  via `logger.error` and returns `false`.
- **Given** Twenty responds with a `429`, **when**
  `RetryUtils.isRetryableError` evaluates the error, **then** it
  returns `true` and the retry loop fires another attempt.
- **Given** a request ECONNRESET / ETIMEDOUT / ENOTFOUND occurs,
  **when** `RetryUtils.isRetryableError` evaluates it, **then** the
  retry loop continues even though there is no `error.response`.
- **Given** Twenty returns a 4xx (other than 429), **when** the retry
  helper sees it, **then** `isRetryableError` returns `false` and the
  loop exits with the original error.
- **Given** the `withRetry` loop runs `maxAttempts=1` (the test-mode
  default), **when** the first call throws, **then** the helper does
  NOT sleep before re-throwing the original error.
- **Given** Twenty returns no body on error (network timeout, DNS
  failure), **when** `TwentyCrmService.makeRequest` catches the
  thrown axios error, **then** the service logs the event and
  re-throws as `HttpException("Failed to communicate with Twenty CRM",
  503)`.
- **Given** Twenty returns an error body with `message`, `statusCode`,
  and optional `details`, **when** `makeRequest` catches it, **then**
  the service throws
  `HttpException({message, details}, error.response.status ?? 500)`.
- **Given** the Twenty error body's `message` is missing, **when**
  `makeRequest` builds the wrapped exception, **then** the fallback
  message `'Twenty CRM API error'` is used.
- **Given** an integration consumer hits an endpoint with
  `schema: true`, **when** `makeRequest` builds the URL, **then** it
  uses `${apiUrl}/rest/metadata${endpoint}` instead of
  `${apiUrl}/rest${endpoint}`.
- **Given** `workspaceId` is the empty string, **when**
  `makeRequest` reads the `X-Workspace-Id` header, **then** the
  default `'default'` is sent (the falsy short-circuit
  `workspaceId || 'default'` triggers).
- **Given** `MappingUtils.mapClientToContact` runs against an
  `EverWorksClient` whose `name` is a single token (e.g. "Madonna"),
  **when** `split(' ')` returns one element, **then** `firstName` is
  set to that token and `lastName` is `''`.
- **Given** `MappingUtils.validateContactData` checks a contact with
  no name fields and no email, **when** it runs, **then** it returns
  both `'Either firstName or lastName is required'` and `'Email is
  required'`.
- **Given** an `EverWorksCompany.website` is malformed
  (`'not-a-url'` even after https-prefix), **when**
  `extractDomainFromWebsite` parses, **then** the `URL` constructor
  throws and the helper returns `undefined`.
- **Given** `CrmTenantService.resolveTenantContext` is called with no
  `workId` and no `globalTenantId`, **when** it builds `tenantId`,
  **then** it falls back to the literal `'global_everworks'`.
- **Given** `CrmTenantService.validateTenantContext` is called with a
  context whose `tenantId` is empty/undefined, **when** it logs,
  **then** it emits `'Tenant ID is required'` via `logger.error` and
  returns `false`.
- **Given** the `PeopleController` receives a `POST` body with extra
  fields beyond the documented contact shape, **when** the controller
  forwards to `clientService.createContact`, **then** ONLY the
  whitelisted fields (`firstName`, `lastName`, `email`, `phone`,
  `companyId`, `position`, `avatarUrl`) are forwarded — extra keys
  are silently dropped via the explicit object construction.
- **Given** the `CompaniesController` receives a `POST` body, **when**
  the controller forwards, **then** the full object is passed
  through verbatim (no whitelist) — this divergence is documented
  in OQ-4.

## 3. Functional Requirements

- **FR-1** The integration MUST be globally registered as a Nest
  `@Global()` module via `TwentyCrmModule.forRoot()` /
  `forRootAsync()` so `TwentyCrmService`, `ClientService`,
  `CrmTenantService`, and `CrmConfigService` are exported and
  injectable from any other module.
- **FR-2** `CrmConfigService.twentyCrmConfig` MUST return the live
  `(apiUrl, apiKey, workspaceId, timeout, retryAttempts, retryDelay)`
  tuple read from `ConfigService` (env vars
  `TWENTY_CRM_BASE_URL`, `TWENTY_CRM_API_KEY`,
  `TWENTY_CRM_WORKSPACE_ID`, `TWENTY_CRM_TIMEOUT_MS` (default
  30000), `TWENTY_CRM_MAX_RETRIES` (default 3),
  `TWENTY_CRM_RETRY_DELAY_MS` (default 1000)).
- **FR-3** `CrmConfigService.isEnabled` MUST evaluate
  `!!(apiUrl && apiKey && workspaceId)` — empty strings count as
  falsy.
- **FR-4** `CrmConfigService.validateConfig` MUST throw
  `Error('Missing required Twenty CRM configuration: <list>')` when
  any of the three required keys is missing, listing each missing
  key by its env-var name; otherwise it MUST return `true`.
- **FR-5** `CrmSyncGuard.canActivate` MUST short-circuit to `false`
  with `logger.warn('CRM integration is disabled - request blocked')`
  when `isEnabled` is `false`; MUST call `validateConfig`; MUST
  return `false` with `logger.error('CRM configuration validation
  failed:', err)` on any throw; MUST return `true` only when both
  pass.
- **FR-6** The `@CrmSync(enabled?: boolean)` decorator MUST set the
  `crm_sync` Nest metadata key with the supplied `enabled` flag
  (default `true`).
- **FR-7** `TwentyCrmService.makeRequest(method, endpoint, data?,
  params?, schema?)` MUST: build the URL as
  `${apiUrl}/rest${endpoint}` (or `${apiUrl}/rest/metadata${endpoint}`
  when `schema === true`); set headers
  `Authorization: Bearer <apiKey>`,
  `Content-Type: application/json`,
  `X-Workspace-Id: <workspaceId || 'default'>`; honour the configured
  `timeout`; log `Making <method> request to <url>` at debug; return
  `response.data`.
- **FR-8** When the request throws, `TwentyCrmService.makeRequest`
  MUST log `'Twenty CRM API error: <msg>'` with the
  `{endpoint, method, status, data}` context; if
  `error.response.data` is set, throw
  `HttpException({message: data.message ?? 'Twenty CRM API error',
  details: data.details}, error.response.status ?? 500)`; else
  throw `HttpException('Failed to communicate with Twenty CRM',
  HttpStatus.SERVICE_UNAVAILABLE)`.
- **FR-9** `ClientService` MUST expose 16 thin-wrapper methods —
  `create`/`get`/`update`/`delete` for each of the four entity types
  (`company`, `contact`, `deal`, `product`) plus four list
  endpoints (`getCompanies`, `getContacts`, `getDeals`,
  `getProducts`) — each delegating to `TwentyCrmService.makeRequest`
  with the appropriate `(method, endpoint[, body])` tuple.
- **FR-10** All `ClientService.create*` methods MUST `POST` to
  `/<plural-entity>`, `get*(id)` MUST `GET /<plural-entity>/:id`,
  `update*(id, body)` MUST `PUT /<plural-entity>/:id`, and
  `delete*(id)` MUST `DELETE /<plural-entity>/:id` with no body.
- **FR-11** `CompaniesController` MUST be guarded by
  `AuthSessionGuard` (`@UseGuards(AuthSessionGuard)` at the class
  level) so only signed-in users can drive it. The `PeopleController`
  is currently NOT guarded — see OQ-1.
- **FR-12** `CompaniesController` MUST expose
  `GET /api/twenty-crm/companies`,
  `POST /api/twenty-crm/companies`,
  `PATCH /api/twenty-crm/companies/:id`,
  `DELETE /api/twenty-crm/companies/:id` and MUST forward the
  request to the appropriate `ClientService` method.
- **FR-13** `PeopleController` MUST expose
  `GET /` (path is currently mounted as the bare class —
  see OQ-1 and the duplicated controller path in OQ-2),
  `POST /`, `PATCH /:id`, `DELETE /:id`. On `POST`, the
  controller MUST explicitly project the body into
  `{firstName, lastName, email, phone, companyId, position,
  avatarUrl}` — extra keys MUST be dropped at the boundary.
- **FR-14** `CrmTenantService.resolveTenantContext(workId?, userId?,
  globalTenantId?)` MUST set `tenantId = workId ? \`work_${workId}\` :
  globalTenantId || 'global_everworks'`, log the resulting context at
  debug, and return `{tenantId, workId, userId}`.
- **FR-15** `CrmTenantService.getTenantEndpointPrefix(ctx)` MUST
  return `/tenants/${ctx.tenantId}` so callers can build
  multi-tenant URLs.
- **FR-16** `CrmTenantService.validateTenantContext(ctx)` MUST
  return `false` (with `logger.error('Tenant ID is required')`)
  when `tenantId` is falsy, otherwise `true`.
- **FR-17** `CrmTenantService.getTenantConfig(ctx)` MUST return a
  flattened `{tenantId, workId, userId}` object — preserving
  `undefined` values rather than stripping them.
- **FR-18** `RetryUtils.withRetry(fn, maxAttempts=3, delayMs=1000,
  backoffMultiplier=2)` MUST run `fn()` once per attempt, sleep
  `delayMs * backoffMultiplier^(attempt-1)` between attempts, and
  re-throw the LAST error after exhausting attempts. The helper MUST
  NOT sleep when `maxAttempts === 1`.
- **FR-19** `RetryUtils.isRetryableError` MUST return `true` for
  `error.code in {ECONNRESET, ETIMEDOUT, ENOTFOUND}`, for
  `error.response.status >= 500`, and for `error.response.status ===
  429`. All other shapes MUST return `false`.
- **FR-20** `RetryUtils.calculateRetryDelay(baseDelayMs, attempt,
  backoffMultiplier=2, maxDelayMs=30000)` MUST compute
  `baseDelayMs * backoffMultiplier^(attempt-1)`, add 10% jitter
  (`Math.random() * 0.1 * delay`), and clamp the result via
  `Math.min(delay + jitter, maxDelayMs)`.
- **FR-21** `MappingUtils.mapClientToContact` MUST split
  `client.name` on the first space — `firstName` is the first token
  (or `''` if the name is empty), `lastName` is the rest joined by a
  single space (or `''`). Email/phone/position/companyId pass
  through unchanged.
- **FR-22** `MappingUtils.mapCompanyToOrganization` MUST set
  `name: company.name`, `employees: company.size`, and
  `domainName: extractDomainFromWebsite(company.website)`.
  `extractDomainFromWebsite` MUST `URL`-parse the input (after
  prepending `https://` if it doesn't start with `http`); on parse
  failure it MUST return `undefined`.
- **FR-23** `MappingUtils.mapItemToProduct` MUST set
  `currency: item.currency || 'USD'` and pass through
  `name`/`description`/`price`/`category`.
- **FR-24** `MappingUtils.mapItemToDeal` MUST set
  `title: item.name`, `amount: item.price`,
  `currency: item.currency || 'USD'`, `stage: 'NEW'`,
  `probability: 50`, and pass through `companyId` / `personId`
  (`item.clientId`).
- **FR-25** Every `validate*Data` helper MUST return an array of
  human-readable error strings — empty when the entity is valid,
  populated when required fields are missing.
  `validateContactData` requires `(firstName || lastName)` AND
  `email`. `validateOrganizationData` requires `name`.
  `validateProductData` requires `name`. `validateDealData` requires
  `title`.

## 4. Non-Functional Requirements

- **Performance**: HTTP requests MUST honour `TWENTY_CRM_TIMEOUT_MS`
  (default 30 s). Retry-back-off is exponential with 10% jitter to
  avoid synchronised retry storms across replicas.
- **Reliability**: Network failures (ECONNRESET / ETIMEDOUT /
  ENOTFOUND), 5xx, and 429 are retryable. 4xx (other than 429) are
  fatal. The retry loop MUST always re-throw the LAST attempt's
  error rather than the FIRST.
- **Security & privacy**: API keys are read from environment
  variables only — never echoed in responses, never logged. The
  bearer token is set in the request header by
  `TwentyCrmService` itself, not the caller. Cross-tenant data leak
  is prevented by `CrmTenantService` — the `tenantId` is always
  derived from the caller-supplied `workId` / `userId`.
- **Observability**: `TwentyCrmService` logs every request at
  `debug` (`Making <method> request to <url>`); errors at `error`
  with `{endpoint, method, status, data}`. `CrmSyncGuard` logs the
  disabled / config-failure paths at `warn` / `error`.
- **Compatibility**: Twenty CRM REST v0.x — the integration uses
  Twenty's `/rest` and `/rest/metadata` endpoints. Twenty workspaces
  on different versions may diverge; the integration is pinned to
  the documented schema by the `Twenty<Entity>` types in
  `types/twenty-crm.types.ts`.

## 5. Key Entities & Domain Concepts

| Entity / concept           | Description                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `TwentyContact`            | Twenty CRM person — `firstName`, `lastName`, `email`, `phone`, `position`, `companyId`, `avatarUrl`, plus standard `id`/timestamps.   |
| `TwentyOrganization`       | Twenty CRM company — `name`, `domainName`, `address`, `employees`, `linkedinUrl`, `xUrl`, `annualRecurringRevenue`, `idealCustomerProfile`. |
| `TwentyProduct`            | Twenty CRM product — `name`, `description`, `price`, `currency`, `category`.                                                         |
| `TwentyDeal`               | Twenty CRM deal — `title`, `amount`, `currency`, `stage`, `probability`, `companyId`, `personId`.                                    |
| `EverWorksClient`          | Platform-side client/customer — `name` (single field, split at the boundary), `email`, `phone`, `companyId`, `position`.             |
| `EverWorksCompany`         | Platform-side company — `name`, `website`, `description`, `industry`, `size`.                                                       |
| `EverWorksItem`            | Platform-side item — `name`, `description`, `price`, `currency`, `category`, `companyId`, `clientId`.                                |
| `CrmTenantContext`         | `(tenantId, workId?, userId?)` — derived by `CrmTenantService.resolveTenantContext` and consumed by tenant-aware callers.           |
| `CrmConfigService`         | Reads `TWENTY_CRM_*` env vars; gates the integration via `isEnabled`.                                                                |
| `CrmSyncGuard`             | Nest guard that refuses the request when `isEnabled` is false or `validateConfig` throws.                                            |
| `@CrmSync(enabled?)`       | Decorator that stamps the `crm_sync` metadata key. Currently informational — no consumer reads it (see OQ-5).                       |
| `RetryUtils.withRetry`     | Retry helper: exponential back-off with last-error re-throw.                                                                         |
| `MappingUtils`             | EverWorks → Twenty wire-format mappers + `validate*Data` helpers.                                                                     |

## 6. Out of Scope

- Writing back from Twenty into the platform — this integration is
  push-only.
- Webhook receivers from Twenty for two-way sync.
- Twenty workspace bootstrapping (creating the workspace, schema
  migrations, seed data) — the integration assumes a pre-provisioned
  workspace.
- Field-level access control / audit logging beyond Nest's standard
  request logger.
- Multi-workspace support (a single platform process today maps to
  a single Twenty workspace via the `TWENTY_CRM_WORKSPACE_ID` env
  var). Multi-tenant via `CrmTenantService` is for endpoint-prefix
  modelling, NOT multi-workspace fan-out.
- Bulk-import endpoints — the controllers are per-row CRUD only.
- Rate-limit-aware queueing — the retry helper covers transient
  429s but does not back off globally on sustained throttling.

## 7. Acceptance Criteria

- [ ] Setting all three env vars (`TWENTY_CRM_BASE_URL`,
      `TWENTY_CRM_API_KEY`, `TWENTY_CRM_WORKSPACE_ID`) flips
      `isEnabled` to `true`.
- [ ] Removing any one env var causes `CrmSyncGuard.canActivate` to
      return `false` and `validateConfig` to throw with the missing
      key listed.
- [ ] `GET / POST / PATCH / DELETE /api/twenty-crm/companies[/:id]`
      proxy correctly to Twenty.
- [ ] `POST /api/twenty-crm/people` strips extra body fields,
      forwarding only the whitelisted contact shape.
- [ ] `RetryUtils.withRetry(fn, 3)` retries 3 times, sleeping
      1s / 2s / (no-sleep on the final throw); the last error is
      surfaced.
- [ ] `RetryUtils.isRetryableError` returns `true` for ECONNRESET /
      ETIMEDOUT / ENOTFOUND / 5xx / 429 and `false` for everything
      else.
- [ ] `MappingUtils` produces the exact mapping shape pinned by the
      tests in PR [#498](https://github.com/ever-works/ever-works/pull/498)
      (multi-word vs single-token name split, USD-default currency,
      50% probability NEW-stage deals, URL parse fallback to
      `undefined`).
- [ ] `CrmTenantService.resolveTenantContext` produces
      `work_<workId>`, falls back to `globalTenantId`, then to
      `'global_everworks'`.
- [ ] All 107 unit tests in
      [#498](https://github.com/ever-works/ever-works/pull/498)
      remain green.

## 8. Open Questions

- `[NEEDS CLARIFICATION: OQ-1]` `PeopleController` is **not**
  decorated with `@UseGuards(AuthSessionGuard)` — meaning, with the
  current global guard configuration, requests against it may bypass
  authentication if the global pipeline doesn't already cover it.
  Should the controller be explicitly guarded for parity with
  `CompaniesController`?
- `[NEEDS CLARIFICATION: OQ-2]` `PeopleController` does NOT have a
  `@Controller('api/twenty-crm/people')` decorator at all — it is a
  bare `class PeopleController` which would not register routes
  unless added to a module's `controllers: []` array. Inspecting
  `TwentyCrmModule.forRoot()` shows only `[CompaniesController]` is
  registered. **Is `PeopleController` currently dead code?** The
  type signature suggests it was meant to be live; needs an explicit
  decision: either remove it or wire it into the module.
- `[NEEDS CLARIFICATION: OQ-3]` `CompaniesController` and
  `PeopleController` both expose `@Patch(':id')` for updates, but
  `ClientService.updateCompany` / `updateContact` / etc. proxy via
  `PUT` (full replacement). Should the integration use Twenty's
  `PATCH` endpoint for partial updates instead?
- `[NEEDS CLARIFICATION: OQ-4]` `CompaniesController.createCompany`
  forwards the body verbatim, while `PeopleController.createContact`
  whitelists only seven fields. Should both controllers share the
  same whitelist policy?
- `[NEEDS CLARIFICATION: OQ-5]` The `@CrmSync(enabled)` decorator
  stamps `crm_sync` metadata but no consumer (no guard, no
  interceptor, no service) currently reads that metadata. Either
  wire it into a real switch (e.g. an interceptor that no-ops the
  request when `crm_sync` is `false`) or remove the decorator.
- `[NEEDS CLARIFICATION: OQ-6]` The `TwentyCrmModule.forRoot()`
  signature accepts `Partial<CrmConfigService>` but reads
  `config?.twentyCrmConfig.timeout` from it — `Partial<>` makes that
  property optional and the chained `.timeout` access is unsafe if
  `twentyCrmConfig` is missing. The TS compiler tolerates it because
  the call site passes `?.`, but a future refactor could break.
- `[NEEDS CLARIFICATION: OQ-7]` `RetryUtils` is exported as a class
  with only static methods. Is there an architecture preference for
  pure functions vs static-class helpers in the codebase? Cleaning
  this up would need a one-shot rename across consumers.
- `[NEEDS CLARIFICATION: OQ-8]` `ClientService.makeRequest` has no
  retry wrapper. The retry helper exists but is not consumed by the
  default request path; only callers who explicitly use
  `RetryUtils.withRetry(() => clientService.x(...))` get retries.
  Should retries be the default?

## 9. Constitution Gates

- [ ] Plugin-first if introducing an external integration
      (Principle I): **partial** — the integration is implemented
      INSIDE `apps/api/`, not as an external plugin. This is an
      intentional choice (the integration touches platform-side
      mapping types and tenant resolution), but a future move to
      `packages/plugins/twenty-crm` should be considered.
- [ ] Capability-driven resolution: N/A — no plugin capability is
      declared.
- [x] Source-of-truth repos preserved: the platform's own data
      remains in its DB; Twenty receives a projection only. ✅
- [ ] Long-running work via Trigger.dev: N/A — all CRUD is
      request-scoped. (Bulk syncs would change this.)
- [ ] Schema changes ship as forward-only migrations: N/A — no DB
      schema added.
- [x] Tests accompany the change: 107 unit tests in PR
      [#498](https://github.com/ever-works/ever-works/pull/498). ✅
- [x] Secrets handled per `x-secret` rules: API key in env var
      only, never logged, never echoed back. ✅
- [ ] Plugin counts touch the canonical doc only: N/A — not a
      plugin yet.
- [x] Behaviour-first — no implementation in this spec. ✅
- [x] Backwards-compatible API/SDK/schema changes: the integration
      is additive and gated by env vars. No existing endpoint is
      affected. ✅

## 10. References

- Source:
    - [`apps/api/src/integrations/twenty-crm/`](../../../../apps/api/src/integrations/twenty-crm/)
    - [`apps/api/src/integrations/twenty-crm/twenty-crm.module.ts`](../../../../apps/api/src/integrations/twenty-crm/twenty-crm.module.ts)
    - [`apps/api/src/integrations/twenty-crm/services/twenty-crm.service.ts`](../../../../apps/api/src/integrations/twenty-crm/services/twenty-crm.service.ts)
    - [`apps/api/src/integrations/twenty-crm/services/client.service.ts`](../../../../apps/api/src/integrations/twenty-crm/services/client.service.ts)
    - [`apps/api/src/integrations/twenty-crm/services/crm-tenant.service.ts`](../../../../apps/api/src/integrations/twenty-crm/services/crm-tenant.service.ts)
    - [`apps/api/src/integrations/twenty-crm/utils/retry.utils.ts`](../../../../apps/api/src/integrations/twenty-crm/utils/retry.utils.ts)
    - [`apps/api/src/integrations/twenty-crm/utils/mapping.utils.ts`](../../../../apps/api/src/integrations/twenty-crm/utils/mapping.utils.ts)
    - [`apps/api/src/integrations/twenty-crm/config/crm-config.service.ts`](../../../../apps/api/src/integrations/twenty-crm/config/crm-config.service.ts)
    - [`apps/api/src/integrations/twenty-crm/guards/crm-sync.guard.ts`](../../../../apps/api/src/integrations/twenty-crm/guards/crm-sync.guard.ts)
    - [`apps/api/src/integrations/twenty-crm/decorators/crm-sync.decorator.ts`](../../../../apps/api/src/integrations/twenty-crm/decorators/crm-sync.decorator.ts)
    - [`apps/api/src/integrations/twenty-crm/types/twenty-crm.types.ts`](../../../../apps/api/src/integrations/twenty-crm/types/twenty-crm.types.ts)
    - [`apps/api/src/integrations/twenty-crm/types/mapping.types.ts`](../../../../apps/api/src/integrations/twenty-crm/types/mapping.types.ts)
    - [`apps/api/src/integrations/twenty-crm/controllers/companies.service.ts`](../../../../apps/api/src/integrations/twenty-crm/controllers/companies.service.ts)
    - [`apps/api/src/integrations/twenty-crm/controllers/people.controler.ts`](../../../../apps/api/src/integrations/twenty-crm/controllers/people.controler.ts)
- Tests: 107 unit tests across the module — see PR
  [#498](https://github.com/ever-works/ever-works/pull/498).
- External: [Twenty CRM REST API docs](https://twenty.com/developers/section/api/rest-api).

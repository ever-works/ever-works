# Task Breakdown: Integrations — Twenty CRM

**Feature ID**: `integrations-twenty-crm`
**Plan**: `./plan.md`
**Status**: `Done` (retrospective — surface already shipped)
**Last updated**: 2026-05-08

---

## Phase 1 — Module + config (shipped)

- [x] **T1**. Global Nest module at
      [`apps/api/src/integrations/twenty-crm/twenty-crm.module.ts`](../../../../apps/api/src/integrations/twenty-crm/twenty-crm.module.ts)
    - `@Global()` so any caller can inject services without
      re-importing.
    - `forRoot()` and `forRootAsync()` factories.
    - Exports `TwentyCrmService`, `ClientService`,
      `CrmTenantService`, `CrmConfigService`.
- [x] **T2**. `CrmConfigService` at
      [`apps/api/src/integrations/twenty-crm/config/crm-config.service.ts`](../../../../apps/api/src/integrations/twenty-crm/config/crm-config.service.ts)
    - Reads `TWENTY_CRM_BASE_URL`, `TWENTY_CRM_API_KEY`,
      `TWENTY_CRM_WORKSPACE_ID`, plus the three numeric optionals
      `TWENTY_CRM_TIMEOUT_MS` (30000), `TWENTY_CRM_MAX_RETRIES` (3),
      `TWENTY_CRM_RETRY_DELAY_MS` (1000).
    - `isEnabled` / `validateConfig` (lists missing keys by
      env-var name).

## Phase 2 — Auth + config gate (shipped)

- [x] **T3**. `CrmSyncGuard` at
      [`apps/api/src/integrations/twenty-crm/guards/crm-sync.guard.ts`](../../../../apps/api/src/integrations/twenty-crm/guards/crm-sync.guard.ts)
    - Returns `false` + warn when `isEnabled === false`.
    - Returns `false` + error when `validateConfig` throws.
    - Returns `true` only when both pass.
- [x] **T4**. `@CrmSync(enabled)` decorator at
      [`apps/api/src/integrations/twenty-crm/decorators/crm-sync.decorator.ts`](../../../../apps/api/src/integrations/twenty-crm/decorators/crm-sync.decorator.ts)
    - Stamps the `crm_sync` Nest metadata key. (Currently
      informational — see OQ-5 follow-up.)

## Phase 3 — Service layer (shipped)

- [x] **T5**. `TwentyCrmService` at
      [`apps/api/src/integrations/twenty-crm/services/twenty-crm.service.ts`](../../../../apps/api/src/integrations/twenty-crm/services/twenty-crm.service.ts)
    - `makeRequest(method, endpoint, data?, params?, schema?)` —
      builds URL via `/rest` or `/rest/metadata`, sets bearer +
      workspace headers (with `'default'` workspace fallback),
      honours `timeout`, wraps thrown axios errors as
      `HttpException` with the upstream message + details (or
      `503` for transport failures).
- [x] **T6**. `ClientService` at
      [`apps/api/src/integrations/twenty-crm/services/client.service.ts`](../../../../apps/api/src/integrations/twenty-crm/services/client.service.ts)
    - 16 wrapper methods: 4 entities × {create, get, update, delete}
      plus 4 list helpers.
    - Uses `PUT` for updates (see OQ-3).
- [x] **T7**. `CrmTenantService` at
      [`apps/api/src/integrations/twenty-crm/services/crm-tenant.service.ts`](../../../../apps/api/src/integrations/twenty-crm/services/crm-tenant.service.ts)
    - `resolveTenantContext(workId?, userId?, globalTenantId?)`
      → `{tenantId, workId, userId}` with the three-level fallback.
    - `getTenantEndpointPrefix(ctx)` → `/tenants/<tenantId>`.
    - `validateTenantContext` / `getTenantConfig` helpers.

## Phase 4 — Utils (shipped)

- [x] **T8**. `RetryUtils` at
      [`apps/api/src/integrations/twenty-crm/utils/retry.utils.ts`](../../../../apps/api/src/integrations/twenty-crm/utils/retry.utils.ts)
    - `withRetry` exponential-back-off helper, last-error re-throw,
      no-sleep on `maxAttempts === 1`.
    - `isRetryableError` — ECONNRESET / ETIMEDOUT / ENOTFOUND, 5xx,
      429.
    - `calculateRetryDelay` — exponential + 10% jitter, clamped at
      `maxDelayMs`.
- [x] **T9**. `MappingUtils` at
      [`apps/api/src/integrations/twenty-crm/utils/mapping.utils.ts`](../../../../apps/api/src/integrations/twenty-crm/utils/mapping.utils.ts)
    - Four mappers (`mapClientToContact`,
      `mapCompanyToOrganization`, `mapItemToProduct`,
      `mapItemToDeal`) and four validators
      (`validateContactData`, `validateOrganizationData`,
      `validateProductData`, `validateDealData`).
    - Currency default `'USD'`, deal stage `'NEW'`, probability `50`.
    - URL-parse-with-`https://` fallback for `domainName`.

## Phase 5 — Types (shipped)

- [x] **T10**. Twenty wire-format types at
      [`apps/api/src/integrations/twenty-crm/types/twenty-crm.types.ts`](../../../../apps/api/src/integrations/twenty-crm/types/twenty-crm.types.ts)
    - `TwentyContact`, `TwentyOrganization`, `TwentyProduct`,
      `TwentyDeal`, `TwentyCrmConfig`, `TwentyCrmResponse`,
      `TwentyCrmError`, `CrmSyncResult`, `CrmTenantContext`.
- [x] **T11**. EverWorks projection types at
      [`apps/api/src/integrations/twenty-crm/types/mapping.types.ts`](../../../../apps/api/src/integrations/twenty-crm/types/mapping.types.ts)
    - `EverWorksClient`, `EverWorksCompany`, `EverWorksItem`,
      `FieldMapping`, `EntityMapping`, `MappingResult`.

## Phase 6 — Controllers (shipped)

- [x] **T12**. `CompaniesController` at
      [`apps/api/src/integrations/twenty-crm/controllers/companies.service.ts`](../../../../apps/api/src/integrations/twenty-crm/controllers/companies.service.ts)
    - 4 endpoints (`GET`, `POST`, `PATCH /:id`, `DELETE /:id`)
      under `/api/twenty-crm/companies`.
    - Class-level `@UseGuards(AuthSessionGuard)`.
- [x] **T13**. `PeopleController` at
      [`apps/api/src/integrations/twenty-crm/controllers/people.controler.ts`](../../../../apps/api/src/integrations/twenty-crm/controllers/people.controler.ts)
    - 4 endpoints with explicit field-projection on `POST`.
    - **NOT registered in `TwentyCrmModule.forRoot()`** — see
      OQ-2 follow-up T20.

## Phase 7 — Tests (shipped via PR [#498](https://github.com/ever-works/ever-works/pull/498))

- [x] **T14**. 107 unit tests covering:
    - `RetryUtils` (16) — `withRetry` exponential back-off,
      `lastError` propagation, default args, no-sleep on
      `maxAttempts=1`; `isRetryableError` ECONNRESET / ETIMEDOUT /
      ENOTFOUND / 5xx / 429 retryable, 2xx / non-429 4xx not
      retryable; `calculateRetryDelay` exponential + jitter cap.
    - `MappingUtils` (19) — multi-word vs single-token name split,
      empty-name fallback, `mapCompanyToOrganization` URL /
      `startsWith('http')` host extraction + unparseable →
      undefined, `mapItemToProduct` / `mapItemToDeal` USD default
      + supplied-currency override + 50%-probability NEW-stage deal,
      `validate*Data` happy + missing-field paths.
    - `CrmConfigService` (10) — env reads + 3 numeric defaults,
      explicit overrides, `isEnabled` triple-AND, `validateConfig`
      lists each missing key.
    - `CrmSyncGuard` (3) — disabled → false + warn (no
      validateConfig call), enabled + valid → true, enabled +
      throw → false + error log.
    - `CrmSync` decorator (4) — default-true, explicit values,
      stable `crm_sync` key.
    - `CrmTenantService` (10) — `work_<id>` prefix, fallbacks,
      endpoint prefix, validateTenantContext, getTenantConfig
      preserves undefined.
    - `TwentyCrmService.makeRequest` (8) — `/rest<endpoint>` URL,
      `/rest/metadata<endpoint>` when `schema=true`, default
      `X-Workspace-Id: default`, body forwarding, HttpException
      pass-through with status + details, INTERNAL_SERVER_ERROR
      when status missing, SERVICE_UNAVAILABLE on no-response.
    - `ClientService` (24) — table-driven across all 4 entities ×
      5 operations (create/get/update/delete/list).
    - `CompaniesController` (5) + `PeopleController` (6) —
      thin-controller delegation incl. PeopleController explicit
      field-mapping that strips extraneous body keys and forwards
      undefined optional fields.

## Phase 8 — Docs & retrospective

- [x] **T15**. Spec, plan, and tasks authored under
      `docs/specs/features/integrations-twenty-crm/` (this PR).
- [x] **T16**. `COVERAGE-TRACKER.md` row moved to "Done" with this
      PR's link.
- [x] **T17**. `index.ts` barrel at
      [`apps/api/src/integrations/twenty-crm/index.ts`](../../../../apps/api/src/integrations/twenty-crm/index.ts)
      exports the public surface for cross-module consumers.

## Outstanding follow-ups

These map 1:1 to the open questions in `spec.md` §8. Each is its
own future PR.

- [ ] **T18**. Decide on / implement OQ-1: explicitly decorate
      `PeopleController` with `@UseGuards(AuthSessionGuard)` (or
      rely on a global guard). Today's `CompaniesController` is
      explicitly guarded; symmetry helps prevent regressions if a
      future global-guard refactor changes defaults.
- [ ] **T19**. OQ-2: `PeopleController` is missing the
      `@Controller('api/twenty-crm/people')` decorator AND is not
      registered in `TwentyCrmModule.forRoot()`. Either fully wire
      it up (decorator + module registration + guard) or delete the
      file. Don't ship dead code.
- [ ] **T20**. OQ-3: `@Patch(':id')` controllers proxy to `PUT`
      service methods. Switch to Twenty's PATCH semantics for
      partial updates, OR rename the controller methods to `@Put`
      so the wire shape matches expectations.
- [ ] **T21**. OQ-4: align body-validation policy across
      `CompaniesController.createCompany` (currently no whitelist)
      and `PeopleController.createContact` (whitelisted). Add a
      `class-validator` DTO for both: `CreateCompanyDto`,
      `CreateContactDto`, `CreateDealDto`, `CreateProductDto`.
- [ ] **T22**. OQ-5: either remove `@CrmSync` (no consumer reads
      its metadata) or wire it into a runtime gate (e.g. an
      interceptor that no-ops the request when `crm_sync` is
      `false`).
- [ ] **T23**. OQ-6: tighten `TwentyCrmModule.forRoot()` typing —
      `Partial<CrmConfigService>` accepts inputs that crash on
      `.twentyCrmConfig.timeout`. Replace with a `TwentyCrmConfig`
      type narrowed to the legitimate optionals.
- [ ] **T24**. OQ-7: decide between `RetryUtils` static-class vs
      pure-function helpers. If functions are preferred,
      orchestrate a one-shot rename across the integration.
- [ ] **T25**. OQ-8: wrap `TwentyCrmService.makeRequest` in
      `RetryUtils.withRetry` by default, gated on
      `RetryUtils.isRetryableError`. Today only callers who
      explicitly opt in get retries.
- [ ] **T26**. OQ-9: actually pass `CrmTenantService` prefixes to
      `TwentyCrmService.makeRequest` so per-work tenant isolation
      becomes more than a theoretical hook. Today every controller
      hits the shared workspace, so the tenant resolver is unused
      at the wire level.
- [ ] **T27**. e2e test against `nock`-mocked Twenty CRM that drives
      the controllers end-to-end (current coverage is unit-level
      only).
- [ ] **T28**. Consider migrating the integration to
      `packages/plugins/twenty-crm` so other deployments can
      swap in HubSpot / Salesforce / Pipedrive plugins without
      touching `apps/api`. (Principle I.)
- [ ] **T29**. Audit: confirm `CompaniesController.createCompany`
      doesn't accept `id` in the body (would clash with
      Twenty-server-generated ids).

## Definition of Done

- All checkboxes T1–T17 ticked. ✅ (this is a retrospective spec)
- 107 unit tests in PR [#498](https://github.com/ever-works/ever-works/pull/498) passing.
- `pnpm format:check`, `pnpm lint`, and `pnpm --filter ever-works-api test`
  green at PR-merge time.
- Outstanding follow-ups T18–T29 captured above; none are blocking.

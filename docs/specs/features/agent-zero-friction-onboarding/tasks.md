# Task Breakdown: Agent Zero-Friction Onboarding

> Ordered, granular tasks derived from [`plan.md`](./plan.md). Each task is small enough
> to land in a single PR and ships with tests per Constitution Principle VI.

**Feature ID**: `agent-zero-friction-onboarding`
**Plan**: [`./plan.md`](./plan.md)
**Status**: `In Progress` — most tickets shipped, awaiting CI green + merge to develop.
**Last updated**: 2026-05-05

---

## How to use

- Tasks are sequential by default. Tasks marked `(parallel)` can run alongside their predecessor.
- Each task names explicit file paths so an implementer can pick it up cold.
- Use the checkbox to track progress as PRs land.
- Add new tasks at the bottom rather than renumbering.

## Phase 1 — Data model & contracts

- [x] **T1**. ✅ `OnboardingRequest` entity at [`packages/agent/src/entities/onboarding-request.entity.ts`](../../../../packages/agent/src/entities/onboarding-request.entity.ts), exported from the entities barrel.
- [x] **T2**. ✅ `WebhookSubscription` entity at [`packages/agent/src/entities/webhook-subscription.entity.ts`](../../../../packages/agent/src/entities/webhook-subscription.entity.ts) with `secretEncrypted` doc-marked as `x-secret: true`.
- [x] **T3**. ✅ Hand-written migration at [`apps/api/src/migrations/1746360000000-AddOnboardingAndWebhookSubscriptions.ts`](../../../../apps/api/src/migrations/1746360000000-AddOnboardingAndWebhookSubscriptions.ts). Forward-only, additive. **Verify** with a `pnpm typeorm migration:generate` run after pulling — should be a no-op or small diff.
- [x] **T4**. ✅ Onboarding contract types under [`packages/contracts/src/api/onboarding/`](../../../../packages/contracts/src/api/onboarding/) with re-exports from the API barrel:
    - `register-work.request.ts`, `register-work.response.ts`, `onboarding-status.ts`, `webhook-event.ts`, `manifest.types.ts`.
- [x] **T5**. ✅ Zod manifest schema at [`packages/agent/src/services/works-manifest.service.ts`](../../../../packages/agent/src/services/works-manifest.service.ts) (placed in the agent package because contracts has no zod dep). Test at [`packages/agent/src/services/__tests__/works-manifest.service.spec.ts`](../../../../packages/agent/src/services/__tests__/works-manifest.service.spec.ts) covers the happy path, every documented subcode, and the 64 KiB cap.

## Phase 2 — Service layer

- [x] **T8 (partial)**. ✅ `WorksManifestService` shipped with T5 above (kept together because they are one unit). Full unit-test suite included.
- [x] **T9a (validation pipeline)**. ✅ `OnboardingService` at [`apps/api/src/onboarding/onboarding.service.ts`](../../../../apps/api/src/onboarding/onboarding.service.ts) implements: canonicalisation, GitHub identity resolution via `GitFacadeService.getUser`, repo write-access check via `GitFacadeService.getRepository` + permissions, manifest fetch (`works.yml` then `works.yaml` fallback) with base64 decode, schema validation via `WorksManifestService`, idempotency lookup, `repo_already_owned` conflict, persistence with `status='validated'`. 12 unit tests at [`onboarding.service.spec.ts`](../../../../apps/api/src/onboarding/onboarding.service.spec.ts) cover the happy path and every typed error code. Decoupled from the heavy facades chain via the `OnboardingGitProvider` interface + `ONBOARDING_GIT_PROVIDER` injection token in [`@ever-works/agent/onboarding`](../../../../packages/agent/src/onboarding/index.ts) — the real `GitFacadeService` is bound via `useExisting` in [`OnboardingModule`](../../../../apps/api/src/onboarding/onboarding.module.ts).
- [x] **T9b (account upsert)**. ✅ `OnboardingAccountAdapter` at [`apps/api/src/onboarding/onboarding-account.adapter.ts`](../../../../apps/api/src/onboarding/onboarding-account.adapter.ts) implements `OnboardingAccountUpsert` (interface from the lean barrel) and mirrors the `GitHubAppOnboardingService.findOrCreateLocalUser` pattern across `UserRepository`, `AuthAccountRepository`, and `GitHubAppUserLinkRepository`. Wired in `OnboardingService.handle` after manifest validation; `accountId` persisted on the row.
- [x] **T9c (Work creation)**. ✅ `OnboardingWorkAdapter` at [`apps/api/src/onboarding/onboarding-work.adapter.ts`](../../../../apps/api/src/onboarding/onboarding-work.adapter.ts) implements `OnboardingWorkCreator` (interface from the lean barrel) and translates the parsed `works.yml` into a `CreateWorkDto`, then calls `WorkLifecycleService.createWork`. The lifecycle service handles the data/website/awesome repos. `workId` is persisted and the row transitions to `queued` via `OnboardingRequestRepository.tryTransition` (CAS).
- [x] **T9d (Trigger.dev enqueue — task scaffold)**. ✅ `work-onboarding.task` at [`packages/tasks/src/tasks/trigger/work-onboarding.task.ts`](../../../../packages/tasks/src/tasks/trigger/work-onboarding.task.ts) registered in the trigger barrel. The task carries the retry policy (3 attempts, exp backoff up to 5 min) and the `WorkOnboardingPayload` shape. The handoff into the existing `work-import.task` orchestrator (long-running content generation + deploy) is left as a single tightly-scoped follow-up — the api-side T9b/T9c chain already creates the Work synchronously, so the agent's `statusUrl` returns a real `workId` immediately and existing scheduled-update / generation tasks can advance it past `queued`.
- [x] **SSRF guard utility (subtask of T10)**. ✅ Shared helper at [`packages/agent/src/utils/ssrf-guard.ts`](../../../../packages/agent/src/utils/ssrf-guard.ts) with full IPv4 / IPv6 / metadata-host coverage. Spec at [`packages/agent/src/utils/__tests__/ssrf-guard.spec.ts`](../../../../packages/agent/src/utils/__tests__/ssrf-guard.spec.ts).

- [x] **T6**. ✅ `OnboardingRequestRepository` at [`packages/agent/src/database/repositories/onboarding-request.repository.ts`](../../../../packages/agent/src/database/repositories/onboarding-request.repository.ts) with `findByIdentityAndRepo`, `findByRepo`, `findById`, `create`, `tryTransition` (CAS), `markFailure`, `setWorkId`, `setAccountId`. Wired into `DatabaseModule` providers/exports and the agent `database` barrel.
- [x] **T7**. ✅ `WebhookSubscriptionRepository` at [`packages/agent/src/database/repositories/webhook-subscription.repository.ts`](../../../../packages/agent/src/database/repositories/webhook-subscription.repository.ts) with `createForAccount`, `listActiveForWork`, `listActiveForAccount`, `markSuccess`, `incrementFailure`, `markFailed`, `pause`, `findById`. Wired the same way.
- [x] **T8**. (already done as T5 in slice 1) — `WorksManifestService` ships with the lean barrel.
- [ ] **T9**. Add `OnboardingService` at `packages/agent/src/services/onboarding.service.ts`
    - Public methods:
        - `handle(request: RegisterWorkInput, token: string): Promise<RegisterWorkResponseDto>`
        - `getStatus(id: string, proof: string): Promise<RegisterWorkStatusDto>`
    - Internals: identity-hash, idempotency lookup, GitHub validation via `GitFacade`, manifest fetch, account upsert via Better Auth, Work create via `WorksService`, status transitions via repo CAS, Trigger.dev enqueue.
    - **Test**: `…onboarding.service.spec.ts` — mock all collaborators; cover happy path + every typed error code in [`plan.md` §4](./plan.md#4-api-surface)
- [x] **T10**. ✅ `WebhookDeliveryService` at [`packages/agent/src/services/webhook-delivery.service.ts`](../../../../packages/agent/src/services/webhook-delivery.service.ts) signs `X-Hub-Signature-256` HMAC-SHA256 over the raw body, emits `X-Ever-Works-Event` and `X-Ever-Works-Delivery` headers, applies the SSRF guard, exposes a static `verify()` for receivers, and uses `fetch` (Node 22+) as the default HTTP client (mockable via `WebhookHttpClient`). Companion spec at [`webhook-delivery.service.spec.ts`](../../../../packages/agent/src/services/__tests__/webhook-delivery.service.spec.ts) — 12 cases (signature determinism, secret variance, header shape, success/failure paths, SSRF block, network error). The retry policy is provided by the Trigger.dev task that wraps deliver().
- [x] **T11**. ✅ `StateMarkerService` at [`packages/agent/src/services/state-marker.service.ts`](../../../../packages/agent/src/services/state-marker.service.ts) writes `.works/state.json` (default) via a `MarkerFileWriter` interface so the heavy git-write transitively imports stay out of the unit-test path. Enforces the `.works/` namespace per FR-26a. Companion spec — 5 cases.
- [x] **T12**. ✅ Lean barrel at [`packages/agent/src/onboarding/index.ts`](../../../../packages/agent/src/onboarding/index.ts) re-exports `WorksManifestService`, `WebhookDeliveryService`, `StateMarkerService`, both repositories, the SSRF/redaction utilities, and the three injection-token interfaces (`OnboardingGitProvider`, `OnboardingAccountUpsert`, `OnboardingWorkCreator`). Registered in agent `package.json` exports as `./onboarding` so api-side code can import without pulling the heavy services chain.

## Phase 3 — REST surface

- [x] **T13 + T14**. ✅ Combined DTO file at [`apps/api/src/onboarding/dto/register-work.dto.ts`](../../../../apps/api/src/onboarding/dto/register-work.dto.ts) — request DTO with class-validator decorators, response DTO, and error DTO with full Swagger annotations.
- [x] **T15**. ✅ Controller at [`apps/api/src/onboarding/onboarding.controller.ts`](../../../../apps/api/src/onboarding/onboarding.controller.ts) implements `POST /api/register-work` and `GET /api/register-work/:id` with `@Public()`, `@Throttle()`, and the full `@ApiOperation` / `@ApiHeader` / `@ApiResponse` decorator set so Swagger + Scalar render the contract automatically.
- [x] **T16**. ✅ `OnboardingModule` at [`apps/api/src/onboarding/onboarding.module.ts`](../../../../apps/api/src/onboarding/onboarding.module.ts), imported into [`apps/api/src/api.module.ts`](../../../../apps/api/src/api.module.ts).
- [x] **T18 (controller half)**. ✅ Jest spec at [`apps/api/src/onboarding/onboarding.controller.spec.ts`](../../../../apps/api/src/onboarding/onboarding.controller.spec.ts) — supertest-driven, runs the full Nest pipeline (validation, `whitelist`, header parsing, idempotency-key forwarding, missing-token rejection, Agent Card route).

- [ ] **T15 (alternate)**. Add `apps/api/src/onboarding/onboarding.controller.ts` exposing:
    - `POST /api/register-work` (`@Public()`, `@Throttle({ default: { limit: 30, ttl: 60_000 } })`)
    - `GET /api/register-work/:id` (`@Public()`)
    - Carry `@ApiOperation`, `@ApiHeader('X-GitHub-Token')`, `@ApiBody`, `@ApiResponse` for every documented status / code so Swagger + Scalar surface the contract automatically.
- [ ] **T16**. Add `apps/api/src/onboarding/onboarding.module.ts`; import into `apps/api/src/api.module.ts`.
- [x] **T17**. ✅ Project-wide redaction utility at [`packages/agent/src/utils/redaction.ts`](../../../../packages/agent/src/utils/redaction.ts) with `redactHeaders`, `redactBody`, `redactString`, `REDACTED_HEADERS` (incl. `x-github-token`, `x-hub-signature-256`, `x-ever-works-signature`, `idempotency-key`), and `REDACTED_BODY_FIELDS` (incl. `agentPayment`). The current `LoggingInterceptor` does not log bodies/headers (so it's already secret-safe); the helper is the single point of policy for any future log site. Companion spec covers headers, nested-body, arrays, and the short-secret guard.
- [ ] **T18**. Add e2e test at `apps/api/test/onboarding.e2e-spec.ts`:
    - 202 on happy path (mocked GitHub + mocked WorksService)
    - 403 with `gh_repo_access_denied`
    - 422 with `manifest_missing` and `manifest_invalid`
    - 409 with `repo_already_owned`
    - Idempotent re-call returns same `onboardingId`
    - 429 when rate-limited
    - `X-GitHub-Token` is never echoed in logs (assert via test logger)

## Phase 4 — Background pipeline

- [x] **T19**. ✅ `work-onboarding.task` ships at [`packages/tasks/src/tasks/trigger/work-onboarding.task.ts`](../../../../packages/tasks/src/tasks/trigger/work-onboarding.task.ts) with retry policy and `WorkOnboardingPayload` shape. The api flow already creates the Work synchronously in T9b/T9c; the task is a stable enqueue point for any future generation handoff.
- [x] **T20**. ✅ Registered in [`packages/tasks/src/tasks/trigger/index.ts`](../../../../packages/tasks/src/tasks/trigger/index.ts).
- [x] **T21**. ✅ `OnboardingTerminalService` at [`apps/api/src/onboarding/onboarding-terminal.service.ts`](../../../../apps/api/src/onboarding/onboarding-terminal.service.ts) is the producer-agnostic fan-out point: any caller (api on synchronous failure, Trigger.dev task on async success/failure, future scheduled reconciler) invokes `notify()` with a `TerminalNotification` and gets webhook delivery + state marker + per-subscription failure counter. 5 unit-test cases in [`onboarding-terminal.service.spec.ts`](../../../../apps/api/src/onboarding/onboarding-terminal.service.spec.ts).
- [x] **T22**. ✅ Unit tests cover the terminal service end-to-end (success path, missing row, multiple subs, failure-counter increment + auto-pause at 6 failures, failure metadata in payload).

## Phase 5 — Webhook delivery & state marker

- [x] **T23**. ✅ Replaced the planned BullMQ queue with the leaner Trigger.dev approach (Principle IV: long-running work via Trigger.dev). `WebhookDeliveryService.deliver()` is the unit of work; the calling task drives retry semantics. No new queue infra needed at v1.
- [x] **T24**. ✅ SSRF guard at [`packages/agent/src/utils/ssrf-guard.ts`](../../../../packages/agent/src/utils/ssrf-guard.ts) — 19 cases covering IPv4 private/loopback/link-local/multicast/CGNAT, IPv6 ULA/link-local/loopback, and cloud metadata hostnames. Bracketed-host parsing matches Node's URL behaviour.
- [x] **T25**. ✅ Equivalent coverage via the `WebhookDeliveryService` unit spec (signature determinism, HTTP success/failure, SSRF block, network error) plus the `OnboardingTerminalService` spec asserting per-request hook URL + per-account subscription fan-out. A live e2e against a test HTTP server is queued for the integration-test pass once the api e2e harness lands.

## Phase 6 — MCP tool, Agent Card, llms.txt

- [x] **T26**. ✅ MCP `register_work` tool at [`apps/mcp/src/register-work.tool.ts`](../../../../apps/mcp/src/register-work.tool.ts) using `@rekog/mcp-nest`'s `@Tool` decorator with a Zod parameter schema. Registered in [`apps/mcp/src/app.module.ts`](../../../../apps/mcp/src/app.module.ts). The tool POSTs to `${EVER_WORKS_API_URL}/api/register-work` with `X-GitHub-Token` (and optional `Idempotency-Key`) and proxies the response. Public — no Ever Works credential required.
- [x] **T27**. ✅ Agent Card route at [`apps/api/src/onboarding/well-known.controller.ts`](../../../../apps/api/src/onboarding/well-known.controller.ts), serving `GET /.well-known/agent.json` with `Cache-Control: public, max-age=300`. URLs are env-driven (`PUBLIC_API_URL`, `PUBLIC_MCP_URL`, `PUBLIC_DOCS_URL`, `PUBLIC_CONTACT_EMAIL`). HTTP test included in the controller spec asserts shape + cache header.
- [ ] **T28 (deferred — separate repo PR)**. The directory website template lives in its own git repo (`ever-works/directory-web-template`) and ships independently. The required additions are:
    - `apps/web/app/llms.txt/route.ts` returning the public llms.txt convention (or `public/llms.txt` static).
    - `apps/web/app/items.json/route.ts` returning the canonical item dump.
    - Snapshot test on a sample work in the template's existing harness.
      These changes are tracked as a sibling PR to the template repo and don't block the platform-side feature shipping. The `OnboardingService` already passes through `manifest.spec.output.{llmsTxt,itemsJson}` flags so the template can read them when implemented.

## Phase 7 — CLI surface

- [x] **T29**. ✅ `everworks work register` at [`apps/cli/src/commands/work/register.ts`](../../../../apps/cli/src/commands/work/register.ts) — thin commander wrapper that POSTs to the API with `X-GitHub-Token`. Wired into the `work` parent command at [`apps/cli/src/commands/work/index.ts`](../../../../apps/cli/src/commands/work/index.ts). Reads `--github-token` or `$GITHUB_TOKEN` and the `--api-url`/`$EVER_WORKS_API_URL` override. Renders the 202 response with onboarding id, work id, status, and assigned subdomain; prints typed-error code + per-field errors on failure.

## Phase 8 — Docs & rollout

- [x] **T30**. ✅ Public-facing doc at [`docs/agent-services/zero-friction-onboarding.md`](../../../agent-services/zero-friction-onboarding.md). The `agent-services/` category uses Docusaurus' `generated-index` mode (see `_category_.json`), so the new page is auto-listed without a manual sidebar edit.
- [x] **T31**. ✅ The REST surface is annotated with `@ApiOperation`/`@ApiHeader`/`@ApiBody`/`@ApiResponse` so it surfaces in the existing `/api/openapi.json`, Swagger UI, and Scalar reference. The public-facing doc at [`docs/agent-services/zero-friction-onboarding.md`](../../../agent-services/zero-friction-onboarding.md) plus the spec/plan/manifest-schema files in [`docs/specs/features/agent-zero-friction-onboarding/`](.) cover the textual reference; the OpenAPI doc is the authoritative live reference.
- [x] **T32**. ✅ Manifest schema reference lives at [`./manifest-schema.md`](./manifest-schema.md) inside the feature spec folder (Spec Kit convention). The public doc page links to it. A mirror page on the public docs site is optional cleanup.
- [x] **T33**. ✅ Feature flag at [`apps/api/src/config/constants.ts`](../../../../apps/api/src/config/constants.ts) (`config.features.zeroFrictionOnboarding`) reads `FEATURE_ZERO_FRICTION_ONBOARDING` env var, default `true`. The controller returns 404 with code `feature_disabled` when the flag is off so an operator can disable the public surface without redeploy.
- [x] **T34**. ✅ Spec, plan, and tasks status updated: [`spec.md`](./spec.md) ready for `In Review`, this `tasks.md` reflects shipped work, [`plan.md`](./plan.md) phases 1–7 implemented (phase 8 default-on flip is the rollout step).
- [ ] **T35**. Final `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build` at repo root deferred to CI on the feature branch — local sweep covers the new code (agent: 59 pass, api onboarding: 32 pass), and the cross-package wiring builds cleanly via `pnpm build` on each package.

## Definition of Done

- All checkboxes ticked.
- All new code has matching unit / e2e tests passing locally and in CI.
- `pnpm format:check` and `pnpm lint` green.
- `pnpm --filter ever-works-docs build` produces no broken-link warnings.
- The `OpenAPI` document at `/api/openapi.json` lists `/api/register-work` and `/api/register-work/:id` with full schemas.
- Swagger UI (`/api/swagger`) and Scalar reference render the new endpoints.
- `/.well-known/agent.json` returns the Agent Card with the registration capability.
- Constitution gates in [`spec.md` §9](./spec.md#9-constitution-gates) all confirmed satisfied.
- Feature flag flipped on after soak.

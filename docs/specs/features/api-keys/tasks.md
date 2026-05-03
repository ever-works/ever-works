# Task Breakdown: API Keys

**Feature ID**: `api-keys`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-01

---

## Phase 1 — Schema & contracts

- [x] T1. `ApiKey` entity at `packages/agent/src/entities/api-key.entity.ts`.
- [x] T2. Migration adding `api_keys` table with unique `hash` index.
- [x] T3. DTOs (`CreateApiKeyDto`, `ApiKeyResponseDto`,
      `ApiKeyListResponseDto`) in `packages/contracts/`.

## Phase 2 — Service & guard

- [x] T4. `ApiKeyService.create / list / revoke / authenticate`.
- [x] T5. `ApiKeyOrJwtGuard` that tries API-key auth first, falls through
      to JWT.
- [x] T6. Per-user cap enforcement (10 keys).
- [x] T7. Expiry validation on create + on auth.

## Phase 3 — Controller

- [x] T8. `ApiKeyController` at
      `apps/api/src/auth/api-keys/api-keys.controller.ts`.
- [x] T9. Swagger decorators for all three endpoints.
- [x] T10. e2e tests in `apps/api/test/`.

## Phase 4 — Web UI

- [x] T11. Settings → API Keys page (`apps/web/src/app/[locale]/settings/api-keys/`).
- [x] T12. Create modal with one-time key reveal + copy button.
- [x] T13. Revoke confirmation modal.

## Phase 5 — Maintenance

- [x] T14. Daily cron task to purge expired keys.

## Phase 6 — Docs

- [x] T15. User-facing doc `docs/features/api-keys.md`.
- [x] T16. Cross-link from MCP server doc and authentication API ref.
- [x] T17. Retrospective spec/plan/tasks.

## Definition of Done

- [x] All tasks shipped, tests pass, docs present, constitution gates verified.

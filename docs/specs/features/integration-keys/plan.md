# Implementation Plan: Integration keys and the integration principal

**Feature ID**: `integration-keys` · **Spec**: [`./spec.md`](./spec.md) · **Plan item**: EW-P1-2

## Data

- `api_keys` (migration `1795060100000-AddIntegrationApiKeys`, Postgres + MySQL + better-sqlite3): `scopes` (json),
  `organizationIds` (json), `integrationKind` varchar(32), `description` varchar(500), `previousHashedKey` varchar(64),
  `previousKeyGraceUntil` bigint ms, `rotatedAt` bigint ms; indexes `idx_api_keys_previous_hashed_key` and
  `idx_api_keys_tenant_kind (tenantId, kind)`. All NULL on existing rows.
- `task_chat_messages.authorType` widened `varchar(8)` → `varchar(16)` (Postgres/MySQL; SQLite does not enforce
  lengths); `externalAuthor` (json) added. `tasks.createdByType` is already `varchar(16)`.
- `down()` deletes integration keys, resets integration chat authors to `user`, drops what `up()` added.

## Contracts (`packages/contracts/src/integrations/`)

`INTEGRATION_API_KEY_KIND`, `INTEGRATION_KEY_PREFIX`, `INTEGRATION_SCOPES`, `EVER_GAUZY_PRESET_SCOPES`,
`INTEGRATION_KEY_PRESETS`, `INTEGRATION_KINDS`, `INTEGRATION_HEADERS`, `INTEGRATION_ERROR_CODES`, limits and caps,
`integrationActorLabel()`, request/response types (create, summary, rotate, whoami). `ApiKeyKind` gains
`'integration'`.

## API (`apps/api/src/auth/…`, `apps/api/src/integrations-api/v1/`)

| Piece                                                                 | Where                                               | Role                                                                                                               |
| --------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `AuthSessionGuard` (global)                                           | `auth/guards/auth-session.guard.ts`                 | `ew_int_` branch: validate, build the principal (owner as `userId`), `401 invalid_key`; idempotent on a second run |
| `ApiKeyService`                                                       | `auth/services/api-key.service.ts`                  | `validateIntegrationKey` (kind gate), grace-period lookup for both kinds, `rotateKey`                              |
| `IntegrationKeyService`                                               | `auth/services/integration-key.service.ts`          | create (tenant owner, pins, scopes, cap 20), list, revoke (deactivate + event), audit rows                         |
| `IntegrationPrincipalGuard` (global, after `SessionScopeGuard`)       | `auth/integration/integration-principal.guard.ts`   | deny by default, scopes, org pin (`X-Scope-Slug` / `X-Organization-Id`), act-as on writes                          |
| `IntegrationForbiddenGuard`                                           | `auth/integration/integration-forbidden.guard.ts`   | on key-management, account, security, billing and admin controllers; `@SessionCredentialOnly()` for mint/rotate    |
| `@RequireScopes`, `@IntegrationOrgOptional`, `@SessionCredentialOnly` | `auth/integration/integration.decorators.ts`        | route metadata                                                                                                     |
| `UserAwareThrottlerGuard`                                             | `config/user-aware-throttler.guard.ts`              | per-key read/write buckets + burst; `429 rate_limited` + `Retry-After`                                             |
| `IntegrationAuditInterceptor` (global)                                | `auth/integration/integration-audit.interceptor.ts` | `integration_write` rows                                                                                           |
| `writeAttribution()`                                                  | `auth/integration/integration-attribution.ts`       | `user` vs `integration` creator/author                                                                             |
| `IntegrationsApiV1Module`                                             | `integrations-api/v1/`                              | `GET /whoami`; `IntegrationOnlyGuard`; `INTEGRATION_FEED_HEAD` → feed head                                         |

Guard order (providers order in `ApiModule`): `AuthSessionGuard` → `SessionScopeGuard` → `IntegrationPrincipalGuard` →
`ScopeOwnershipGuard` → `UserAwareThrottlerGuard`.

## Routes changed

- `POST /api/auth/api-keys` — now session only.
- New: `POST|GET /api/auth/api-keys/integration`, `POST /api/auth/api-keys/:id/rotate`,
  `GET /api/integrations/v1/whoami`.
- `DELETE /api/auth/api-keys/:id` — deactivates integration keys (personal keys are still deleted).
- `POST /api/tasks`, `POST /api/tasks/:id/chat` — `@RequireScopes('tasks:write')`, integration attribution, D9 guards.

## Web

Task chat shows an integration author (🔗, `externalAuthor.name` when present).

Settings UI (EW-P1-7): `apps/web/src/components/settings/IntegrationKeysSection.tsx` (list, create dialog with the Ever
Gauzy preset, rotate, revoke) rendered on `settings/api-keys/page.tsx` (reads `?new=integration&preset=…`);
`EverGauzyIntegrationCard.tsx` on `settings/integrations/ever-gauzy/page.tsx`; server actions `createIntegrationKey`,
`rotateApiKey`; client `apiKeysAPI.listIntegration|createIntegration|rotate`; strings in `messages/en.json`
(`dashboard.settings.apiKeys.integration`, `dashboard.settings.everGauzy`; other locales fall back to English through
`i18n/request.ts`'s deep merge).

## Tests

- `apps/api/src/auth/integration/__tests__/integration-keys.http.spec.ts` — full HTTP stack (real guards, middleware,
  interceptor, controllers; in-memory repositories): create/list/caps/validation, minting hole closed, whoami, deny by
  default, scopes, org pins (slug, id, conflicts, foreign, personal), act-as (valid, inactive, other tenant, unknown,
  garbage, ignored on reads), forbidden routes, rotation + grace, revoke, throttle 429, audit rows.
- `apps/api/src/migrations/__tests__/AddIntegrationApiKeys.spec.ts` — sqlite up/down/idempotency + per-driver DDL.
- `packages/contracts/src/integrations/__tests__/integration-keys.spec.ts` — vocabulary, preset, prefix, labels.
- Playwright: `flow-api-keys-lifecycle-deep` (a key can no longer mint a key) and `flow-api-keys-scopes-multistep`
  (in-place rotate) updated for the two intentional behaviour changes; `flow-integration-keys.spec.ts` end to end.

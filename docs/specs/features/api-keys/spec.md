# Feature Specification: API Keys

**Feature ID**: `api-keys`
**Status**: `Retrospective`
**Created**: 2026-05-01
**Last updated**: 2026-05-01
**Owner**: Ever Works Team

---

## 1. Overview

API keys provide a long-lived, non-interactive way to authenticate with the
Ever Works API. They are designed for CI/CD pipelines, CLI tools, the MCP
server, and any integration that cannot go through the browser-based JWT
login flow. Keys are user-scoped, hashed at rest, capped per user, support
optional expiration, and are revocable.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** I am logged into the dashboard, **when** I generate a new API
  key with a name like "CI Pipeline" and an optional expiry date, **then**
  the platform shows me the full key string exactly once and I can copy
  it for storage in my secrets manager.
- **Given** I have a stored API key, **when** I send any API request with
  `x-api-key: ew_live_…` (or `Authorization: Bearer ew_live_…`),
  **then** the request authenticates as the key's owning user.
- **Given** I list my API keys, **when** the list is returned, **then** I
  see each key's `id`, `name`, `prefix` (first 12 chars), `expiresAt`,
  `lastUsedAt`, and `createdAt` — never the full key.
- **Given** I revoke a key, **when** the next request uses that key,
  **then** the request is rejected with `401 Unauthorized`.

### 2.2 Edge cases & failures

- **Given** I attempt to create an 11th API key, **when** the server
  enforces the per-user cap (10), **then** the request fails with a
  "limit exceeded" error and no key is created.
- **Given** I create a key with `expiresAt` in the past, **when** the
  server validates the request, **then** it returns `400` with a clear
  "expiration must be in the future" message.
- **Given** my API key has expired, **when** I send a request with it,
  **then** the request is rejected and the failure does NOT update
  `lastUsedAt`.
- **Given** I attempt to manage API keys using an API key (not a JWT),
  **when** the request hits the API-keys endpoints, **then** it is
  rejected — API key management is JWT-only by design.
- **Given** an attacker obtains the leading `prefix` from a list response,
  **when** they try to authenticate with just the prefix or guess the
  rest, **then** authentication fails because only the SHA-256 hash of
  the full 76-char key is stored.

## 3. Functional Requirements

- **FR-1** Full keys MUST follow the format `ew_live_<64 random hex chars>`
  (76 chars total).
- **FR-2** The system MUST hash keys with SHA-256 at rest and store only
  the hash + the leading 12-character display prefix; the full key MUST
  NEVER be persisted in plaintext.
- **FR-3** The system MUST return the full key exactly once in the create
  response and MUST NOT return it from any other endpoint.
- **FR-4** The system MUST cap each user at 10 active API keys.
- **FR-5** The auth guard MUST accept the key in `x-api-key` and in
  `Authorization: Bearer <key>` headers; precedence is `x-api-key` then
  `Authorization`.
- **FR-6** The auth guard MUST try API-key validation when the supplied
  value starts with `ew_live_` and fall through to JWT validation
  otherwise — same endpoint, two transport mechanisms.
- **FR-7** Successful API-key authentication MUST update `lastUsedAt`
  on the key row.
- **FR-8** Failed authentication MUST NOT update `lastUsedAt`.
- **FR-9** Key creation MUST require a non-empty `name` (≤ 100 chars).
- **FR-10** Optional `expiresAt` MUST be in the future at the moment of
  creation; expired keys MUST be rejected on subsequent requests.
- **FR-11** Revocation (`DELETE /api/auth/api-keys/:id`) MUST be effective
  immediately — the next request using the key gets `401`.
- **FR-12** API key management endpoints (`/api/auth/api-keys/*`) MUST
  require JWT authentication and MUST reject requests authenticated by
  API keys.

## 4. Non-Functional Requirements

- **Performance**: key authentication adds at most one hash + one indexed
  DB lookup per request. P95 added latency < 5 ms.
- **Reliability**: revocation is synchronous; no caching layer can serve a
  stale "valid" answer past the revocation point.
- **Security & privacy**: only the SHA-256 hash and the display prefix are
  stored. Compromise of the database does NOT expose usable keys.
- **Observability**: failed authentications log the prefix (not the key),
  request path, and reason; never log the supplied secret.
- **Compatibility**: both header forms remain supported; new key creations
  will continue to use the `ew_live_` prefix for the foreseeable future.

## 5. Key Entities & Domain Concepts

| Entity / concept | Description                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `ApiKey` row     | `id`, `userId`, `name`, `hash` (SHA-256), `prefix`, `expiresAt`, `lastUsedAt`, `createdAt` |
| Display prefix   | First 12 chars of the full key, stored in plaintext for UI identification                  |
| Hash             | SHA-256 of the full 76-character key, stored at rest                                       |
| Per-user cap     | Maximum of 10 active keys per user                                                         |

## 6. Out of Scope

- Per-key fine-grained scopes (today every key has the user's full
  permissions).
- Per-IP allow-listing on keys.
- Programmatic rotation (clients rotate by issuing a new key + revoking the
  old one).
- Org-scoped keys (today all keys are user-scoped).

## 7. Acceptance Criteria

- [x] Full key returned only once on creation.
- [x] List endpoint returns prefix + metadata, never the full key.
- [x] Both `x-api-key` and `Authorization: Bearer` headers authenticate.
- [x] Revoked keys produce `401` immediately on the next request.
- [x] Expired keys produce `401` and don't bump `lastUsedAt`.
- [x] Per-user cap of 10 enforced.
- [x] Tests cover: create, list, revoke, header precedence, cap, expiry,
      JWT-only management, hash mismatch.

## 8. Open Questions

_None on develop._

## 9. Constitution Gates

- [x] **I — Plugin-first**: N/A (core auth, not an external integration).
- [x] **II — Capability-driven**: N/A.
- [x] **III — Source-of-truth repos**: N/A.
- [x] **IV — Trigger.dev**: N/A.
- [x] **V — Forward-only migrations**: `api_keys` table added via additive
      migration.
- [x] **VI — Tests**: covered in `apps/api/test/auth/api-keys.e2e-spec.ts`
      plus unit tests for the guard.
- [x] **VII — Secret hygiene**: API keys ARE secrets; they are hashed at
      rest, returned once, and never logged. The display prefix is the only
      plaintext fragment retained.
- [x] **VIII — Plugin counts**: N/A.
- [x] **IX — Behaviour-first**: this spec describes user-observable
      behaviour.
- [x] **X — Backwards-compat**: both header forms supported; no breaking
      schema change planned.

## 10. References

- User-facing doc: [`../../../features/api-keys.md`](../../../features/api-keys.md)
- API reference: [`../../../api/authentication.md`](../../../api/authentication.md)
- Implementation: `apps/api/src/auth/api-keys/` (controller + service +
  guard)
- Consumed by: [MCP server spec](../mcp-server/spec.md)

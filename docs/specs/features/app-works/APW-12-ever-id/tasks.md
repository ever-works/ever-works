# Task Breakdown: Ever ID

> Ordered tasks derived from [`plan.md`](./plan.md) and [`cross-platform.md`](./cross-platform.md). Each is
> small enough to land in one PR and ships with tests per **Constitution VI**. Schema tasks ship their
> migration in the same PR per **Constitution V**.

**Epic ID**: `APW-12-ever-id`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-17

---

## How to use

- Tasks are **sequential by default**. `(parallel)` means it may run alongside its predecessor.
- Every task names the exact files to create or modify. Paths in this monorepo marked **new** do not exist yet;
  every other monorepo path was checked with `git ls-files` on `develop` @ `ee45946e5`. Paths in other repositories
  are relative to that repository's root, were read on `develop` through the GitHub contents API on 2026-09-17, and
  are re-opened before the task starts ([`cross-platform.md`](./cross-platform.md) header).
- Every task has a **Test** line (file + assertion, or the run command for a test task) and a **Done when** line
  that is checkable without reading the diff and names the acceptance IDs it proves (`ACC-12-xx`, `XP-T-xx`,
  `XP-G-xx`).
- Phase boundaries are ship boundaries: `develop` is green and deployable at the end of each phase.
- Add new tasks at the bottom rather than renumbering. Migrations are authored from `apps/api/`.
- **Live changes** (enabling a plugin or flag on stage or production, registering clients at the provider)
  follow the operations change process in the private operations repository; nothing in this file authorises
  one by itself.
- Program audit resolutions ([CONTRACTS.md §0](../CONTRACTS.md)) applied here: R-1 (T3), R-2 (T15, T45), R-19 (T16,
  T18), R-22 (T20 — no suite under `apps/api/test/`).
- Run commands (this monorepo, from the root):
    - contracts: `pnpm --filter @ever-works/contracts test`; plugin contracts: `pnpm --filter @ever-works/plugin test`
    - identity plugin: `pnpm --filter @ever-works/oidc-identity test`; agent: `pnpm --filter @ever-works/agent test -- external-identity`
    - API: `cd apps/api && pnpm test -- ever-id`
    - web unit: `pnpm --filter ever-works-web test -- ever-id`; web e2e: `pnpm --filter ever-works-web test:e2e ever-id`
    - CLI: `pnpm --filter ever-works-cli test`; node: `pnpm --filter ever-works-node test`
- Run commands (other repositories): Ever Teams `yarn test:web` (Jest) and `yarn e2e:web` (Cypress); Ever Gauzy
  `yarn nx test core`, `yarn nx test auth`, `yarn nx test common`, `yarn nx test ui-auth`, `yarn nx test mcp-auth`
  (Jest) and `yarn nx e2e gauzy-e2e` (Playwright).

---

# Phase P0 — Decision gate (no product code)

- [ ] **T1. Owner decisions.**
      **Modify** `docs/specs/features/app-works/APW-12-ever-id/idp-options.md` §6 — record D1–D9 (answer, date,
      decider) and set `Status: Decided`. **Modify** `docs/specs/features/app-works/README.md` §8 question 6 with
      the answer, and `docs/specs/features/app-works/TRACKER.md` notes for APW-12.
      **Test**: review check in the PR — every D-row of `idp-options.md` §6 carries an answer, a date and a decider and
      `Status` reads `Decided`; `npx prettier --check` passes on the three files.
      **Done when**: every D-row has an answer and none is left at its default silently.
      **Owner answers already recorded (2026-09-17)**: **D1** is answered — the provider is **ZITADEL**, self-hosted
      as-is — and **D2** is answered — the public domain is **`auth.ever.co`**, verified free in the live `ever.co`
      zone, one instance serving every platform. Both are quoted in `spec.md` §9 and in `idp-options.md` §6. T1's
      remaining scope is therefore **D3–D9**; it does not re-open D1 or D2, and D1 is not a gate on any later task.

- [ ] **T2. Provider stood up (private operations repository).** _(operator attestation)_
      Three environments, at least 3 replicas each, verified database backups, and the clients, scopes,
      audiences, lifetimes and back-channel logout URIs of [`idp-options.md`](./idp-options.md) §6.1. No
      hostname or address is written into this repository.
      **Modify** nothing in this repository: the provider configuration and its change record are created in the private
      operations repository; `docs/specs/features/app-works/TRACKER.md` gets only the P0 tick (T1).
      **Test**: the Ever Works administrator **Test connection** screen (T6) against the development provider returns
      every FR-3 check green; the result is recorded in the private operations change log as `apw12-provider-standup`.
      That run needs P1 code, so it is driven by **T47** (P1, after T6) and is **not** a condition of closing T2.
      **Done when**: the development discovery document satisfies every row of [plan §4.3](./plan.md) by
      manual inspection — issuer, endpoints, `code_challenge_methods_supported` containing `S256`, the signing
      algorithms, the back-channel logout support and the device authorization endpoint — recorded in the operations
      change log; T47 records the same provider passing the in-product Test connection once P1 ships.

---

# Phase P1 — Ever Works relying party

_Delivers spec FR-1…FR-53 and ACC-12-01…ACC-12-39._

## P1.1 — Contracts

- [ ] **T3. Shared Ever ID types.**
      **Create** `packages/contracts/src/apps/ever-id.ts` (**new**, Resolution R-1) exactly as
      [plan §3.5](./plan.md). **Modify** APW-03's barrel `packages/contracts/src/apps/index.ts` —
      `export * from './ever-id.js';` (create the barrel, and `export * from './apps/index.js';` in
      `packages/contracts/src/index.ts`, only if APW-03 has not landed).
      **Test**: `packages/contracts/src/apps/__tests__/ever-id.spec.ts` (**new**) pins every `EVER_ID_LIMITS` number,
      both scope strings, the algorithm list and the error-code union; run `pnpm --filter @ever-works/contracts test`.
      **Done when**: `pnpm --filter @ever-works/contracts build` emits declarations, `apps/api` imports
      `EVER_ID_LIMITS` from `@ever-works/contracts`, and `packages/contracts/src/__tests__/index.barrel.spec.ts` passes.

- [ ] **T4 (parallel with T3). Identity provider capability contract.**
      **Create** `packages/plugin/src/contracts/capabilities/identity-provider.interface.ts` (**new**,
      [plan §4.1](./plan.md)) and export it from `packages/plugin/src/contracts/capabilities/index.ts`. **Modify**
      `packages/plugin/src/contracts/facade-capabilities.ts` (`IDENTITY_PROVIDER: 'identity-provider'`) and
      `packages/plugin/src/contracts/plugin-manifest.types.ts` (append `'identity'` to `PLUGIN_CATEGORIES`).
      **Modify** `apps/web/src/lib/utils/plugin-category-icons.ts` — its two exhaustive
      `Record<PluginCategory, …>` maps (icon and label) stop compiling the moment `'identity'` joins the union, so
      the new category needs an icon, a label and any label i18n the file reads; the file's own assertion that every
      category has both stays as it is.
      **Test**: `packages/plugin/src/contracts/__tests__/identity-provider.interface.spec.ts` (**new**) — the type
      guard, the closed `IdentityTokenRejectedError` code set, the category present; run
      `pnpm --filter @ever-works/plugin test`; extend `apps/web/src/lib/utils/plugin-category-icons.unit.spec.ts`
      (or the file's existing spec) with the `identity` case.
      **Done when**: the plugin package builds, the root `pnpm type-check` is green (the category maps are exhaustive,
      so a missing icon or label fails the build rather than at runtime), and no existing category or capability changed.

## P1.2 — The `oidc-identity` plugin

- [ ] **T5. Scaffold and settings schema.**
      **Create** `packages/plugins/oidc-identity/` (**new**: `package.json` named `@ever-works/oidc-identity` with the
      `everworks.plugin` block of [plan §4.2](./plan.md), `tsup.config.ts`, `vitest.config.ts`, `src/index.ts`,
      `src/settings.schema.ts`, `src/oidc-identity.plugin.ts` skeleton). Dependencies `openid-client@^6`, `jose@^6` in
      this package only (the built-in plugin list is updated in T33).
      **Test**: `packages/plugins/oidc-identity/src/__tests__/settings.schema.spec.ts` (**new**) — `clientSecret` is
      `x-secret`; every key is `x-scope: 'global'`; limits (1–3 issuers, ≤ 5 local clients, skew 0–120, `http` only for
      localhost outside production).
      **Done when**: `pnpm --filter @ever-works/oidc-identity build test` is green and plugin discovery lists it
      disabled by default.

- [ ] **T6. Discovery, key cache and Test connection.**
      **Create** `packages/plugins/oidc-identity/src/discovery.ts`, `src/jwks-cache.ts` (**new**); implement
      `testConnection` and `getPublicConfig` in `src/oidc-identity.plugin.ts`.
      **Test**: `packages/plugins/oidc-identity/src/__tests__/test-connection.spec.ts` (**new**) — each FR-3 check within
      5 s and the secret absent from the output (ACC-12-03); `src/__tests__/jwks-cache.spec.ts` (**new**) — 600 s cache,
      30 s unknown-key cooldown, 21,600 s staleness then fail closed, a rotated key validates after one refresh and a
      removed key is refused after the next (ACC-12-08), 5 s timeout, one retry.
      **Done when**: both specs pass and no output contains the secret (ACC-12-03, ACC-12-08).

- [ ] **T7. Authorization request, code exchange, ID token validation.**
      **Modify** `packages/plugins/oidc-identity/src/oidc-identity.plugin.ts` — implement `buildAuthorizationRequest`
      and `exchangeAuthorizationCode`; **create** `packages/plugins/oidc-identity/src/scopes.ts` (**new**, sign-in scopes
      `openid email profile`, never `offline_access`).
      **Test**: `packages/plugins/oidc-identity/src/__tests__/authorization-request.spec.ts` (**new**) — S256, fresh
      32-byte `state` and `nonce`, exact redirect (ACC-12-06); `src/__tests__/id-token.spec.ts` (**new**) — every
      FR-11/FR-12 rejection and the ±60 s skew edges (ACC-12-07).
      **Done when**: ACC-12-06 and ACC-12-07 are proven at unit level.

- [ ] **T8. Access token, logout token, end-session URL, fake provider.**
      Implement `verifyAccessToken`, `verifyLogoutToken`, `buildEndSessionUrl`. **Create**
      `packages/plugins/oidc-identity/src/testing/fake-oidc-provider.ts` (**new**) exported only through a
      `./testing` subpath ([plan §10.4](./plan.md)).
      **Test**: `packages/plugins/oidc-identity/src/__tests__/access-token.spec.ts` (**new**) — lifetime > 3,600 s and a
      wrong audience refused (ACC-12-35), unlisted `azp`, missing scope, `iat` > 300 s refused (ACC-12-29 unit half);
      `src/__tests__/logout-token.spec.ts` (**new**) — reused `jti`, a `nonce`, `iat` older than 300 s refused
      (ACC-12-24 unit half); `src/__tests__/fake-oidc-provider.spec.ts` (**new**) — discovery, PKCE check, device grant,
      key rotation helper.
      **Done when**: the main bundle does not contain the fake provider (asserted on the build output).

## P1.3 — Entity, sessions, migrations

- [ ] **T9. `ExternalIdentity` entity and repository.**
      **Create** `packages/agent/src/entities/external-identity.entity.ts` and
      `packages/agent/src/database/repositories/external-identity.repository.ts` (**new**, [plan §3.1](./plan.md)).
      **Modify** `packages/agent/src/entities/index.ts`, `packages/agent/src/database/_entity-names.ts`,
      `packages/agent/src/database/_entities-inventory.ts`, `packages/agent/src/database/_repository-inventory.ts`.
      **Test**: `packages/agent/src/entities/__tests__/external-identity.entity.spec.ts` (**new**) — index names, Tier B
      columns, no token column (ACC-12-22 schema half);
      `packages/agent/src/database/repositories/__tests__/external-identity.repository.spec.ts` (**new**) — both
      conflict reasons, two concurrent inserts of one pair leave exactly one row (ACC-12-19), 10-client cap.
      **Done when**: the drift specs in `packages/agent/src/database/database.module.spec.ts` pass unchanged.

- [ ] **T10. Session origin columns and `issueSession` argument.**
      **Modify** `packages/agent/src/entities/auth-session.entity.ts` (append `externalIdentityId`, `externalSid`
      and two indexes); `apps/api/src/auth/providers/auth-provider.abstract.ts` (optional `origin` argument);
      `apps/api/src/auth/providers/auth-provider.service.ts` (write the columns; export `hashSessionToken`).
      **Test**: extend `apps/api/src/auth/providers/auth-provider.service.spec.ts` — existing callers write nulls;
      `origin` is persisted; a session issued with an Ever ID origin has `expiresAt` exactly 7 days after creation,
      like a password session (ACC-12-27).
      **Done when**: every existing auth spec passes without edits.

- [ ] **T11. Migrations.**
      **Create** `apps/api/src/migrations/1792120000000-CreateExternalIdentities.ts` and
      `apps/api/src/migrations/1792120100000-AddExternalIdentityToSessions.ts` (**new**, [plan §3.6](./plan.md)).
      **Test**: `apps/api/src/migrations/__tests__/CreateExternalIdentities.spec.ts` and
      `apps/api/src/migrations/__tests__/AddExternalIdentityToSessions.spec.ts` (**new**) — `up` creates only the listed
      objects, `down` drops only them, no `DROP COLUMN` of a pre-existing column.
      **Done when**: both migration specs pass, a `DATABASE_AUTOMIGRATE` boot on **SQLite** and on a **Postgres
      service container** migrates up and down cleanly, and — where a copy of stage's schema is available to the
      operator — the same up/down run is repeated against that copy and recorded in the operations change log. The
      SQLite and Postgres runs are the ones the PR lane can reproduce.

## P1.4 — Facade and API services

- [ ] **T12. `IdentityProviderFacadeService`.**
      **Create** `packages/agent/src/facades/identity-provider.facade.ts` (**new**); **Modify**
      `packages/agent/src/facades/facades.module.ts` (`FACADES`) and `packages/agent/src/facades/index.ts`.
      **Test**: `packages/agent/src/facades/__tests__/identity-provider.facade.spec.ts` (**new**) — admin-tier-only
      resolution; disabled/unconfigured/discovery-failing mapped to `IdentityProviderUnavailableError`.
      **Done when**: no plugin ID string appears outside `packages/plugins/oidc-identity/`.

- [ ] **T13. Seal and replay services.**
      **Create** `apps/api/src/auth/services/ever-id-seal.service.ts` and
      `apps/api/src/auth/services/ever-id-replay.service.ts` (**new**, [plan §3.3–3.4](./plan.md)).
      **Test**: `apps/api/src/auth/services/ever-id-seal.service.spec.ts` (**new**) — tamper, wrong kind, expiry,
      3,072-byte cap; `apps/api/src/auth/services/ever-id-replay.service.spec.ts` (**new**) — single use, concurrent
      inserts, ≤ 100-row cleanup; replaying a completed transaction yields `transactionInvalid` (ACC-12-09).
      **Done when**: ACC-12-09 holds at unit level.

- [ ] **T14 (parallel with T13). Session service.**
      **Create** `apps/api/src/auth/services/ever-id-session.service.ts` (**new**).
      **Test**: `apps/api/src/auth/services/ever-id-session.service.spec.ts` (**new**) — by `sid` ends only that session
      and by identity ends all it opened (ACC-12-23 unit half); except current on disconnect (ACC-12-20 unit half);
      password sessions untouched (ACC-12-25); counts returned.
      **Done when**: ACC-12-25 holds at unit level.

- [ ] **T15. Linking service and Activity members.**
      **Create** `apps/api/src/auth/services/ever-id-linking.service.ts` (**new**, [plan §5.5](./plan.md)). **Modify**
      `packages/agent/src/entities/activity-log.types.ts` (five additive members, [plan §5.6](./plan.md); `action`
      values dotted, Resolution R-2).
      **Test**: `apps/api/src/auth/services/ever-id-linking.service.spec.ts` (**new**) — the spec §5.3 decision tree as a
      table test (ACC-12-13…ACC-12-18); S3 returns no account ID; `canDisconnect` truth table (ACC-12-20); sign-up
      records terms and creates the account, the connection and the session in that order, and a forced
      `insertLink` failure leaves no orphan account (ACC-12-14); the concurrent sign-up/connect race ends with one
      connection and the other outcome S12 (ACC-12-19); no row written by any path contains a token (ACC-12-22).
      **Done when**: ACC-12-13…ACC-12-20 and ACC-12-22 are proven at unit level.

## P1.5 — Controller and guards

- [ ] **T16. Request-shape guards and `authMethod`.** _(Resolution R-19)_
      **Create** `apps/api/src/auth/guards/no-token-in-query.guard.ts`, `apps/api/src/auth/guards/session-only.guard.ts`
      (**new**).
      **Modify** `apps/api/src/auth/types/auth.types.ts` — append exactly one value, `'ever-id-delegated'`, to the
      existing `authMethod` union (`'session' | 'api-key'`, shipped by AW-24). No other value and no new field is added,
      and `apps/api/src/auth/guards/auth-session.guard.ts` keeps every existing stamp. AW-24's
      `apps/api/src/safety/guards/human-actor.guard.ts` admits only `'session'`, so it refuses delegated tokens on
      human-only routes without any change.
      **Test**: `apps/api/src/auth/guards/no-token-in-query.guard.spec.ts` (**new**) — each listed query key answers
      400 `tokenInQuery` before the handler and no logger call contains the value (ACC-12-10);
      `apps/api/src/auth/guards/session-only.guard.spec.ts` (**new**) — `'api-key'` and `'ever-id-delegated'` answer 403
      `sessionRequired` (ACC-12-21); extend `apps/api/src/safety/guards/human-actor.guard.spec.ts` with one case — a
      `'ever-id-delegated'` principal is refused. `apps/api/src/auth/guards/auth-session.guard.spec.ts` already asserts
      the two existing stamps and is extended only for the delegated branch (T18).
      **Done when**: ACC-12-10 and ACC-12-21 hold at unit level, no existing guard assertion changed, and a grep of
      `apps/api/src` finds no value other than `'session'`, `'api-key'` and `'ever-id-delegated'` on
      `AuthenticatedUser.authMethod` — scoped to that type and to the stamps in
      `apps/api/src/auth/guards/auth-session.guard.ts`, because unrelated `authMethod` fields exist elsewhere in
      `apps/api/src` (for example the Git-provider service's own `authMethod` values, which this epic does not touch).
      A type-level assertion on the `authMethod` union is the preferred form of the same check.

- [ ] **T17. `EverIdController`, DTOs, providers field.**
      **Create** `apps/api/src/auth/controllers/ever-id.controller.ts`, `apps/api/src/auth/dto/ever-id.dto.ts` (**new**).
      **Modify** `apps/api/src/auth/auth.module.ts` (controller + services), and
      `apps/api/src/auth/controllers/auth.controller.ts` (`everId` field on `GET providers`).
      **Test**: `apps/api/src/auth/controllers/ever-id.controller.spec.ts` (**new**) — every row of plan §5.1 and §5.2:
      unconfigured or disabled → 404 on every sign-in endpoint (ACC-12-01) while `/identities`, `DELETE` and
      `/backchannel-logout` keep working (ACC-12-04); throttle metadata values of spec FR-18 (ACC-12-11); a `returnTo`
      to another site falls back to the dashboard (ACC-12-12); a valid notice with `sid` ends that session and with
      `sub` all it opened, answering 200 with `Cache-Control: no-store` (ACC-12-23); an invalid notice → 400
      (ACC-12-24); `GET /logout-url` returns the end-session URL with a `state` (ACC-12-26); issued sessions carry the
      7-day expiry (ACC-12-27); extend `apps/api/src/auth/controllers/auth.controller.spec.ts` — `GET providers` keeps
      every existing field and adds `everId` (ACC-12-05).
      **Done when**: ACC-12-01, 04, 05, 11, 12, 23, 24, 26 and 27 pass at controller level.

- [ ] **T18. Delegated read branch and `@DelegatedRead`.** _(Resolution R-19)_
      **Create** `apps/api/src/auth/decorators/delegated-read.decorator.ts` (**new**). **Modify**
      `apps/api/src/auth/guards/auth-session.guard.ts` ([plan §5.3](./plan.md)) — the branch runs only for handlers
      carrying `@DelegatedRead(scope)` and stamps `authMethod: 'ever-id-delegated'`.
      **Test**: `apps/api/src/auth/guards/auth-session.guard.delegated.spec.ts` (**new**) — a valid `apps:read` token is
      admitted on a decorated test handler (ACC-12-33); the same token → 401 on an undecorated handler and 403
      `insufficientScope` on a decorated handler requiring another scope (ACC-12-34); lifetime > 3,600 s or wrong
      audience → 401 (ACC-12-35); a decorated handler that is also `@HumanOnly()` refuses it through the unchanged
      `HumanActorGuard`.
      **Coordinate**: APW-11 applies the decorator to its list handler; this task ships a test controller in the
      spec only.
      **Done when**: ACC-12-33…ACC-12-35 hold against the test handler and a JWT bearer on any unmarked route
      still answers the pre-existing 401.

- [ ] **T19. Local-client exchange and client configuration.**
      **Modify** `apps/api/src/auth/controllers/ever-id.controller.ts` — implement `POST /api/auth/ever-id/session` and
      `GET /api/auth/ever-id/client-config`; **modify** `apps/api/src/auth/dto/ever-id.dto.ts` for their shapes.
      **Test**: extend `apps/api/src/auth/controllers/ever-id.controller.spec.ts` — unlisted `azp`, missing scope, `iat` > 300 s, reused `jti` refused (ACC-12-29); unconnected pair → `403 notConnected` and no user row created
      (ACC-12-30); `client-config` returns no secret.
      **Done when**: ACC-12-29 and ACC-12-30 hold at controller level.

- [ ] **T20. API flow integration spec.** _(Resolution R-22 — replaces the former `apps/api/test/ever-id.e2e-spec.ts`)_
      **Create** `apps/api/src/auth/ever-id.flow.integration.spec.ts` (**new**, [plan §10.3](./plan.md)) — Jest, picked
      up by `apps/api/jest.config.js` (`rootDir: src`); in-memory better-sqlite3 with `ENTITIES`, the real controller,
      services and `AuthSessionGuard`, the T8 fake provider and `supertest`.
      **Harness (the reason this task names it):** `apps/api/jest.config.js` transforms with ts-jest to CommonJS and
      maps no module for `@ever-works/oidc-identity`, while `openid-client` and `jose` are ESM-only packages that a
      CommonJS `require` cannot load — production loads plugins through `import()`, which Jest does not. So the spec
      binds `IdentityProviderFacadeService` to an in-test `IIdentityProviderPlugin` built on `node:crypto` (the same
      construction as T8's fake provider), added to `jest.config.js` through a `moduleNameMapper` entry pointing at the
      fake provider's source path; the real plugin package is exercised by its own Vitest suite (T5–T8) instead. State
      explicitly in the spec header which of the two it uses, so the seam is never implicit.
      **Modify** `apps/api/jest.config.js` (the `moduleNameMapper` entry above).
      **Test**: run `cd apps/api && pnpm test -- ever-id.flow.integration`. Assertions: a connected identity signs in and
      Activity holds `user.login.ever-id` (ACC-12-13 API half); sign-up confirm with terms creates the account, the
      connection and a session (ACC-12-14 API half); `POST /session` with a freshly minted exchange token returns a
      `TokenResponse` in the body in < 5 s and no captured log line contains the token (ACC-12-28 API half); a test
      controller with `@DelegatedRead('apps:read')` returns the person's App Works (ACC-12-33 API half); sign-up,
      connect, disconnect and back-channel logout also pass end to end; and the two states the browser lane cannot
      reach are written directly here — a session row aged past `connectMaxSessionAgeSeconds` (S15, ACC-12-17 API
      half) and an account with no password, no social provider and an unverified e-mail (S14, ACC-12-20 API half).
      **Done when**: the spec passes in the PR lane and no file exists under `apps/api/test/` for this epic.

## P1.6 — Web

- [ ] **T21. Fail-closed flag.** _(lands after APW-01 T20)_
      **Create** `apps/web/src/lib/feature-flags/posthog-client.ts` (extracted singleton) and
      `apps/web/src/lib/feature-flags/ever-id.ts` (**new**, [plan §6.4](./plan.md)); **Modify**
      `apps/web/src/lib/feature-flags/work-kinds.ts` to import the extracted client only.
      **Depends on APW-01 T20**: that task creates `work-kinds.unit.spec.ts` and restructures `work-kinds.ts`
      (`FAIL_CLOSED_WORK_KINDS`, off when PostHog is absent). APW-01's spec is the unchanged baseline this task
      must keep green; if APW-01 T20 has not landed, T21 writes a characterisation spec of today's `work-kinds.ts`
      behaviour first and keeps it after the extraction.
      **Test**: `apps/web/src/lib/feature-flags/ever-id.flag.unit.spec.ts` (**new**) — no key → configuration decides;
      error, timeout, `undefined` → off (ACC-12-02); APW-01's `work-kinds.unit.spec.ts` unchanged and green.
      **Done when**: ACC-12-02 holds and the extracted singleton leaves Work-kind evaluation byte-for-byte the same.
      **Deliberate difference from APW-01, stated in [plan §6.4](./plan.md)**: Work kinds read an absent PostHog key
      as off, Ever ID reads it as "configuration alone decides" — an authentication method must not be switched off
      by a missing analytics key (spec FR-1). The two helpers stay separate for exactly that reason.

- [ ] **T22. Providers, API client, server actions, cookies.**
      **Modify** `apps/web/src/lib/auth/providers.ts`, `apps/web/src/lib/api/auth.ts`,
      `apps/web/src/app/actions/auth.ts` (the six actions of [plan §6.1](./plan.md), plus the logout option).
      **Create** `apps/web/src/lib/auth/ever-id-cookies.ts` (**new**) — `ew_everid_txn` (600 s),
      `ew_everid_pending` (600 s, whose sealed value carries the identity the outcome is about, including the
      `emailInUse` address) and `ew_everid_logout_state` (600 s), all HttpOnly, SameSite=Lax, `secure` from the
      public URL scheme, **Path `/`** (the create-account and account-exists pages live under a locale prefix, so a
      narrow path would hide the cookie from them; T23's callback and T25's pages therefore read one path).
      `confirmEverIdSignUp` sends the terms claims of the account being created — the DTO shape of
      [plan §5.1](./plan.md) — and takes the required documents from the same source the register page uses, so the
      web never invents a `documentId`.
      **Test**: extend `apps/web/src/app/actions/auth.unit.spec.ts` — `startEverIdSignIn` rejects an absolute `returnTo`
      (ACC-12-12 web half); "Also sign out of Ever ID" redirects to the URL from `GET /logout-url` and stores its
      `state` in `ew_everid_logout_state` (ACC-12-26 web half); `confirmEverIdSignUp` posts terms claims and no action
      returns an upstream message verbatim; extend `apps/web/src/lib/api/auth.unit.spec.ts` — providers
      default `everId: { enabled: false }` when absent; `apps/web/src/lib/auth/ever-id-cookies.unit.spec.ts` (**new**)
      — every cookie is HttpOnly, SameSite=Lax, Path `/`, and cleared on every callback, confirm and return path.
      **Done when**: no action returns an upstream error message verbatim (translated generic messages only), and the
      same cookie path is asserted in the unit spec, the callback route spec (T23) and the browser lane (T30).

- [ ] **T23. Callback route and error codes.**
      **Create** `apps/web/src/app/api/auth/ever-id/callback/route.ts` (**new**). **Modify**
      `apps/web/src/app/[locale]/(auth)/auth/error/auth-error-content.tsx` (`ever_id_*` codes).
      **Test**: `apps/web/src/app/api/auth/ever-id/callback/route.unit.spec.ts` (**new**) — outcome table of plan §6.3;
      the transaction cookie is cleared on every path; the address never carries the e-mail.
      **Done when**: the local-client hand-off route and `addSessionTokenToUrl` have no new caller (grep asserted
      in the spec).

- [ ] **T24. Button on sign-in and registration.**
      **Create** `apps/web/src/components/auth/ever-id-button.tsx` (**new**). **Modify**
      `apps/web/src/app/[locale]/(auth)/login/login-client.tsx`, `apps/web/src/app/[locale]/(auth)/login/page.tsx`, and
      `apps/web/src/app/[locale]/(auth)/register/register-form.tsx` (consent gate).
      **Test**: `apps/web/src/components/auth/ever-id-button.unit.spec.tsx` (**new**) — absent when `everId.enabled` is
      false or the flag is off (ACC-12-01 web half), `Opening Ever ID…` while redirecting; extend
      `apps/web/src/app/[locale]/(auth)/register/register-form.unit.spec.tsx` — disabled with "Accept the terms above to
      continue." until consent.
      **Done when**: the button is absent when `everId.enabled` is false or the flag is off.

- [ ] **T25. Create-account and account-exists screens.**
      **Create** `apps/web/src/app/[locale]/(auth)/auth/ever-id/create-account/page.tsx`,
      `apps/web/src/app/[locale]/(auth)/auth/ever-id/create-account/create-account-client.tsx` and
      `apps/web/src/app/[locale]/(auth)/auth/ever-id/account-exists/page.tsx` (**new**).
      **Test**: `apps/web/src/app/[locale]/(auth)/auth/ever-id/create-account/create-account-client.unit.spec.tsx` and
      `apps/web/src/app/[locale]/(auth)/auth/ever-id/account-exists/page.unit.spec.tsx` (**new**) — terms required,
      cancel creates nothing (ACC-12-14 web half), pending cookie expiry copy, S3 copy without any account id
      (ACC-12-15 web half).
      **Done when**: spec §6.2 copy renders exactly.

- [ ] **T26. Connected identities card, connect confirmation, sign-out dialog.**
      **Create** `apps/web/src/components/settings/ConnectedIdentitiesCard.tsx`,
      `apps/web/src/app/[locale]/(dashboard)/settings/security/connect-ever-id/page.tsx` and
      `apps/web/src/components/auth/EverIdSignOutDialog.tsx` (**new**). **Modify**
      `apps/web/src/components/settings/SecuritySettings.tsx`,
      `apps/web/src/components/dashboard/DashboardSidebar.tsx` (`handleLogout`, line 127 — today it calls `logout()`
      straight from the menu item at line 616) and
      `apps/web/src/components/command-palette/CommandPalette.tsx` (line 192 — today it calls `logout()` straight
      from the command). Both callers route through the new dialog; when the session was **not** opened with Ever ID
      the dialog renders only `Sign out` / `Cancel` and both callers behave exactly as they do today. No sign-out
      dialog exists on `develop`; this is an addition, not a replacement of one.
      **Origin signal (already specified, no new route):** `getEverIdLogoutUrl()` (T22) calls `GET
/api/auth/ever-id/logout-url`, which answers `404` for a session not opened with Ever ID ([plan §5.1](./plan.md))
      — a `200` is the signal that shows the `Also sign out of Ever ID` checkbox. The dialog asks once, on open.
      **Return path:** the API's end-session URL carries a `state`; T22 stores it in `ew_everid_logout_state`
      (600 s, HttpOnly, SameSite=Lax, `secure` from the public URL scheme, Path `/`, cleared on return), and the
      end-session call returns to **new** `apps/web/src/app/api/auth/ever-id/logout-return/route.ts`, which
      constant-time compares the state, clears the auth cookie and redirects to sign-in with the §6.5
      `You're signed out of Ever Works and Ever ID.` copy. The web tier validates `state` the same way
      `handleOAuthCallback` validates it; an absent or mismatched state falls back to the ordinary signed-out page
      with no message. The registered post-logout redirect URI is the row added to
      [`idp-options.md`](./idp-options.md) §6.1.
      **Test**: `apps/web/src/components/settings/ConnectedIdentitiesCard.unit.spec.tsx` (**new**) — connected, not
      connected, cannot disconnect, turned off, and the delegated apps list with its display name and last-used time
      (ACC-12-36); `apps/web/src/components/auth/EverIdSignOutDialog.unit.spec.tsx` (**new**) — the checkbox is
      absent when `GET /logout-url` answers 404, ticked it follows the URL from that route, unticked it calls
      `logout()` exactly as today (ACC-12-26 web half); `apps/web/src/app/api/auth/ever-id/logout-return/route.unit.spec.ts`
      (**new**) — matching state clears cookies and shows the S7 copy, mismatched state degrades silently.
      **Done when**: ACC-12-36 renders from API data, the S14 variant disables Disconnect with its reason, and both
      existing `logout()` callers still sign out with the checkbox unticked.

- [ ] **T27. i18n.**
      **Modify** `apps/web/messages/en.json` with **every** key of [plan §8](./plan.md) and the other 20 locale files
      in `apps/web/messages/`. Plan §8 is the complete list: it carries the sign-in, sign-up, connect, card, dialog and
      error keys **and** the sign-out dialog (title, checkbox, `Cancel`, `Sign out`), the registration terms checkbox
      label, the pending-cookie expiry copy, the administrator §6.7 copy (`Test connection`, one label per FR-3 check
      id, the three `Health` labels, the `•••••• (set)` secret placeholder), the `accountDisabled` message that
      `auth.error` does not have today, and one `auth.error.everId.*` key for **every** `EverIdErrorCode` the web can
      receive (`everIdDisabled`, `sessionRequired`, `notConnected`, `lastSignInMethod`, `accountDisabled`,
      `tokenInQuery`, `insufficientScope` included) — the mapping is `ever_id_<snake_code>` → `auth.error.everId.<camel>`.
      **Test**: `apps/web/src/lib/auth/ever-id-copy.unit.spec.ts` (**new**) — every key present in every locale, no leaf
      contains a dot, no English value contains "SSO" or "single sign-on" (ACC-12-38), **and** the union of
      `EverIdErrorCode` maps onto a key in `auth.error.everId.*` with no member missing (a table-driven assertion, so a
      new code cannot ship untranslated).
      **Done when**: ACC-12-38 holds and the error-code coverage table is exhaustive.

## P1.7 — Local clients

- [ ] **T28. CLI device sign-in.** _(after T44)_
      **Create** `apps/cli/src/commands/auth/ever-id-device.service.ts` (**new**); **Modify**
      `apps/cli/src/commands/auth/login.command.ts` (`--ever-id`).
      **Test**: `apps/cli/src/commands/auth/ever-id-device.service.spec.ts` (**new**) — interval ≥ 5 s, `slow_down` +5 s
      (ACC-12-31), expiry ≤ 900 s, sign-in completes within 5 s of approval on a fake clock and no printed line contains
      the token (ACC-12-28), sanitised errors, exit code 1 on failure; T44's characterisation spec still passes
      (ACC-12-32).
      **Done when**: ACC-12-28, ACC-12-31 and ACC-12-32 hold (the existing browser login flow is untouched).

- [ ] **T29 (parallel with T28). Node device sign-in.**
      **Modify** `apps/node/src/core/auth-client.ts` (`signInWithEverId`) and `apps/node/src/core/runtime.ts`.
      **Test**: extend `apps/node/src/core/auth-client.spec.ts` — `protect` is called before any other use of the
      access token; the session is returned in a body and no log line contains the token (ACC-12-28 node half).
      **Done when**: the e-mail/password path's tests pass unchanged.

## P1.8 — End to end, docs, ship gate

- [ ] **T30. Playwright suites.**
      **Create** in `apps/web/e2e/` (**new**): `ever-id-sign-in.spec.ts`, `ever-id-sign-up.spec.ts`,
      `ever-id-connect.spec.ts`, `ever-id-backchannel-logout.spec.ts`, `ever-id-disabled.spec.ts`,
      `ever-id-a11y.spec.ts` ([plan §10.4](./plan.md)).
      **Test**: run `pnpm --filter ever-works-web test:e2e ever-id`. Assertions: S1 sign-in with Activity (ACC-12-13),
      replayed callback → S17 (ACC-12-09), foreign `returnTo` → dashboard (ACC-12-12); S2 with terms (ACC-12-14), S3
      (ACC-12-15), S11 (ACC-12-16); within 300 s `auth_time` succeeds (ACC-12-17 browser half), S12 (ACC-12-18),
      disconnect keeps the current session (ACC-12-20); sign-out notice
      ends two Ever ID sessions ≤ 5 s and a password session survives, replayed `jti` → 400 (ACC-12-23, ACC-12-24,
      ACC-12-25); the S6 notice renders on the next page load after a back-channel notice (ACC-12-23 browser half);
      disabled: no button, sign-in endpoints 404, card and notices still work (ACC-12-01, ACC-12-04); axe
      over button, both confirmation screens, card and dialogs (ACC-12-39).
      **Harness limits, stated so the two unrunnable assertions move instead of being dropped:** the PR lane's API is
      an in-memory SQLite database inside the API process, so the browser suite cannot age a `session` row past
      `connectMaxSessionAgeSeconds` (S15 / ACC-12-17) and cannot create the S14 account (no password, no social
      provider, unverified e-mail). Both are proven in **T20**'s integration spec, which writes the rows directly;
      `ever-id-connect.spec.ts` keeps the reachable half of S15 (an expired `auth_time` → the `reauthRequired` copy)
      and the S14 _card_ state, which arrives through the API response rather than the database.
      **Done when**: all pass, and `auth.spec.ts`, `auth-providers-list.spec.ts`, `auth-clock-tolerance.spec.ts`
      and `device-auth.spec.ts` pass **unchanged** (ACC-12-05, ACC-12-39).

- [ ] **T31. Wire acceptance scenarios.**
      **Modify** `docs/specs/features/app-works/ACCEPTANCE.md` (owned by the program; send the rows to its owner if the
      PR cannot edit it) with the APW-12 section mapping ACC-12-01…ACC-12-40 and XP-T/XP-G ids to the test files named
      in T6–T30, T44, T45 and [`cross-platform.md`](./cross-platform.md) §7.
      **Test**: a review check that every `ACC-12-` id of spec §8 appears in a Test line of this file and in
      ACCEPTANCE.md with a file path (`grep -o "ACC-12-[0-9]*" spec.md tasks.md | sort -u` compared).
      **Done when**: every ACC-12 ID maps to at least one test file.

- [ ] **T32. Admin health and telemetry.**
      **Modify** `apps/api/src/auth/controllers/ever-id.controller.ts` — implement `POST /admin/test` and
      `GET /admin/health`. **Create** `packages/monitoring/src/posthog/ever-id-events.ts` (**new**) — the closed event
      union of [plan §9.1](./plan.md), following `packages/monitoring/src/posthog/kb-events.ts`; **modify**
      `packages/monitoring/src/posthog/index.ts` to export it.
      **Availability and health are shared state, not per-process state (spec FR-5, FR-14).** Plugin availability
      today is registry state inside one API process (`packages/agent/src/facades/oauth.facade.ts` checks
      `state === 'loaded'`), so an issuer-drift lock-out set on one replica and a re-test run on another would
      disagree, and `GET /admin/health` would answer differently per replica. This task therefore persists
      `unavailableSince` plus the three health timestamps (`discoveryRefreshedAt`, `jwksRefreshedAt`,
      `lastLogoutNoticeAt`) in the plugin's own settings row (the persisted settings JSON the plugin already owns),
      reads them through a cache of **at most 60 seconds** so FR-5's disable bound holds, and clears
      `unavailableSince` only when `testConnection` passes. No new table.
      **Test**: `apps/api/src/auth/services/ever-id-telemetry.spec.ts` (**new**) — every §9.1 payload built by the
      services contains no e-mail, subject, issuer URL, token, code or `state` (ACC-12-37 telemetry half);
      `packages/monitoring/src/posthog/__tests__/ever-id-events.spec.ts` (**new**) pins the event names; extend
      `apps/api/src/auth/controllers/ever-id.controller.spec.ts` — both admin routes refuse non-admins, a
      `testConnection` failure records `unavailableSince` and a later green run clears it, and **two service
      instances sharing the persisted settings see the same availability and the same health timestamps** (the
      replica-agreement case).
      **Done when**: ACC-12-37 holds for telemetry as well as Activity (T45), and a second instance reading the
      store observes a disable within 60 s without a restart.

- [ ] **T33. Docs.**
      **Create** `docs/features/ever-id.md` (**new**; what Ever ID is on Ever Works, connecting, disconnecting, terminal
      sign-in; the copy rule applies). **Modify** `docs/plugin-system/built-in-plugins.md` (add `oidc-identity`,
      Constitution VIII), `docs/features/api-keys.md` (one line pointing terminals to device sign-in),
      `docs/specs/features/app-works/README.md` §1 (confirm the **Connected identity** row), `TRACKER.md` (APW-12 P1
      status). Add `docs/features/ever-id.md` to `apps/docs/sidebarsPlatform.ts` **only in the PR that enables Ever ID in
      production** (G-09 copy rule).
      **Test**: run `pnpm --filter ever-works-docs build`; `grep -i "sso\|single sign-on" docs/features/ever-id.md`
      finds nothing.
      **Done when**: `pnpm --filter ever-works-docs build` has no broken links.

- [ ] **T34. P1 ship gate.**
      Root `format`, `lint`, `type-check`, `test`, `build` green; ACC-12-01…ACC-12-39 walked on stage with the
      real provider; rollout per [plan §11](./plan.md) (disabled → staff via flag → general).
      **Modify** `docs/specs/features/app-works/TRACKER.md` — APW-12 P1 row.
      **Test**: the PR lanes run every spec named in T3–T30, T44 and T45; the golden-path
      `apps/web/e2e/flow-ever-id-switch.spec.ts` (APW-13, ACC-E2E-13 (a)) passes against stage.
      **Done when**: the tracker row reads P1 `Verified`.

---

# Phase P2 — Ever Teams ([`cross-platform.md`](./cross-platform.md) §4)

- [ ] **T35. Gauzy API slice, default off** (tracked in `ever-co/ever-gauzy`).
      **Create** `packages/core/src/lib/auth/external-identity/` (entity, module, service, TypeORM and MikroORM
      repositories, `ever-id-token.service.ts`) and one migration in
      `packages/core/src/lib/database/migrations/`. **Modify** `packages/contracts/src/lib/feature.model.ts`
      (`FEATURE_EVER_ID_API`), `packages/common/src/lib/guards/feature-flag-enabled.guard.ts` (strict `'true'`),
      `packages/core/src/lib/auth/auth.controller.ts` and `packages/core/src/lib/auth/auth.service.ts` (the four routes
      and token metadata of cross-platform §4.1).
      **Test** (tracked in `ever-co/ever-gauzy`, run `yarn nx test core` and `yarn nx test common`):
      `packages/core/src/lib/auth/external-identity/ever-id-token.service.spec.ts` (same rejection table as T7);
      `packages/core/src/lib/auth/external-identity/external-identity.service.spec.ts` (XP-T-03);
      `packages/core/src/lib/auth/external-identity/ever-id-backchannel-logout.spec.ts` (XP-T-04);
      `packages/core/src/lib/auth/auth.controller.ever-id.spec.ts` (XP-T-01, XP-T-02, XP-T-06);
      `packages/common/src/lib/guards/feature-flag-enabled.guard.spec.ts` (XP-T-06).
      **Done when**: XP-T-06 holds and Gauzy's existing auth suites (`auth.service.login-attempt.spec.ts`,
      `auth.service.register-employee.spec.ts`, `strategies/jwt.strategy.spec.ts`) pass unchanged.

- [ ] **T36. Ever Teams sign-in and connect** (tracked in `ever-co/ever-teams`).
      **Modify** `apps/web/core/lib/utils/check-provider-env-vars.ts`,
      `apps/web/core/types/generics/enums/social-accounts.ts`, `apps/web/core/services/server/requests/auth.ts`,
      `apps/web/auth.ts`, `apps/web/core/services/server/requests/o-auth.ts`,
      `apps/web/core/components/auth/social-logins-buttons.tsx`,
      `apps/web/app/[locale]/(main)/settings/personal/page.tsx` (cross-platform §4.2). **Create**
      `apps/web/cypress/support/mock-ever-id-provider.mjs` beside the existing `mock-gauzy-server.mjs`.
      **Test** (tracked in `ever-co/ever-teams`; Jest via `yarn test:web`, Cypress via `yarn e2e:web`):
      `apps/web/core/lib/utils/check-provider-env-vars.test.ts` (XP-T-06), `apps/web/core/services/server/requests/o-auth.test.ts`
      (XP-T-02), `apps/web/core/services/server/requests/auth.test.ts` (token only in the `Authorization` header),
      `apps/web/auth.test.ts` (XP-T-01, XP-T-02), `apps/web/app/[locale]/(main)/settings/personal/page.test.tsx`
      (XP-T-03); Cypress `apps/web/cypress/e2e/ever-id-sign-in.cy.ts` (XP-T-01, XP-T-02, XP-T-05),
      `apps/web/cypress/e2e/ever-id-connect.cy.ts` (XP-T-03), `apps/web/cypress/e2e/ever-id-backchannel-logout.cy.ts`
      (XP-T-04) — against the fake provider and a Gauzy development API.
      **Done when**: XP-T-01…XP-T-05 hold on Teams stage.

- [ ] **T37 (parallel with T36). App Launcher token for Teams** (tracked in `ever-co/ever-teams`).
      **Create** `apps/web/app/api/auth/ever-id/token/route.ts` — a same-origin route returning the current Ever ID
      access token for APW-11's `getAccessToken()` (body only, `Cache-Control: no-store`, ≤ 900 s left).
      **Test** (tracked in `ever-co/ever-teams`): `apps/web/app/api/auth/ever-id/token/route.test.ts` — no token in the
      URL or headers other than the body, `Cache-Control: no-store`, refuses a token with ≤ 0 s left (XP-T-05).
      **Done when**: APW-11's delegated read works from Teams stage and ACC-12-33 holds cross-origin.

- [ ] **T38. P2 rollout gate.** _(operator attestation)_
      Owner approval recorded; `FEATURE_EVER_ID_API=true` on Gauzy production with only the Teams client trusted;
      Teams production enabled; existing Teams and Gauzy sign-ins exercised end to end before and after.
      **Modify** `docs/specs/features/app-works/TRACKER.md` — APW-12 P2 row (flags are operator configuration, not files).
      **Test**: T35–T37's suites green in both repositories on the released commits; the before/after sign-in runs are
      recorded in the private operations change log as `apw12-p2-rollout`.
      **Done when**: XP-T-01…XP-T-06 verified in production and the tracker row reads P2 `Verified` (ACC-12-40 for Ever
      Teams).

---

# Phase P3 — Ever Gauzy ([`cross-platform.md`](./cross-platform.md) §5)

- [ ] **T39. Gauzy API sign-in with hand-off** (tracked in `ever-co/ever-gauzy`).
      **Create** `packages/auth/src/lib/ever-id/ever-id.strategy.ts`, `ever-id.controller.ts`, `index.ts`, and
      `packages/core/src/lib/auth/external-identity/ever-id-handoff.service.ts`.
      **Modify** `packages/auth/src/lib/internal.ts`, `packages/contracts/src/lib/feature.model.ts`
      (`FEATURE_EVER_ID_LOGIN`), `packages/common/src/lib/guards/feature-flag-enabled.guard.ts`,
      `packages/core/src/lib/auth/auth.controller.ts` (`POST /auth/signin.ever-id.handoff`).
      **Test** (tracked in `ever-co/ever-gauzy`, run `yarn nx test auth` and `yarn nx test core`):
      `packages/auth/src/lib/ever-id/ever-id.strategy.spec.ts` (S256, nonce — XP-G-03),
      `packages/auth/src/lib/ever-id/ever-id.controller.spec.ts` (callback address has no token or user id — XP-G-03;
      flag unset → 404 — XP-G-04), `packages/core/src/lib/auth/external-identity/ever-id-handoff.service.spec.ts`
      (single use, 60 s, verifier — XP-G-02).
      **Done when**: XP-G-02…XP-G-04 hold.

- [ ] **T40. Gauzy web UI** (tracked in `ever-co/ever-gauzy`).
      **Modify** `packages/ui-auth/src/lib/components/social-links/social-links.component.ts` (+ template),
      `packages/ui-auth/src/lib/auth.routes.ts`,
      `packages/ui-core/shared/src/lib/user/edit-profile-form/edit-profile-form.component.ts`. **Create**
      `packages/ui-auth/src/lib/components/ever-id-complete/`.
      **Test** (tracked in `ever-co/ever-gauzy`): extend `packages/ui-auth/src/lib/components/social-links/social-links.component.spec.ts`
      (no Ever ID link unless the flag is exposed — XP-G-04), `packages/ui-auth/src/lib/components/ever-id-complete/ever-id-complete.component.spec.ts`
      (redeems the hand-off, routes to workspace selection — XP-G-01); Playwright
      `apps/gauzy-e2e/tests/ever-id-sign-in.spec.ts` (sign-in to one of two linked workspaces, an unlinked one absent —
      XP-G-01), run `yarn nx e2e gauzy-e2e`.
      **Done when**: XP-G-01 holds on Gauzy stage.

- [ ] **T41. MCP authorization server federated login** (tracked in `ever-co/ever-gauzy`).
      **Modify** `packages/auth/src/lib/mcp/server/oauth-authorization-server.ts` and
      `apps/mcp-auth/src/mcp-oauth/mcp-oauth.service.ts` (cross-platform §5.3).
      **Test** (tracked in `ever-co/ever-gauzy`, run `yarn nx test auth` and `yarn nx test mcp-auth`):
      `packages/auth/src/lib/mcp/server/oauth-authorization-server.ever-id.spec.ts` (a PKCE authorization completed
      through Ever ID login; e-mail/password login unchanged with the flag off and on) and
      `apps/mcp-auth/src/mcp-oauth/mcp-oauth.service.spec.ts` (flag unset → no federated route) (XP-G-05).
      **Done when**: XP-G-05 holds on stage.

- [ ] **T42. P3 rollout gate — production last.** _(operator attestation)_
      Backups verified per the operations runbook; every existing Gauzy sign-in method exercised on stage; owner
      approval; `FEATURE_EVER_ID_LOGIN=true` in production, then `MCP_AUTH_EVER_ID_ENABLED=true` in a separate
      change; rollback is a flag flip.
      **Modify** `docs/specs/features/app-works/TRACKER.md` — APW-12 P3 row (flags are operator configuration, not files).
      **Test** (tracked in `ever-co/ever-gauzy`): existing `apps/gauzy-e2e/tests/login.smoke.spec.ts` and
      `apps/gauzy-e2e/tests/bdd/features/login.feature` against stage plus each configured social sign-in (XP-G-06); run
      links and the backup verification recorded in the private operations change log as
      `apw12-gauzy-stage-signin-regression`.
      **Done when**: XP-G-06 and ACC-12-40 are verified and the tracker row reads P3 `Verified`.

---

# Cross-phase closing tasks

- [ ] **T43. Statuses.**
      **Modify** `docs/specs/features/app-works/APW-12-ever-id/spec.md`, `plan.md`, `tasks.md` and `cross-platform.md` —
      `Status` to `Implemented` / `Done`; confirm every gate in [plan §12](./plan.md) against merged code, and keep the
      "known gaps" list current.
      **Test**: `grep -n "Status" docs/specs/features/app-works/APW-12-ever-id/*.md` shows `Implemented` or `Done` on the
      four files; `npx prettier --check` passes on them.
      **Done when**: plan §12 has no unticked item and TRACKER.md shows APW-12 P1–P3 `Verified`.

- [ ] **T44. Characterise the existing terminal browser sign-in.** _(lands before T28)_
      **Create** `apps/cli/src/commands/auth/__tests__/login.command.browser-flow.spec.ts` (**new**) — no production code
      change.
      **Test**: that spec — `login` without `--ever-id` still runs the existing loopback browser hand-off of
      `apps/cli/src/commands/auth/oauth.service.ts`, accepts the credential it returns and stores it exactly where it
      does today; `--manual` still prompts for a token; neither path imports or calls `ever-id-device.service.ts`
      (ACC-12-32); run `pnpm --filter ever-works-cli test`. The hand-off's mechanism is **not restated here**: this
      public repository describes existing, unfixed weaknesses generically (Resolution R-14), and a task that must not
      touch a file names the file and nothing more. The exact reproduction lives in the private operations repository.
      **Done when**: the spec passes on `develop` before T28 and unchanged after T28.

- [ ] **T45. Activity rows audit (FR-49).**
      **Create** `apps/api/src/auth/services/ever-id-activity.spec.ts` (**new**) — no production code change unless it
      fails.
      **The configuration-change row is driven through the plugin-settings update path** (`PluginsController`'s
      settings save, which already logs the generic `PLUGIN_CONFIGURED` event for every plugin): a listener filtered
      to the `identity-provider` capability writes `IDENTITY_PROVIDER_CONFIG_CHANGED` ([plan §5.6](./plan.md)); it is
      installed by the task that adds the administrator surface (T51), and this spec drives it by saving settings
      through that controller's service, not by calling `ActivityLogService` itself.
      **Test**: that spec drives sign-in, sign-up, connect, disconnect, a back-channel notice, device sign-in, a first
      delegated read and a configuration change through the services with a capturing `ActivityLogService`: the
      `action` values equal plan §5.6's eight (each dotted, with the snake-case `actionType` family, Resolution R-2), a
      second delegated read by the same client within 24 h adds no row, and no serialised row contains a planted token,
      code, subject or `state` (ACC-12-37); run `cd apps/api && pnpm test -- ever-id-activity`.
      **Done when**: the spec passes and removing any one Activity call from the services makes it fail.

- [ ] **T46 (P1, lands with T9–T11). Classify new tables for workspace backup (R-25).**
      **Modify** `packages/agent/src/account-transfer/backup/redaction.ts` — `BACKUP_DROPPED_ENTITIES` gains
      `ExternalIdentity`, beside `AuthSession` and `AuthAccount` under the sessions-and-auth comment: an issuer +
      subject link is a sign-in binding, and a restore must never re-link an account to an identity.
      `packages/agent/src/account-transfer/backup/collectors/domain-specs.ts` is **not** modified. T10's
      `externalIdentityId` and `externalSid` need no entry: `AuthSession` (table `session`) is already dropped entirely.
      **Test**: extend `packages/agent/src/account-transfer/backup/collectors/collectors.spec.ts` — `ExternalIdentity`
      and `AuthSession` are in `BACKUP_DROPPED_ENTITIES` and referenced by no domain file; `redaction.spec.ts`'s
      `it.each(BACKUP_DROPPED_ENTITIES)` covers the new entry with no edit.
      **Done when**: `pnpm --filter @ever-works/agent test -- collectors redaction` is green and a backup of a workspace
      whose owner connected Ever ID contains no `ExternalIdentity` row and not the linked subject anywhere in the
      archive.

---

# Appended tasks (additive — added 2026-09-17; the tasks above keep their numbers)

- [ ] **T47 (P1, after T6). Close the provider gate with the in-product Test connection.**
      Runs the Ever Works administrator **Test connection** (T6, the `POST /admin/test` route of [plan §5.1](./plan.md))
      against the **development** provider and records the result in the private operations change log as
      `apw12-provider-standup`, completing the half of T2 that needs P1 code. T2 itself closes on the manual
      discovery-document read, so P0 no longer waits for P1 and P1 no longer waits on a tick that needs P1.
      **Modify** nothing in this repository; `docs/specs/features/app-works/TRACKER.md` gets the APW-12 P0 note only
      after this run and T2's manual read both hold.
      **Test**: every FR-3 check returns `ok: true` in one run of `POST /admin/test` against the development
      provider, and the same run's copy matches spec §6.7 one row per check id.
      **Done when**: the recorded run shows every check green, or the failing check is filed as a defect against the
      provider's configuration and D1 is revisited per [`idp-options.md`](./idp-options.md) §5 (a re-run of the §4
      scoring, not a rewrite of the relying parties).

- [ ] **T48 (P1). Wire the fake identity provider and the plugin into the Playwright PR lane.**
      `ACCEPTANCE.md` §0.2 requires the `ever-id` flag **on**, with `oidc-identity` configured against the fake
      provider, for the `ever-id-*.spec.ts` suites — and nothing builds that lane today: the plugin is
      `autoEnable: false` ([plan §4.2](./plan.md)), the fake starts "on a free port" ([plan §10.4](./plan.md)), the API
      reads its issuer from settings or `EVER_ID_ISSUER_URL` (spec FR-14 turns sign-in off on issuer drift), and
      `.github/workflows/e2e.yml`'s API env block carries no `EVER_ID_*` variable. Additive: the existing GitHub
      fake (APW-13 T13) is untouched.
      **Create** `apps/web/e2e/helpers/ever-id.ts` (**new**) — starts the T8 fake provider on a **fixed** port before
      the API boots, writes its issuer into the lane's API environment and enables the plugin once through the admin
      plugin API (the same call the administrator surface uses, T51), and exposes `disableEverId()` / `enableEverId()`
      for the disabled spec.
      **Modify** `.github/workflows/e2e.yml` (the API env block: `EVER_ID_ISSUER_URL`, `EVER_ID_CLIENT_ID`,
      `EVER_ID_CLIENT_SECRET` pointing at the fake, and the port the helper uses), `apps/web/e2e/global-setup.ts`,
      `apps/web/package.json` (the workspace dependency that exposes the plugin's `./testing` export) and
      `apps/web/playwright.config.ts` if the helper needs a project ordering.
      **Test**: `apps/web/e2e/ever-id-sign-in.spec.ts` passes in the PR lane with the plugin disabled at boot and
      enabled by the helper — proving the issuer the API validates is the fake's fixed issuer, not a drifted one; and
      `ever-id-disabled.spec.ts` turns the plugin off per test through the same helper and restores it in `afterEach`,
      so no spec depends on ordering.
      **Done when**: the whole `ever-id-*` suite runs green in one `pnpm --filter ever-works-web test:e2e ever-id`
      invocation in the PR lane, with no `EVER_ID_*` value pointing anywhere but the in-lane fake.

- [ ] **T49. Activity surfaces for the five new action types.**
      The five additive members of [plan §5.6](./plan.md) are new to the web: today
      `apps/web/src/components/activity-log/ActivityTypeBadge.tsx` (`TYPE_COLORS`, `TYPE_TO_I18N`) and
      `apps/web/src/components/activity-log/ActivityFilters.tsx` (`ACTION_TYPES`) carry no entry for
      `identity_linked`, `identity_unlinked`, `user_logout`, `delegated_access` or
      `identity_provider_config_changed`, so those rows would render with the default badge and no filter label.
      **Modify** `apps/web/src/components/activity-log/ActivityTypeBadge.tsx`,
      `apps/web/src/components/activity-log/ActivityFilters.tsx` and `apps/web/messages/en.json` (plus the other 20
      locale files) with one colour, one i18n label and one filter entry per member; the **summary** string of each row
      comes from the API (§5.6) and is rendered as it arrives — the web does not re-derive it.
      **Test**: extend `apps/web/src/components/activity-log/ActivityTypeBadge.unit.spec.tsx` and
      `ActivityFilters.unit.spec.tsx` (or create them) with a table over **every** `ActivityActionType` member,
      asserting a badge colour and a non-default label for each — so a future member cannot ship unlabelled; run
      `pnpm --filter ever-works-web test -- activity-log`.
      **Done when**: an Activity list containing all eight FR-49 rows renders eight distinct labels, and the
      exhaustive table fails if a member is added without a surface.

- [ ] **T50. Node sign-in with Ever ID has a person-facing caller.**
      FR-39 says a node can sign in with device authorization, and T29 changes
      `apps/node/src/core/auth-client.ts` — but the only caller of node credential sign-in today is the desktop app
      (`apps/desktop-node/src/main/main.ts:262`, `enrollNodeWithCredentials({ … })` with e-mail and password), which
      has no device-code path and no prompt, so the node half of ACC-12-28 cannot be observed by a person. Additive:
      the e-mail/password enrolment stays exactly as it is and remains the default.
      **Modify** `apps/desktop-node/src/main/main.ts` (a second enrolment mode beside the credentials branch),
      `apps/desktop-node/src/shared/ipc-contract.ts` (the channel carrying the verification address, the user code and
      the outcome), `apps/desktop-node/src/renderer/wizard/WizardView.tsx` and
      `apps/desktop-node/src/renderer/wizard/steps.ts` (a step that shows the verification address and code and waits).
      **Create** none outside those files except the spec below.
      **Test**: extend `apps/desktop-node/src/renderer/wizard/steps.spec.ts` and add
      `apps/desktop-node/src/main/ever-id-enrol.spec.ts` (**new**) — the device mode prints only the verification
      address and the code, the access token is dropped after the exchange, no log line or renderer state contains it,
      and the credentials mode is byte-for-byte unchanged (ACC-12-28 node half). If the owner prefers the Ever ID path
      to be CLI-only for nodes, this task is discharged by naming the node CLI entry point and its spec instead — the
      choice is recorded here rather than left implicit.
      **Done when**: a person can complete node enrolment with Ever ID from the desktop app, and the existing
      credentials enrolment passes its tests unchanged.

- [ ] **T51 (P1). Administrator surface for Ever ID, and the configuration-change Activity row.**
      Spec S10 and §6.7 describe a **Test connection** button with one row per FR-3 check, a **Health** section and a
      `•••••• (set)` secret display; the plan has the two API routes (T32) but no page, and FR-4 requires an Activity
      row for every configuration change. The existing generic `POST plugins/:pluginId/validate-connection` returns
      `ConnectionValidationResult { success, message }` — one line, not the per-check rows the spec asks for — and
      settings saves already emit the generic `PLUGIN_CONFIGURED`; nothing emits
      `auth.ever_id.config_changed` yet, although T45 drives "a configuration change through the services".
      **Create** `apps/web/src/app/[locale]/(dashboard)/settings/admin/ever-id/page.tsx` and its client (**new**),
      rendering the FR-2 settings form, the Test connection rows from `POST /api/auth/ever-id/admin/test`, the Health
      block from `GET /api/auth/ever-id/admin/health`, and the secret as `•••••• (set)`.
      **Modify** the settings surface's navigation/registration, the plugin-settings save path (a listener filtered to
      the `identity-provider` capability that writes `IDENTITY_PROVIDER_CONFIG_CHANGED` with `{ fields }` metadata —
      the generic `PLUGIN_CONFIGURED` row stays as it is), and `apps/web/messages/en.json` plus the other 20 locale
      files for the §6.7 copy (T27).
      **Test**: `apps/web/src/app/[locale]/(dashboard)/settings/admin/ever-id/page.unit.spec.tsx` (**new**) — one row
      per check id with its `✓`/`✗` copy, the Health labels, the secret never rendered; extend the
      `ever-id-activity` spec (T45) so a save through this path writes exactly one `auth.ever_id.config_changed` row
      listing the changed fields and no secret; the page passes the same axe check as the card (ACC-12-39).
      **Done when**: an administrator can change a setting and see the change in Activity, and the connection test
      renders one row per check without exposing the secret.

- [ ] **T52 (P2 and P3, before T36 and T39). File the cross-repository issues.**
      The Teams and Gauzy halves of this epic are tracked in `ever-co/ever-teams` and `ever-co/ever-gauzy`, where
      nothing exists today — no issue, branch or spec. The issue bodies are drafted:
      [`cross-repo-issues/ever-teams.md`](./cross-repo-issues/ever-teams.md) and
      [`cross-repo-issues/ever-gauzy.md`](./cross-repo-issues/ever-gauzy.md), with the index and the rules both
      repositories follow in [`cross-repo-issues/README.md`](./cross-repo-issues/README.md).
      **Modify** `docs/specs/features/app-works/APW-12-ever-id/tasks.md` (T31) so the `XP-T-*` / `XP-G-*` rows
      carry the issue links once they exist.
      **Test**: a review check — each drafted issue body's cited paths were re-opened at the target repository's
      current head before filing, and the index table carries the filed issue numbers.
      **Done when**: both issues exist, are linked from the index, and the Gauzy one records that its production
      flag is a separate owner-approved change ([`cross-platform.md`](./cross-platform.md) §5, T42).

- [ ] **T53 (P2, with APW-11). Confirm the launcher mounts in one other Ever platform.**
      APW-11 T28's Done-when requires at least one other Ever platform to load the published launcher; the Teams
      token route is T37 here, and the mount itself lives in
      [`APW-11/cross-platform.md`](../APW-11-app-launcher/cross-platform.md) (APW-11 owns the component and the
      header mount; this epic owns the token it reads). Until that file exists, the mount is unnamed and the
      launcher's cross-origin read cannot be verified end to end.
      **Test** (tracked in `ever-co/ever-teams`): the mount renders the launcher for a signed-in person and
      `apps/web/app/api/auth/ever-id/token/route.test.ts` (T37) proves the token never travels in a URL; the
      launcher's delegated read then answers for that person's App Works (ACC-12-33 cross-origin half).
      **Done when**: one Ever platform other than Ever Works renders the launcher with live tiles, and the
      token route's body-only guarantee is asserted there.

---

## Definition of Done

- Every checkbox above is ticked.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test` and `pnpm build` are green from the Ever
  Works repository root; Ever Teams and Ever Gauzy CI are green for their tasks.
- Every pre-existing sign-in test in all three repositories passes **unchanged**.
- ACC-12-01…ACC-12-40, XP-T-01…XP-T-06 and XP-G-01…XP-G-06 have been walked against running builds.
- No hostname, address or secret was added to any public repository.
- No suite for this epic lives under `apps/api/test/` (Resolution R-22).
- Every gate in [plan §12](./plan.md) is confirmed, and the carried-forward gaps are still recorded there.

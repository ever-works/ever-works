# Decision record: the identity provider behind Ever ID

**Epic**: [`APW-12-ever-id`](./spec.md) · **Answers**: program open question 6 ([`../README.md`](../README.md) §8)
**Status**: `Decided` — the provider is **ZITADEL**, self-hosted (**owner decision, 2026-09-17**). The
provider-choice question (§6 D1) is closed; the _configuration_ rows in §6 (domain, hosting tier, brokering,
audience strategy, registration, consent, MFA policy, cross-product federation) are still open. The owner's
binding constraints on how it integrates are §7.
**Created**: 2026-09-17 · **Facts as of**: the 2026-09 review; every "verify" item is re-checked against the
product's release notes on the day the decision is made.

> **Scope.** Which self-hostable OpenID Connect provider runs Ever ID. Where and how it is hosted is
> recorded in the private operations repository; this public record contains no hostnames, addresses or
> infrastructure detail.

---

## 1. Context

- Ever ID must be a **dedicated** identity provider. Program decision D14: Ever Works is not the identity
  root for production platforms, because it runs agents and user-controlled code and ships several times a
  day.
- Relying parties integrate through **standard OpenID Connect** only ([`plan.md`](./plan.md) §4,
  [`cross-platform.md`](./cross-platform.md) §1), so this choice is reversible at the cost described in §5.
- **Each product line keeps its own identity infrastructure.** Whatever other product lines run, **the Ever
  instance is separate** — its own deployment, database, signing keys, domain and administrators — whichever
  product is chosen. Prior operating experience with a candidate informs the operations score below; it is never a
  reason to share an instance. Details of any existing deployment stay in the private operations repository.

## 2. Requirements (numbers are binding)

| #   | Requirement                                                                                                                        | Source                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| R1  | Authorization code flow with **PKCE S256 enforceable per client**                                                                  | spec FR-8                     |
| R2  | **Device authorization grant** (RFC 8628) for public clients, code lifetime configurable to 900 s, polling interval ≥ 5 s          | spec FR-39–41                 |
| R3  | **OpenID Connect back-channel logout** with `sid`, per-client logout URI                                                           | spec FR-33–35                 |
| R4  | Custom scopes (`apps:read`, `ever-works:session`) placed in access tokens with a **controllable audience** (`ever-works`, `gauzy`) | spec FR-40, FR-44             |
| R5  | Access token lifetime settable to 900 s; signing algorithms RS256, ES256 or EdDSA; key rotation with overlap                       | spec FR-11, FR-45             |
| R6  | **≥ 3 replicas** with no single point of failure besides the database; rolling upgrades without downtime                           | program infrastructure rule   |
| R7  | Linking of upstream identities (Google, GitHub) to an existing account **only after re-authentication**, never automatic by e-mail | spec FR-22, cross-platform §2 |
| R8  | Passkeys (WebAuthn) and TOTP for people who want them                                                                              | security baseline             |
| R9  | Admin API or configuration-as-code for clients, scopes and mappers                                                                 | operations                    |
| R10 | Import of users **with preserved subject identifiers**                                                                             | reversibility (§5)            |
| R11 | Future: SAML brokering and per-organisation identity providers for enterprise identity (launch-parity G-09)                        | roadmap, not P1               |
| R12 | License compatible with operating a hosted service                                                                                 | legal                         |

## 3. Options

### 3.1 Keycloak

- **License**: Apache-2.0. Cloud Native Computing Foundation project. Java (Quarkus).
- **HA**: clustered replicas with a distributed cache and a shared PostgreSQL; a Kubernetes operator exists.
- **Protocol**: OpenID Certified; PKCE enforceable per client; device authorization grant; front-channel and
  back-channel logout; RP-initiated logout; client scopes with audience mappers; standard token exchange in
  recent releases (verify version).
- **Linking**: identity brokering with a "first broker login" flow that can require the person to
  re-authenticate before an upstream identity is linked to an existing account.
- **Multi-tenant**: realms; an Organizations feature in recent releases.
- **Operations**: the heaviest runtime of the set (JVM memory per replica, cache tuning); frequent but
  well-documented upgrades with automatic database migrations.
- **Maturity**: over ten years, large contributor and operator base.
- **Fit notes**: meets R1–R12. Ever Gauzy already contains a vendor-specific Keycloak strategy, but Ever ID
  deliberately integrates through a generic strategy instead (cross-platform §5.1).

### 3.2 ZITADEL

- **License**: AGPL-3.0 for the server since its 2025 major release (earlier releases Apache-2.0; verify the
  current split for SDKs). Running it unmodified as a service carries no source obligation beyond AGPL's
  terms; Ever's own platforms are AGPL-3.0 already.
  **Verified 2026-09-17 against the repository's own `LICENSING.md`:** the server is **AGPL-3.0-only**;
  **`apps/login/` is MIT**, `packages/zitadel-client/` and `packages/zitadel-proto/` are MIT, and `proto/` plus
  `apps/docs/` are Apache-2.0. So login-UI work is not an AGPL exercise, the parts one most wants to change are
  permissive, and no permanent fork is planned (see §7). Pinning a version means recording _that version's_
  licence: an older (pre-2025) release would be Apache-2.0 instead.
- **HA**: stateless Go replicas over PostgreSQL; the newer login UI is a separate deployment.
- **Protocol**: OpenID Certified; PKCE; device authorization grant; back-channel logout (added in recent
  releases — verify it is generally available); token exchange (verify maturity); project roles and audience
  scopes.
- **Linking**: external identity providers with configurable linking prompts; automatic e-mail linking can be
  switched off.
- **Multi-tenant**: instances and organisations — the strongest model of the set; SAML supported.
- **Operations**: light-to-medium; frequent major versions with login-UI migrations.
- **Maturity**: company-backed since 2019; fast-moving.

### 3.3 authentik

- **License**: MIT for the open-source core; some features under a separate enterprise license.
- **HA**: several server and worker replicas over PostgreSQL (recent releases dropped the separate cache
  dependency — verify).
- **Protocol**: OAuth2/OpenID provider with PKCE and device code flow; back-channel logout in recent releases
  (verify); no standard token exchange (verify).
- **Linking**: sources with configurable user-matching modes; e-mail-based modes must stay disabled.
- **Multi-tenant**: brands for branding; tenant isolation is an enterprise feature.
- **Operations**: medium; very flexible flows and stages, which also means more configuration to review.
- **Maturity**: since 2018, company-backed.

### 3.4 Ory Hydra + Ory Kratos

- **License**: Apache-2.0 for the open-source servers; some capabilities only in commercial builds or the
  hosted network.
- **HA**: stateless Go services over SQL; horizontally scalable.
- **Protocol**: Hydra is OpenID Certified; PKCE; back-channel and front-channel logout; device authorization
  in recent releases (verify); no standard token exchange in the open-source build (verify).
- **Linking**: Kratos links social sign-in to an existing identity after re-authentication.
- **Multi-tenant**: one tenant per deployment in the open-source build; no SAML in open-source Kratos.
- **Operations**: the highest integration effort — two services, a courier, and **a login and consent UI we
  would build and maintain**.
- **Maturity**: high (Hydra since 2015).

### 3.5 Rauthy

- **License**: Apache-2.0. Rust, single binary.
- **HA**: embedded Raft-replicated storage across 3 nodes, or PostgreSQL.
- **Protocol**: PKCE (enforceable); device authorization grant; back-channel logout; RP-initiated logout;
  custom scopes and attributes; audience control for a second API and token exchange not confirmed (verify).
- **Linking**: upstream providers can be linked to an existing account from the signed-in account page.
- **Passkeys**: first-class, including passkey-only accounts.
- **Multi-tenant**: none (no realms or organisations); no SAML.
- **Operations**: the lightest of the set (tens of megabytes of memory).
- **Maturity**: younger, pre-1.0 versioning, small maintainer base.

### 3.6 Ever Works as the provider (Better Auth OpenID provider plugin)

- **License**: MIT (Better Auth). Runs inside the Ever Works API, which already uses Better Auth.
- **HA**: inherits the API's replicas and database.
- **Protocol**: authorization code with PKCE, consent, dynamic client registration and signed ID tokens
  through the JWT plugin; a device authorization plugin exists; **no back-channel logout** (verify).
- **Linking**: Better Auth's account linking trusts providers by e-mail — the opposite of R7; would need to be
  disabled and rebuilt.
- **Multi-tenant**: the organisation plugin.
- **Operations**: nothing new to deploy — but every Ever platform's sign-in would depend on Ever Works'
  availability and deploy cadence.
- **Maturity**: the provider plugins are young and still changing.
- **Blocking**: violates D14 (identity root inside the platform that runs agents and user code) and fails R3
  and R7. Not viable for Ever ID; not recommended even as a stopgap, because it creates a second migration.

## 4. Scoring

Scores 0–3 per criterion; weights sum to 100; total = Σ(weight × score) ÷ 3, so 100 is perfect.

| Criterion (weight)                     | Keycloak | ZITADEL | authentik | Ory Hydra + Kratos | Rauthy | Ever Works (Better Auth) |
| -------------------------------------- | -------- | ------- | --------- | ------------------ | ------ | ------------------------ |
| Protocol fit R1–R5 (25)                | 3        | 3       | 2         | 2                  | 2      | 1                        |
| HA R6 (15)                             | 3        | 3       | 2         | 3                  | 2      | 2                        |
| Linking with re-authentication R7 (10) | 3        | 2       | 2         | 2                  | 2      | 1                        |
| Maturity and maintainer depth (15)     | 3        | 2       | 2         | 3                  | 1      | 1                        |
| Operations burden, inverse (10)        | 1        | 2       | 2         | 0                  | 3      | 2                        |
| License fit R12 (5)                    | 3        | 2       | 2         | 2                  | 3      | 3                        |
| Future enterprise identity R11 (10)    | 3        | 3       | 2         | 1                  | 0      | 1                        |
| Reversibility R9–R10 (10)              | 3        | 2       | 2         | 3                  | 2      | 1                        |
| **Total (of 100)**                     | **93**   | **83**  | **67**    | **70**             | **60** | **45** (fails D14)       |

**Sensitivity.** The ranking moves mainly with the operations weight. With operations at 25 and maturity at 5
(re-normalised), Keycloak scores 84 and ZITADEL 82; with operations at 30, maturity at 5 and R11 at 5 they tie.
Under every weighting tried (operations 10–30, maturity 5–15, R11 5–10), Rauthy, authentik and Ory stay below
both.

**Note (2026-09-17).** The table is now the _documented comparison_, not the decider: the owner chose ZITADEL
(§6) weighting footprint and built-in organisations more heavily than the criteria above do — in particular it
scores ZITADEL 2 against Keycloak's 3 on license fit, and that gap is what §7 closes by hosting ZITADEL as-is.
The scores are kept unchanged so a future re-evaluation starts from the same measured baseline.

## 5. Reversibility and migration cost

- Every relying party stores links as (issuer, subject) and accepts **1–3 allowed issuers** at once, so two
  providers can run side by side during a move.
- If the new provider imports users **with their existing subject identifiers** (R10), links survive
  untouched and only the issuer allow-list changes.
- Otherwise each person re-links once through the normal, explicit connect flow; nothing is merged by e-mail.
- Tokens are short-lived (access 900 s), so a cut-over needs no token migration.

## 6. Decision, and what the owner must still decide

**Decided: ZITADEL** — self-hosted, run as a separate Ever instance with at least 3 replicas, integrated only
through standard OpenID Connect (**owner decision, 2026-09-17**). The owner's grounds are a lighter footprint
and built-in organisations, and the licence question is settled: hosted **as-is and unmodified** (§3.2, §7).
**Keycloak stays the documented alternative** and still wins the weighted table in §4 — chiefly on operations
burden and maturity — so if ZITADEL fails one of the verification items below, the fallback is a re-run of that
scoring, not a rewrite of the relying parties: every platform integrates against the discovery document and
accepts 1–3 issuers at once (§5).

| #   | Decision                                                                               | Recommended default                                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Product                                                                                | **ZITADEL — decided by the owner 2026-09-17**                                                                                                                                                                                                                              |
| D2  | Public domain for Ever ID                                                              | **`auth.ever.co` — decided by the owner 2026-09-17** (verified free in the live `ever.co` zone); one instance serves every platform. It is a dedicated name: not under the Ever Works app domain, not under the user-apps domain, and not shared with another product line |
| D3  | Hosting tier                                                                           | a trusted tier separate from any tier running user-controlled code; database backups verified before go-live                                                                                                                                                               |
| D4  | Does Ever ID offer Google, GitHub and Microsoft sign-in (brokering)?                   | yes, with R7 linking                                                                                                                                                                                                                                                       |
| D5  | Audience strategy for platforms that call two APIs (Ever Teams → Gauzy and Ever Works) | one access token per audience via standard token exchange; multi-audience tokens only if D1 lacks exchange                                                                                                                                                                 |
| D6  | Open registration at Ever ID, or invitation only                                       | open, with e-mail verification required before any token carries `email_verified: true`                                                                                                                                                                                    |
| D7  | Consent for first-party `apps:read`                                                    | pre-approved for first-party Ever clients; consent screen for anything else                                                                                                                                                                                                |
| D8  | Multi-factor policy                                                                    | passkeys and TOTP offered; required for Ever ID administrators                                                                                                                                                                                                             |
| D9  | Whether another product line's identity provider ever federates with Ever ID           | no                                                                                                                                                                                                                                                                         |

### 6.1 Provider configuration the relying parties assume (D1 is now decided)

| Setting                          | Value                                                                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clients per environment          | `ever-works-web` (confidential), `ever-works-cli` and `ever-works-node` (public, device grant only), `ever-teams-web`, `ever-gauzy-web`, `ever-gauzy-mcp` (confidential)      |
| Redirect URIs                    | exact strings, no wildcards, one per client per environment                                                                                                                   |
| PKCE                             | S256 required on every client                                                                                                                                                 |
| Access token / ID token lifetime | 900 s / 300 s                                                                                                                                                                 |
| Session                          | idle 7 days, maximum 30 days; refresh-token rotation on for clients that use refresh tokens                                                                                   |
| Device code                      | lifetime 900 s, interval 5 s                                                                                                                                                  |
| Scopes                           | `apps:read` (audience `ever-works`); `ever-works:session` (audience `ever-works`, device clients only)                                                                        |
| Back-channel logout              | URI registered for every web client, session identifier required                                                                                                              |
| Post-logout redirect URI         | the web return route of [`plan.md`](./plan.md) §6.1 / tasks T26, registered per web client and per environment, exact string, no wildcard; the `state` is validated on return |
| Signing keys                     | ES256 or RS256; rotation every 90 days with a 14-day overlap in the published key set                                                                                         |
| E-mail claims                    | `email_verified` true only after the provider's own verification                                                                                                              |

### 6.2 Exit criteria for this record

`Status` becomes `Decided` when D1–D9 are answered in this table (answer, date, decider), the provider passes
Ever Works' **Test connection** on development with every check green (spec FR-3), and the tracker row for
APW-12 P0 is ticked.

**The two halves of that sentence are gated separately (audit fix, 2026-09-17).** Test connection is a P1 screen,
so making `Decided` depend on it created an order deadlock: P0 could not close until P1 shipped, while P1 was
gated on P0. The criteria are therefore split, and both halves still have to hold — only their order changed:

1. **`Status: Decided` (P0)** — D1–D9 answered, **and** the development discovery document read manually against
   [plan §4.3](./plan.md) (issuer, endpoints, `code_challenge_methods_supported` containing `S256`, the signing
   algorithms, back-channel logout support and the device authorization endpoint), recorded in the private
   operations change log as `apw12-provider-standup` (tasks T2).
2. **Provider confirmed in the product (P1)** — the same provider passes the in-product **Test connection**
   (tasks T47, after T6) with every FR-3 check green. A failing check is a defect against the provider's
   configuration and re-opens D1 per §5 — as a re-run of the §4 scoring, never a rewrite of the relying parties.

**As of 2026-09-17:** D1 is answered (**ZITADEL**, owner) and D2 is answered (**`auth.ever.co`**, owner), so the
record's status is `Decided` for the provider and its domain. D3–D9 remain open, and both gate halves above —
the manual discovery read (P0) and the in-product Test connection (P1) — are still outstanding.

---

## 7. Owner constraints on the integration (binding, 2026-09-17)

These come from the owner and bind every platform's Ever ID work. They are additive-only in the same sense as
program rule 1 (NN #20): nothing that authenticates users today is removed, replaced or routed away.

1. **ZITADEL is an addition, never a replacement.** Each platform keeps its own authentication and its own user
   database. Ever Works keeps Better Auth; Ever Gauzy keeps e-mail/password, magic code and its social
   strategies; every other platform keeps whatever it has. Nothing is deleted, deprecated or bypassed. The one
   code move in this program is a **relocation without behaviour change** — the shipped Keycloak code into the
   `keycloak` provider plugin (constraint 5 below), which is an addition at the package level and leaves every
   existing strategy, export and default in place.
2. **Ever ID is the cross-platform SSO layer only.** It answers "who is this person, and do they have an
   account here?" — not "where do profiles live". Account, profile and credential data stay in each platform's
   own database.
3. **Duplicated profiles are accepted.** A person may exist both in a platform's own database and in ZITADEL.
   Links are stored per platform as (issuer, subject); no platform becomes a mirror of ZITADEL, and no
   cross-platform profile merge is implied.
4. **No platform's existing sign-in flow changes.** New flows go through Ever ID; existing ones are untouched
   (spec FR-1…FR-5, [`cross-platform.md`](./cross-platform.md) §1.1).
5. **Ever Gauzy's integration is a plugin, not core.** No ZITADEL code, dependency, strategy, entity or route
   is added to Gauzy core (`packages/core`, `packages/auth/src/lib/internal.ts`, `packages/config`). It ships
   as its own plugin package, registered the way Gauzy's other plugins are (§7.1). The shipped Keycloak
   scaffolding is **relocated into the `keycloak` provider plugin, with its behaviour unchanged** (the
   provider-plugin family in [`cross-platform.md`](./cross-platform.md) §5.1): every strategy, guard, export and
   `'disabled'` placeholder keeps working exactly as it does today, the core registry keeps exporting them
   through the plugin, and no route, default or configuration key is removed. Relocation is the whole change —
   nothing is deprecated, and the code stays reachable for every self-hoster who uses it.
6. **Ever Works integrates through its own plugin architecture** (the `oidc-identity` capability), which is
   already this epic's design.
7. **Host it as-is.** No fork, no patch set. If a change is ever needed the order is configuration → ZITADEL
   Actions → an upstream pull request (no CLA; contributions are accepted under Apache-2.0) → a **published**
   fork as a last resort, which AGPL §13 permits provided the Corresponding Source of the deployed build is
   offered to network users.

### 7.1 What already exists in Ever Gauzy (verified 2026-09-17 against `ever-co/ever-gauzy` @ `origin/develop`)

| Fact                                                                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gauzy has **no working cross-platform SSO** today.                   | No external issuer, no relying-party flow, no discovery document.                                                                                                                                                                                                                                                                                                                                                            |
| It **does** carry dormant Keycloak OIDC scaffolding — with no route. | `packages/auth/src/lib/keycloak/{keycloak.strategy.ts,keycloak-auth-guard.ts}`; exported in `packages/auth/src/lib/internal.ts:6,18` and listed in `AuthGuards = [MicrosoftAuthGuard, KeycloakAuthGuard]` (`:35`); **no controller uses `KeycloakAuthGuard`** — the only `auth/keycloak` string is the strategy's own default callback URL. `cross-platform.md` §3.1 already records "Controllers (no Keycloak controller)". |
| It self-disables when unconfigured.                                  | `parseKeycloakConfig` warns `⚠️ Keycloak authentication configuration is incomplete. Defaulting to "disabled".` and returns `'disabled'` for client id/secret; `KEYCLOAK_*` keys exist in `.env.sample` and every local/compose template.                                                                                                                                                                                    |
| **The existing Keycloak strategy cannot be pointed at ZITADEL.**     | `passport-keycloak-oauth2-oidc@^1.0.5` **hard-codes Keycloak's URL shape** (`lib/strategy.js:86,87,94`): `{authServerURL}/realms/{realm}/protocol/openid-connect/{auth,token,userinfo}`. ZITADEL has no realms and serves `{issuer}/oauth/v2/authorize`, `{issuer}/oauth/v2/token`, `{issuer}/oidc/v1/userinfo`. A **new generic-OIDC strategy** is required — this is not reachable by configuration.                       |
| A working custom-IdP precedent exists to copy.                       | Auth0: `packages/auth/src/lib/auth0/{auth0.strategy.ts,auth0.controller.ts}` — strategy **plus** controller, registered through `SocialAuthModule`.                                                                                                                                                                                                                                                                          |
| Strategies are wired in core today.                                  | `packages/core/src/lib/auth/auth.module.ts:1,52` imports `SocialAuthModule` and calls `SocialAuthModule.registerAsync({…})`; `packages/auth/src/lib/internal.ts` is the registry.                                                                                                                                                                                                                                            |
| **Gauzy has a real plugin mechanism to carry it.**                   | `packages/plugin`: `PluginMetadata extends ModuleMetadata`, so a plugin is a NestJS module and may ship its own controllers, providers, entities, subscribers and configuration; `PluginModule.init()` imports `config.plugins`; `apps/api/src/plugins.ts` lists ~38 `@gauzy/plugin-*` packages, consumed by `apps/api/src/plugin.config.ts`.                                                                                |
| Cost of the plugin route.                                            | A new `packages/plugins/<name>` package, a dependency, and **one import plus one array entry in `apps/api/src/plugins.ts`** — no ZITADEL code in core. Caveat: this is a **new plugin category** (the existing ones are integrations, AI providers and UI) and the plugin hooks are lifecycle/seed-oriented, so the integration lives in the plugin's own module rather than in a core auth extension point.                 |

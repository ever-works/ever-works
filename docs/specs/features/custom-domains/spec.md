# Feature Specification: Custom Domains

**Feature ID**: `custom-domains`
**Status**: `Retrospective`
**Created**: 2026-05-01
**Last updated**: 2026-05-01
**Owner**: Ever Works Team

---

## 1. Overview

Custom Domains let users assign their own domain names (apex or subdomain)
to a work's deployed website, replacing the provider-assigned URL
(e.g. `<slug>.vercel.app`). Domain records are stored in the platform DB
as the source of truth and synced to the deployment provider; users
configure their DNS, the platform verifies, and an auto-promote step
upgrades the work's primary URL away from the provider subdomain
once the custom domain is verified.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** my work is deployed to Vercel, **when** I add
  `tools.example.com` via the API, **then** the domain is saved in the
  DB, pushed to Vercel, and the response includes the DNS records I
  need to configure.
- **Given** I've configured my DNS to point `tools.example.com` at
  Vercel, **when** I trigger verification, **then** the platform asks
  Vercel to verify, gets a positive answer, marks the domain as
  `verified: true`, and auto-promotes my work's URL.
- **Given** my work's primary URL was `<slug>.vercel.app` and my
  custom domain just became verified, **when** auto-promote runs,
  **then** the work's `siteUrl` is updated to the custom domain
  so subsequent links use it.
- **Given** I no longer want a custom domain, **when** I delete it,
  **then** the platform removes it from both the DB and Vercel; future
  requests to it 404 at the provider.

### 2.2 Edge cases & failures

- **Given** my DNS isn't configured yet, **when** I trigger verification,
  **then** the response reports `verified: false` and I can re-run
  after fixing DNS without losing the domain record.
- **Given** I switch deployment providers (Vercel → another), **when**
  the new provider is configured, **then** my domain records persist
  in the DB and can be re-synced to the new provider.
- **Given** I try to add a domain to a work that has no deploy
  provider configured, **when** the request is processed, **then** the
  API returns `400` with a clear "deployment provider required" error.
- **Given** I add a domain that already exists on another work in
  the same provider account, **when** the provider rejects with a
  conflict, **then** the API surfaces the provider error and rolls
  back the DB write.

## 3. Functional Requirements

- **FR-1** The system MUST support apex (`example.com`) and subdomain
  (`blog.example.com`) custom domains.
- **FR-2** The DB MUST be the source of truth for domain records; the
  deployment provider is a downstream sync target.
- **FR-3** Adding a domain MUST persist it in the DB and call the deploy
  provider's "add domain" API; the response MUST include provider DNS
  records the user needs to configure.
- **FR-4** Verification MUST call the deploy provider's "verify" API and
  flip `verified` based on the provider's response.
- **FR-5** When a domain becomes verified AND the work's current
  `siteUrl` is the provider-assigned subdomain, the system MUST
  auto-promote the URL to the custom domain.
- **FR-6** Removing a domain MUST remove it from the DB AND the deploy
  provider in a single atomic operation.
- **FR-7** Domain operations MUST require work edit permission.
- **FR-8** The system MUST allow re-syncing domains to a new provider
  after a provider change without losing records.
- **FR-9** Each domain MUST track `verified`, `environment` (default
  `production`), and `provider` fields.

## 4. Non-Functional Requirements

- **Performance**: domain operations are user-initiated; expect 1–5 s
  end-to-end (round-trip to provider).
- **Reliability**: DB and provider state are eventually consistent; a
  failed provider sync surfaces a retry path without losing the DB row.
- **Security & privacy**: domain operations require work edit
  permission and JWT or API-key auth.
- **Observability**: activity-log entries for add / verify / remove with
  the domain and provider.
- **Compatibility**: domain records survive provider changes — only the
  provider field is rebound.

## 5. Key Entities & Domain Concepts

| Entity / concept  | Description                                                            |
| ----------------- | ---------------------------------------------------------------------- |
| `CustomDomain`    | DB row: `{domain, verified, environment, provider, workId}`       |
| Provider sync     | One-way mirror from DB → deploy provider                               |
| Auto-promote      | Replace work `siteUrl` once a custom domain verifies              |
| DNS record advice | Apex → A record; subdomain → CNAME (provider-specific values returned) |

## 6. Out of Scope

- Multiple deployment environments per work beyond `production` (the
  field exists but only `production` is wired up).
- Wildcard / regex domains.
- Automated DNS provisioning (users always do their own DNS).
- TLS certificate management (deploy provider handles it).

## 7. Acceptance Criteria

- [x] Apex and subdomain both supported with appropriate DNS guidance.
- [x] DB is source of truth; provider sync is one-way.
- [x] Verification flips `verified` and triggers auto-promote when
      appropriate.
- [x] Delete removes from both DB and provider atomically.
- [x] Provider switch preserves domain records.
- [x] Tests cover add / verify / remove / auto-promote / provider conflict.

## 8. Open Questions

- `[NEEDS CLARIFICATION: should domain verification be automatically
re-run on a schedule for verified domains to detect DNS regressions?]`

## 9. Constitution Gates

- [x] **I — Plugin-first**: deploy providers are plugins.
- [x] **II — Capability-driven**: domain operations go through the
      deploy facade; no plugin id hardcoded.
- [x] **III — Source-of-truth repos**: domains describe website routing,
      not content; DB is the right place for them.
- [x] **IV — Trigger.dev**: domain ops are user-initiated and inline.
- [x] **V — Forward-only migrations**: `custom_domains` table is
      additive.
- [x] **VI — Tests**: covered by deploy capability service tests + plugin
      integration tests.
- [x] **VII — Secret hygiene**: provider creds in the plugin-settings
      store; never logged.
- [x] **VIII — Plugin counts**: N/A.
- [x] **IX — Behaviour-first**: this spec describes user behaviour.
- [x] **X — Backwards-compat**: domain shape additive; new providers
      plug in without breaking existing rows.

## 10. References

- User-facing doc: [`../../../features/custom-domains.md`](../../../features/custom-domains.md)
- API ref: [`../../../api/deploy-capability.md`](../../../api/deploy-capability.md)
- Related plugin: `packages/plugins/vercel/`
- Implementation:
  `apps/api/src/plugins-capabilities/deploy/`

# Feature Specification: Agent Zero-Friction Onboarding

> Behaviour-first spec per [Constitution Principle IX](../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> Describe **what** the system does, not how it's structured. Save implementation
> details for `plan.md`. Mark any unresolved questions with `[NEEDS CLARIFICATION: …]`.

**Feature ID**: `agent-zero-friction-onboarding`
**Branch**: `feat/agent-zero-friction-onboarding`
**Status**: `In Review` — all clarifications resolved, implementation shipped to feature branch.
**Created**: 2026-05-04
**Last updated**: 2026-05-05 (v4 — implementation complete, awaiting CI + merge)
**Owner**: ever@ever.co

---

## 1. Overview

AI agents can register with Ever Works and create a fully managed
directory or website in a **single API call** (or a single MCP tool
invocation), with no prior account, no UI, and no human in the loop.
The agent supplies a GitHub repository URL, a GitHub credential, and an
identifying contact (email or agent identifier). The platform validates
the credential, creates an Ever Works account on demand, links it to
the agent's GitHub identity, reads a `.works/works.yml` manifest from the
repository, provisions the supporting repos (website, optional Awesome
list), starts AI content generation, and deploys the resulting site —
all asynchronously. Status is reported through any of three channels
the agent can choose: a signed webhook, a status endpoint, or a state
marker file written back to the agent's repository (GitOps).

The same capability is exposed via the Ever Works MCP server, so
agents that natively speak MCP can register and manage works as tool
calls. After onboarding, all subsequent updates can flow through
GitOps: the agent pushes a commit to the manifest repo and the
platform reconciles.

## 2. User Scenarios

The primary "user" here is an AI agent calling the API non-interactively.
A human is not in the loop for any happy-path scenario.

### 2.1 Primary scenarios

- **Cold registration**: **Given** an agent that has never called Ever
  Works before and a GitHub repository containing a `.works/works.yml`,
  **when** the agent makes a single onboarding request with the repo
  URL, a valid GitHub credential, and a contact identifier,
  **then** the platform creates an Ever Works account, links it to the
  agent's GitHub identity, creates a Work from the manifest, returns
  a `202 Accepted` with `work_id`, `status_url`, and an assigned
  subdomain, and begins generation in the background.

- **Returning agent, new work**: **Given** an agent whose previous
  account exists, **when** it calls the onboarding endpoint with a
  different repo URL, **then** the platform reuses the existing
  account (matched by GitHub identity) and creates a second Work
  under it.

- **Idempotent re-call (same repo)**: **Given** an agent that has
  already onboarded a specific repo, **when** it calls the endpoint
  again with the same repo URL, **then** the platform returns the
  existing `work_id` and current status without creating a duplicate.

- **MCP path**: **Given** an MCP-capable agent, **when** it invokes
  the `register_work` tool with the same parameters, **then** it
  receives the same observable outcomes as the REST path.

- **GitOps update**: **Given** an onboarded agent, **when** it commits
  a change to `.works/works.yml` in the manifest repo, **then** the platform
  detects the push (via repo webhook), reconciles the Work, and
  triggers regeneration — without any new API call from the agent.

- **Webhook completion**: **Given** the agent supplied a webhook URL
  during onboarding, **when** generation finishes (success or
  failure), **then** the platform delivers a signed webhook payload
  containing the terminal status, retrying with backoff on
  non-2xx responses.

- **Status polling**: **Given** the agent prefers polling, **when**
  it requests the status URL, **then** it receives the current
  pipeline phase, percent-complete, the assigned subdomain, the
  deployment URL once live, and any errors.

- **Repo-marker completion**: **Given** the agent prefers GitOps,
  **when** generation finishes, **then** the platform commits a
  state file (e.g. `.works/state.json`) to the manifest repo
  with the terminal status, so the agent's existing repo watcher
  surfaces it.

### 2.2 Edge cases & failures

- **Given** the GitHub credential lacks write access to the named
  repo, **when** the agent calls the endpoint, **then** the platform
  returns `403 Forbidden` with a typed error code
  (`gh_repo_access_denied`) and creates no account.

- **Given** the repo has no `.works/works.yml` at root, **when** the agent
  calls the endpoint, **then** the platform returns `422
Unprocessable Entity` with `manifest_missing` and a pointer to the
  manifest schema docs.

- **Given** `.works/works.yml` is malformed or fails schema validation,
  **when** the agent calls the endpoint, **then** the platform
  returns `422` with per-field validation errors.

- **Given** the credential is a classic PAT with wider scopes than
  needed, **when** the agent calls the endpoint, **then** the
  platform accepts it but emits a warning in the response advising
  the agent to switch to a fine-grained PAT or the Ever Works
  GitHub App, and links to the docs.

- **Given** the same repo URL was already onboarded by a _different_
  GitHub identity, **when** a new identity tries to onboard it,
  **then** the platform returns `409 Conflict` with
  `repo_already_owned` and does not transfer ownership.

- **Given** the agent's request rate exceeds the per-IP, per-token,
  or per-account limit, **when** the endpoint is called, **then**
  the platform returns `429 Too Many Requests` with `Retry-After`.

- **Given** a webhook delivery returns non-2xx, **when** the platform
  retries, **then** it uses exponential backoff up to a documented
  maximum, then surfaces the failure in the status endpoint and
  state file but never blocks generation.

- **Given** the agent's GitHub credential is revoked mid-generation,
  **when** the platform attempts a follow-up commit (e.g. writing
  the state marker), **then** the work transitions to a recoverable
  `gh_credential_invalid` state and notifies the agent via the
  configured callback channels.

- **Given** the manifest declares an unsupported pipeline or plugin,
  **when** the platform reconciles, **then** the work fails fast
  with `unsupported_capability` rather than hanging.

- **Given** the agent supplies a custom subdomain that is taken,
  **when** the platform allocates, **then** it returns `409` with
  `subdomain_taken` and lists alternatives.

## 3. Functional Requirements

- **FR-1** The system MUST expose a single registration endpoint that
  accepts a GitHub repository URL, a GitHub credential, and a contact
  identifier (email or opaque agent ID).
- **FR-2** The system MUST accept the GitHub credential via the
  `X-GitHub-Token` request header (preferred) or in the JSON request
  body, and MUST NOT accept it as a URL query parameter. The
  `X-GitHub-Token` header MUST be the form documented in public
  examples and SDKs.
- **FR-3** The system MUST validate the GitHub credential against the
  named repository before any account is created or any work is
  recorded.
- **FR-4** The system MUST create a new Ever Works account on demand
  if no account is linked to the agent's GitHub identity.
- **FR-5** The system MUST link the new or existing account to the
  agent's GitHub identity using GitHub's user/installation identifier,
  not the supplied email.
- **FR-6** The system MUST treat the supplied email and agent
  identifier as contact / labelling channels only, not as a primary
  identity. Primary identity is the GitHub identity (FR-5).
- **FR-6a** The request MAY carry both `email` and `agent_id` in
  the same call. Both are optional and independent; supplying both
  is the recommended pattern (email for human reachability, agent
  identifier for the agent's own bookkeeping). At v1 `agent_id`
  is treated as an opaque string with a length cap and a
  printable-ASCII charset restriction; cryptographic identity
  formats (DID, signed JWTs, etc.) are deferred to a future spec
  and can be layered on without changing the field name.
- **FR-7** The system MUST read a `.works/works.yml` manifest from the root
  of the supplied repository and validate it against the published
  manifest schema.
- **FR-8** The system MUST be idempotent for the same `(github_identity,
repo_url)` pair: a second call returns the existing `work_id`
  without creating a duplicate.
- **FR-9** The system MUST honour an optional `Idempotency-Key`
  request header per the Stripe-style convention for client-driven
  idempotency.
- **FR-10** The system MUST respond with `202 Accepted` and a body
  containing at minimum `work_id`, `status_url`, and the assigned
  subdomain, returning before generation completes.
- **FR-11** The system MUST start generation as a background job and
  MUST NOT block the registration response on its completion.
- **FR-12** The system MUST support an optional `webhook_url` per
  request and MUST sign delivered payloads HMAC-SHA256 over the
  raw request body, using a per-account shared secret, delivered
  in an `X-Hub-Signature-256: sha256=<hex>` header that mirrors
  GitHub's webhook convention. The platform MUST also include an
  `X-Ever-Works-Event` header naming the event type and an
  `X-Ever-Works-Delivery` UUID for de-duplication.
- **FR-13** The system MUST expose a status endpoint that returns the
  current pipeline phase, percent-complete (when meaningful), the
  assigned subdomain, the deployed URL once live, and any errors.
- **FR-14** The system MUST optionally write a state marker file to
  the manifest repo on each terminal status transition, when the
  agent opts in.
- **FR-15** The system MUST expose the same capability as a tool
  through the existing Ever Works MCP server (`apps/mcp/`), with
  parameters and return shape equivalent to the REST endpoint.
  Per-tool authentication is enforced inside the MCP server: the
  `register_work` tool is publicly callable (it bootstraps the
  agent's account); tools that operate on existing works require
  an Ever Works credential on the MCP request. There is no
  separate public MCP namespace.
- **FR-16** The system MUST publish an Agent Card at
  `/.well-known/agent.json` describing the registration capability,
  so A2A-aware clients can discover it without out-of-band docs.
- **FR-17** The registration endpoint MUST appear in the existing
  OpenAPI 3.1 document already served at `/api/openapi.json`, the
  Swagger UI at `/api/swagger`, and the Scalar reference. This
  feature does not add new infrastructure; it reuses the existing
  NestJS Swagger / Scalar wiring in `apps/api/src/main.ts` and
  requires the new controller to carry the standard
  `@ApiOperation`, `@ApiBody`, `@ApiHeader`, and `@ApiResponse`
  decorators so the endpoint is discoverable through all three
  surfaces.
- **FR-18** The system MUST accept a fine-grained PAT or a classic
  PAT as the GitHub credential at v1. The system MAY also accept an
  Ever Works GitHub App installation identifier; it MUST be treated
  as an optional, additional credential mode rather than the
  required mode at v1, because installing a GitHub App on a user
  or org currently requires the human-driven github.com install
  UI and is not zero-friction for agents.
- **FR-19** The system SHOULD warn agents that supply a classic PAT,
  in the response body, that fine-grained PAT or the GitHub App
  installation is preferred — non-blocking. The warning MUST link
  to docs explaining the minimum permissions for the fine-grained
  PAT (Contents: RW, Metadata: R, Pull Requests: RW only when the
  manifest opts into platform-managed website / awesome repos).
- **FR-20** The system MUST NOT log GitHub credentials to any
  persistent store, application log, or third-party telemetry.
- **FR-21** The system MUST encrypt persisted GitHub credentials at
  rest.
- **FR-22** The system MUST allocate a free subdomain on the
  Ever Works root (e.g. `<slug>.ever.works`) for every successfully
  registered work, before generation completes.
- **FR-23** The system SHOULD accept an optional `subdomain` field
  in the manifest and use it when available and free.
- **FR-24** The system MUST enforce a "one Work per repo URL" cap
  at v1: a second registration call with the same canonicalised
  repo URL but a different GitHub identity returns `409 Conflict`
  with `repo_already_owned`, and a second call with the same
  identity returns the existing `work_id` (per FR-8). Broader
  per-identity, per-IP, and per-token rate limits are deferred to
  a follow-up; the implementation MUST leave a hook for them
  without an API-shape change.
- **FR-25** The system MUST treat pushes to the manifest repo as
  reconciliation triggers, regenerating the work when the manifest
  has changed.
- **FR-26** Generated directory websites MUST expose an `llms.txt`
  at site root following the public llms.txt convention, plus a
  machine-readable items index (e.g. `items.json` or JSON-LD
  embedded per page), so downstream agents can consume the
  directory contents without HTML parsing.
- **FR-26a** Platform-written files in the manifest repo MUST live
  under a single top-level `.works/` directory (e.g.
  `.works/state.json`). This directory is the platform's reserved
  namespace for state markers, generated artefacts surfaced back
  to the agent, and any future GitOps signalling. The platform
  MUST NOT write outside `.works/` in the manifest repo, except
  when the agent has explicitly opted into platform-managed
  content elsewhere (e.g. a generated README) via the manifest.
- **FR-27** The system MUST return typed error codes (string slugs)
  for all 4xx and 5xx responses, distinct from the human-readable
  message, so agents can branch on them.
- **FR-28** The system MUST allow an agent to delete a work it owns
  through the same authentication path used for registration,
  taking down the deployed site and cleaning up associated repos
  per the agent's chosen retention setting.
- **FR-29** The system MUST NOT transfer work ownership between
  GitHub identities silently. Repos previously onboarded by another
  identity MUST require an explicit ownership-transfer flow (out of
  scope for v1; see §6).
- **FR-30** The platform MAY create additional repositories
  (website code repo, Awesome list repo) under the agent's GitHub
  account or org during generation, only when the manifest opts
  in and the credential grants the necessary scope. The platform
  MUST document the required scope clearly (Contents: RW on the
  target user/org, plus Administration: write to create the
  repo) and SHOULD recommend that agents grant access via a
  dedicated org or fine-grained PAT to limit blast radius. If the
  credential lacks the necessary scope, the platform MUST return
  a typed error `gh_insufficient_scope_for_repo_creation`
  identifying the missing permission.
- **FR-31** The registration request and response shapes MUST
  reserve a forward-compatible optional field for an agent payment
  / wallet identifier (e.g. an `agent_payment` object) so that the
  v2 paid plane — based on x402, Skyfire, Crossmint, or Stripe
  Agent — can be added without an API-shape change. v1 ignores
  the field if supplied.
- **FR-32** Agents MAY discover the registration capability by
  fetching the Agent Card at `/.well-known/agent.json` (FR-16).
  The Agent Card MUST list at least the registration endpoint URL,
  the MCP server URL exposing `register_work`, and a link to the
  manifest schema, so a fresh agent can onboard with no
  out-of-band documentation.

## 4. Non-Functional Requirements

- **Performance**: P95 of the registration endpoint, measured from
  request received to `202` returned, MUST be under 2 seconds. This
  excludes generation, which is asynchronous.
- **Reliability**: Webhook delivery MUST be retried with exponential
  backoff on transient failure, with at least 6 attempts spread
  over at least 24 hours before terminal failure. Terminal failure
  MUST NOT block generation or status reporting through other
  channels.
- **Security & privacy**:
    - GitHub credentials are sensitive (`x-secret`) — encrypted at
      rest, redacted in logs and activity records, transported only
      over TLS.
    - The signed webhook secret is per-account; rotation is supported
      without changing the registered URL.
    - Token validation against GitHub MUST happen before any
      persistent write tied to the request.
- **Observability**: Every onboarding attempt — successful or not —
  emits an entry to the activity log capturing the GitHub identity,
  repo URL (canonicalised), terminal status, and the typed error
  code on failure. Latency, success rate, and rate-limit hits are
  exported as metrics.
- **Compatibility**: `.works/works.yml` is versioned (`apiVersion` field).
  v1 schema MUST be backwards-compatible additions only; breaking
  changes require a new `apiVersion`. The MCP tool and REST endpoint
  share the same parameter names where possible.

## 5. Key Entities & Domain Concepts

| Entity / concept       | Description                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Agent`                | A non-human caller of the registration capability. Identified by its GitHub identity (user or installation).                                                                                                  |
| `OnboardingRequest`    | A single registration attempt. Carries repo URL, credential, contact identifier, optional webhook URL and subdomain hint.                                                                                     |
| `.works/works.yml`     | A YAML manifest at the root of the agent's repo describing the desired Work: name, description, pipeline, plugins, taxonomy, item sources, deployment options. The source of truth for GitOps reconciliation. |
| `Manifest Repo`        | The agent's repository containing `.works/works.yml`. Distinct from the data, website, and Awesome-list repos that the platform may create.                                                                   |
| `Account Linking`      | The pairing of an Ever Works account with a GitHub identity, established or reused at registration time.                                                                                                      |
| `Subdomain Allocation` | The free `<slug>.ever.works` host assigned at registration before generation completes, so an agent can return a URL to its caller immediately.                                                               |
| `Webhook Subscription` | The optional callback URL plus a per-account HMAC secret used to sign deliveries.                                                                                                                             |
| `State Marker`         | An optional file (e.g. `.works/state.json`) committed by the platform to the manifest repo to surface terminal status to agents that watch the repo.                                                          |
| `Agent Card`           | The A2A-style discovery document at `/.well-known/agent.json` advertising the registration capability and its endpoint.                                                                                       |

## 6. Out of Scope

- **Mobile apps.** Native iOS/Android publishing on behalf of agents
  is explicitly post-MVP. The constraints are different (store
  gatekeepers, developer accounts, signing) and warrant a separate
  spec.
- **Agent payments and metered billing.** v1 is free-tier only. The
  request/response shape leaves room for an `agent_payment` field
  (x402 / Skyfire / Crossmint / Stripe Agent) to be added without a
  breaking change, but no billing logic is in scope here.
- **Marketing automation beyond initial deployment.** SEO content
  expansion, paid acquisition, social posting, email capture, and
  affiliate-link rotation are described in the broader product
  vision but are separate features.
- **Sales enablement.** Lead capture, transactional flows, and
  monetisation primitives for the deployed sites are separate
  features.
- **Ownership transfer between GitHub identities.** A repo onboarded
  by identity A cannot be claimed by identity B in v1. A future
  spec will define the verification flow (e.g., commit signed
  challenge to repo).
- **Strong agent identity beyond the GitHub credential.** No DID,
  no signed agent claims, no wallet-based identity in v1. The
  GitHub credential's proof-of-write-access to the repo is the
  identity signal.
- **A multi-tenant management UI** for agents to manage their works
  through a browser. The agent's surface is API + MCP + their
  manifest repo. Humans can use the existing dashboard if they
  later attach.
- **Generation pipeline changes.** This spec wires the agent-facing
  entry point onto existing pipelines; any new pipeline capability
  is a separate feature.

## 7. Acceptance Criteria

- [ ] An agent can call a single REST endpoint with no prior account
      and receive a 202 response with `work_id`, `status_url`, and
      a free subdomain.
- [ ] The same capability is invocable via the Ever Works MCP server
      with equivalent parameters and return shape.
- [ ] The endpoint accepts the GitHub credential in body or header
      and rejects it in the URL query string.
- [ ] Calling the endpoint twice with the same `(github_identity,
repo_url)` returns the same `work_id` and does not create a
      duplicate.
- [ ] An invalid GitHub credential or one without repo write access
      causes a typed `403` with `gh_repo_access_denied` and creates
      no account.
- [ ] A repo without `.works/works.yml` causes a typed `422` with
      `manifest_missing`.
- [ ] A malformed `.works/works.yml` causes a typed `422` with per-field
      errors.
- [ ] A successful registration triggers background generation that
      ends in a deployed site at the assigned subdomain.
- [ ] If a webhook URL was supplied, a signed webhook is delivered
      on terminal status, with HMAC-verifiable signature.
- [ ] If state-marker writing was opted into, a file is committed
      to the manifest repo on terminal status.
- [ ] A push that changes `.works/works.yml` triggers reconciliation
      without any new API call.
- [ ] An Agent Card is served at `/.well-known/agent.json`
      describing the registration capability.
- [ ] An OpenAPI 3.1 document covers the endpoint and its typed
      error codes.
- [ ] Generated sites expose `llms.txt` and a machine-readable
      items index at predictable paths.
- [ ] No GitHub credential appears in any persisted log or activity
      record.
- [ ] A second registration call for a repo URL already onboarded
      by a different GitHub identity returns `409` with
      `repo_already_owned`.
- [ ] All functional requirements have a passing test (unit or
      e2e).

## 8. Open Questions

### Resolved (2026-05-04)

- ~~Default credential mode~~ → **Resolved**: v1 accepts both
  fine-grained and classic PAT. The Ever Works GitHub App is being
  built as an additional, optional credential mode and is not
  required at v1, since installing a GitHub App on a user/org
  account currently requires a human-driven github.com flow and
  is not zero-friction for agents. (See FR-18.)
- ~~Rate-limit numbers~~ → **Resolved**: v1 enforces only
  "one Work per repo URL"; broader per-identity / per-IP / per-token
  limits are deferred. (See FR-24.)
- ~~State-marker path~~ → **Resolved**: platform-written files go
  under a single top-level `.works/` directory in the manifest
  repo; the terminal status marker is `.works/state.json`. (See
  FR-14, FR-26a.)
- ~~OpenAPI surface~~ → **Resolved**: `apps/api` already exposes
  OpenAPI 3.1 at `/api/openapi.json`, Swagger UI at `/api/swagger`,
  and the Scalar reference via `@scalar/nestjs-api-reference`. The
  registration endpoint reuses this; no new infrastructure. (See
  FR-17.)
- ~~Payments at v1~~ → **Resolved**: out of scope for v1; the
  request/response reserves a forward-compatible field so x402,
  Skyfire, Crossmint, or Stripe Agent can be wired in at v2 with
  no breaking change. (See FR-31, §6.)

### Resolved (2026-05-04, second round)

- ~~MCP placement~~ → **Resolved**: `register_work` lives on the
  existing `apps/mcp/` server. Per-tool auth: `register_work` is
  publicly callable; post-onboarding tools require an Ever Works
  credential. No separate public MCP namespace. (See FR-15.)
- ~~Webhook signature scheme~~ → **Resolved**: GitHub-style
  `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 over the raw
  body with a per-account secret. Plus
  `X-Ever-Works-Event` and `X-Ever-Works-Delivery` headers. (See
  FR-12.)
- ~~`agent_id` at v1~~ → **Resolved**: accept both `email` and
  `agent_id`, both optional and independent. `agent_id` is an
  opaque string at v1; cryptographic identity formats deferred.
  (See FR-6, FR-6a.)
- ~~GitHub permissions floor for platform-created repos~~ →
  **Resolved**: document the required scope (Contents: RW + Admin:
  write on the target user/org), recommend a dedicated org or
  fine-grained PAT to limit blast radius, and return
  `gh_insufficient_scope_for_repo_creation` on failure. (See
  FR-30.)

### Still open

_None._ All clarifications resolved. Spec is approval-ready
pending owner status flip from `Draft` to `In Review`.

## 9. Constitution Gates

- [x] **Plugin-first** — GitHub credential validation, deployment,
      and pipeline execution all flow through existing plugin
      capabilities (`git-provider`, `deployment`, `pipeline`).
      No new direct integrations.
- [x] **Capability-driven resolution** — the registration flow
      resolves the git provider, pipeline, and deployment capability
      from the manifest, not from hard-coded vendor names.
- [x] **Source-of-truth repos preserved** — the manifest repo is
      the source of truth; data and website repos are derived per
      the existing pattern.
- [x] **Long-running work via Trigger.dev** — generation kicked off
      by registration runs as a Trigger.dev job, not inline.
- [ ] **Forward-only migrations** — applies if new tables/columns
      land (e.g., `agent_onboarding_requests`); explicit in the plan.
- [x] **Tests accompany the change** — covered by acceptance criteria.
- [x] **Secrets handled per `x-secret`** — GitHub credentials and
      webhook secrets are marked `x-secret`, encrypted at rest,
      redacted in logs.
- [ ] **Plugin counts touch the canonical doc only** — N/A unless
      a new plugin is added by this feature.
- [x] **Behaviour-first** — no implementation detail in this spec.
- [x] **Backwards-compatible API/SDK/schema changes** — endpoint is
      additive; manifest is versioned and additive within v1.

## 10. References

- Related features:
    - [`creating-a-work`](../creating-a-work/spec.md) — the existing
      human-facing creation flow this builds on.
    - [`work-import`](../work-import/spec.md) — the existing import
      pipeline for data repos and Awesome lists.
    - [`mcp-server`](../mcp-server/spec.md) — the MCP surface this
      feature extends with `register_work`.
    - [`api-keys`](../api-keys/spec.md) — relates to post-onboarding
      auth; not used during the initial zero-friction call.
    - [`custom-domains`](../custom-domains/spec.md) — the upgrade path
      from the auto-allocated subdomain.
- Related architecture:
    - [`docs/api/works.md`](../../../api/works.md)
    - [`docs/api/git-provider-capability.md`](../../../api/git-provider-capability.md)
    - [`docs/api/deploy-capability.md`](../../../api/deploy-capability.md)
- Industry references (informational, not standards we're forced to
  adopt):
    - Model Context Protocol (Anthropic) — MCP tool exposure.
    - Agent2Agent / Agent Card (Google) — `/.well-known/agent.json`
      discovery.
    - llms.txt — site-level convention for downstream agents.
    - Stripe Agent Toolkit — agent-friendly API ergonomics
      (idempotency, typed errors, programmatic onboarding).
    - GitHub Apps & fine-grained PATs — recommended credential modes.
    - x402 (Coinbase) / Skyfire / Crossmint — agent-payment standards
      for the future billing plane.

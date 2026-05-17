# Ever Works — Threat Model

**Status:** Living document. First draft 2026-05-17, in response to the
[2026-05-17 platform security audit](../../../../Workspace/knowledge/security/audits/2026-05-17-ever-works-platform-security-audit.md).
Owner: Platform team.

> The platform is unusually multi-surfaced: REST API, Next.js web app,
> MCP server, CLI, 39-plugin runtime, agentic CLI orchestrator
> (claude-code / codex / gemini / opencode), and multi-cluster k8s.
> The audit flagged that the codebase "oscillates between 'open-source
> self-hosted' assumptions and 'managed multi-tenant SaaS' assumptions,
> and the two are incompatible." This doc picks a posture and asks the
> rest of the code to converge.

---

## 1. Tenancy posture (chosen)

Ever Works is a **managed multi-tenant SaaS** that *also* ships as
**open-source self-hostable**. The trust model below describes the
hosted SaaS at `apps.ever.works`; self-hosters inherit the same model
plus whatever additional risks their own infra introduces.

Concretely, on the hosted SaaS:

- **Tenant = User** (or anonymous user). Per-user secrets live in
  `User.plugins.secretSettings` and (after C-08) are AES-256-GCM
  encrypted at rest.
- **Cross-tenant isolation is enforced in application code** (the API
  layer's `WorkOwnershipService.ensureAccess`), not at the DB or
  network layer. There is no Postgres row-level security and no
  per-tenant DB. A bug in `ensureAccess` is a cross-tenant breach;
  treat ownership checks as security-critical and test them with the
  same rigor as auth code.
- **Plugins are 1st-party only.** The runtime *technically* loads any
  ESM package that ships an `everworks.plugin` manifest, but the
  hosted platform refuses to install community plugins until plugin
  signing / integrity verification ships (see §6 below). Self-hosters
  who load community plugins do so at their own risk and must trust
  the plugin author as if they had given them shell on their server.
- **The agentic CLI orchestrator (`claude-code`, `codex`, `gemini`,
  `opencode`) runs with the API process's filesystem permissions, not
  a sandbox.** This is intentional — the entire value proposition is
  "AI that writes code on your behalf" — but it means prompt-injection
  inside the agent loop is equivalent to RCE on the API host. The
  envelope around the agent (env allow-list per C-10, workspace path
  enforcement per H-23, SSRF guard per H-09/H-10/H-11) is the
  mitigation.

## 2. Trust boundaries

| Edge | Direction | Trust |
|------|-----------|-------|
| Public internet → `api.ever.works` / `app.ever.works` | inbound | **Untrusted.** All input passes the global `ValidationPipe { whitelist, transform, forbidNonWhitelisted }`. Public endpoints additionally require a captcha / throttle (anonymous flow) or are read-only. |
| Public internet → `mcp.ever.works` | inbound | **Authenticated**, via shared `EVER_WORKS_API_KEY` (legacy) or per-user OAuth (H-21 — once the dual-mode lands). The shared-key path forwards the caller's JWT to the upstream API for tenant resolution; without the JWT, the call is rejected. |
| Trigger.dev worker → `/internal/trigger/*` on the API | inbound (from a third-party SaaS) | **Authenticated via `TRIGGER_INTERNAL_SECRET`** (length-padded `timingSafeEqual` per C-05). RPC surface limited to an explicit per-`{service, method}` allow-list (C-05 RPC half). |
| API → external HTTP (extractors, screenshots, webhooks, OAuth) | outbound | **SSRF-guarded** via `isSafeWebhookUrl` (H-09 / H-10 / H-11). Re-resolution after redirects is on the roadmap (M-23). |
| API → claude-code / codex / gemini / opencode subprocess | outbound | Subprocess env is a strict allow-list (C-10): `PATH`, `HOME`, `TMPDIR`, proxy/CA vars, and provider-specific `ANTHROPIC_*` / `CLAUDE_CODE_*` / equivalent. No DB creds, no `AUTH_SECRET`, no plugin keys cross the boundary. |
| API → managed-agent SaaS (Anthropic, OpenAI, Mistral) | outbound | Trust the SaaS to handle inputs safely; the platform must NOT echo unfiltered tenant data into the prompt without delimiters (queued for prompt-injection canary work). |
| API → Postgres | outbound | **Trusted**, but the connection uses `DATABASE_SSL_MODE=true` in stage/prod. Migrations run via `entrypoint.sh`; `synchronize` is forced off (C-07). |
| Agent workspace `/tmp/<userId>/<workId>/` | local | The agent can read/write inside the workspace freely. `H-23` ensures it can't escape via absolute paths in tool calls; `L-32` ensures cleanup can't `rm` outside the workspace; `H-22` ensures `<userId>` / `<workId>` are UUIDs before they become path components. |
| Community GitHub PRs | inbound (untrusted) | LLM-extracted items pass `cliItemSchema` (M-26) before they're written; `source_url` requires http/https (rejects `javascript:`); per-PR author allow-list and item cap (C-11). |
| Plugin packages on disk | local | **First-party trust.** Community plugins are explicitly **not supported** on the hosted SaaS until C-12 (signing / integrity verification) lands. |

## 3. Threat actors

| Actor | Capability | Mitigation |
|-------|------------|------------|
| **Anonymous internet visitor** | Crawl the public site, submit anonymous-user flow, file community PRs, try password-reset on guessed emails. | Captcha on `/auth/anonymous` (production); `/auth/login` and token-validity oracles throttled; tokens never returned in HTTP responses (C-01/C-02); SSRF guards block scanning internal services. |
| **Registered tenant** | Generate items in their own works, install plugins, configure git tokens, kick off agentic runs. | Cross-tenant isolation via `WorkOwnershipService`; per-tenant plugin secrets encrypted (C-08); per-user cost / rate budgets (queued — currently per-plugin only). |
| **Malicious tenant** | Same as above PLUS: feed prompt-injection through scraped content, PR text, PDF source URLs, screenshot APIs. | Tenant data isolated to their own works; agentic env allow-list prevents host-secret exfil (C-10); CLI item schema validates LLM output (M-26); SSRF guards prevent extractors from reaching internal hosts. **Residual risk:** the agent can still emit attacker-chosen content into the tenant's *own* outputs — they can vandalize their own work but not others. |
| **Compromised plugin author (1st-party)** | Add malicious code to a plugin that the runtime auto-loads. | None currently — 1st-party trust model. Plugin signing (C-12) is on the roadmap; until then, code review on every plugin PR is the only gate. |
| **Compromised CI / GitHub Action** | A mutable-tagged action publishes a malicious version that exfiltrates secrets at deploy time. | Minimum default `permissions: contents: read` on every workflow (M-12); secrets passed via `env:` indirection where shell metacharacters could break the step (M-13); `pnpm audit` blocks high/critical transitive CVEs in PRs (H-15). SHA-pinning of third-party actions is queued (M-11). |
| **K8s cluster compromise (peer pod)** | A neighboring deployment in `do-sfo2-k8s-gauzy` reads our secrets via `get deployments` or pod env. | Currently all secrets live inline in `Deployment.spec.template.spec.containers[].env` (H-13). Migration to `Secret` resources + `secretKeyRef` is queued. Pod-level `securityContext` (H-20) is queued — when it lands, the API pod will run as non-root, read-only-rootfs, with `automountServiceAccountToken: false` unless explicitly needed for the k8s-plugin deploy path. |

## 4. Out of scope (explicitly)

- **DDoS at the edge.** Cloudflare / DigitalOcean LB handle volumetric L3/L4 attacks. The application's rate limiters are not designed to survive a true DDoS.
- **Compromised tenant device.** If a tenant's laptop is compromised and their session cookie is stolen, the attacker has the tenant's privileges. This is true of every web app; the platform mitigates by setting `httpOnly` + `secure` + `sameSite=lax` (M-21) and short refresh windows.
- **Compromise of upstream SaaS** (Better Auth, Trigger.dev, Vercel runtime, OpenRouter, Anthropic, etc.). Out of our control; we assume they handle our credentials correctly.
- **Side-channels in shared infrastructure** (CPU cache attacks on a public cloud's hypervisor, etc.). We trust DO and Vercel's host isolation.

## 5. Residual risks (accepted)

These are known risks the audit flagged that the platform team has accepted for now:

- **In-process plugin model.** Even with C-12 signing, a vetted plugin can still misbehave. The platform team's decision: review every plugin PR like product code, and rely on the 1st-party-only posture above. Revisit when community plugins become a feature.
- **Agentic loop can spend tenant money.** A prompt-injected agent can burn through the tenant's OpenAI / Mistral / Anthropic budget. Per-plugin `maxBudgetUsd` is the current mitigation; a platform-wide per-tenant cost budget is queued.
- **No platform-wide kill-switch.** If a prompt-injection or runaway is in progress, ops can stop individual pipelines but there's no `IS_AGENT_KILL_SWITCH_ON` that halts all autonomous activity instantly. Queued.
- **Fake `iat` / `iss` / `aud` on `AuthenticatedUser`.** Marked `@deprecated`; removal is a follow-up after consumers migrate. Low risk because the values are server-internal and don't sign anything.

## 6. Plugin trust posture (formal statement)

> The hosted SaaS at `apps.ever.works` will not load any plugin that
> has not been reviewed, merged, and pinned by the Ever Works team.
> Self-hosters who load plugins they did not author themselves are
> trusting those plugin authors with shell access to their server.
> Plugin signing / integrity verification will lift this restriction
> once it ships (C-12).

Concretely:

- `PluginLoaderService.discover()` will load any `everworks.plugin` it
  finds on disk; the runtime does not currently distinguish 1st- and
  3rd-party plugins.
- The hosted SaaS image only bundles plugins from `packages/plugins/`
  in this repo. There is no UI to upload a plugin, no API endpoint
  that fetches and loads one from npm.
- Self-hosters bear the responsibility of vetting any external plugin
  they add to `./plugins` or `./node_modules/@ever-works`.

## 7. Convergence checklist (audit findings → posture above)

| Posture statement | Findings that enforce it | Status |
|-------------------|--------------------------|--------|
| Tokens travel only via secondary channel | C-01, C-02 | ✅ Batch 1 |
| Shared-secret comparisons are constant-time | C-05, H-08, L-09 | ✅ Batch 1 |
| API docs are not public in production | C-09 | ✅ Batch 1 |
| Agentic subprocesses don't inherit host secrets | C-10 | ✅ Batch 1 |
| Cookie encryption key has real entropy | H-14 | ✅ Batch 1 |
| Callback URLs go through host allow-list | C-04 | ✅ Batch 2 |
| Postgres `synchronize` is off in every env | C-07 PR-A + PR-B | ✅ Batch 2 / pending PR-B |
| Password complexity matches Better Auth runtime | H-02 | ✅ Batch 2 |
| Forgot-password is timing-uniform | H-03 | ✅ Batch 2 |
| Email verification is required before login | H-07 | ✅ Batch 2 |
| Trigger.dev callback exposes only allow-listed fields | H-06 | ✅ Batch 2 |
| Outbound HTTP from API is SSRF-guarded | H-09 / H-10 / H-11 / M-23 | ✅ Batch 2 (lexical guard; DNS-rebinding still on roadmap) |
| Plugin README renders are sanitized | H-12 | ✅ Batch 2 |
| CI fails on high/critical transitive CVEs | H-15 | ✅ Batch 2 |
| Production fails fast on missing CORS allow-list | H-19 | ✅ Batch 2 |
| Task-payload path components are validated UUIDs | H-22 | ✅ Batch 2 |
| Agentic file tools can't escape the workspace | H-23 | ✅ Batch 2 |
| Plugin readme HTML is sanitized | H-12 | ✅ Batch 2 |
| OAuth state validated against signed cookie | C-03 | 🚧 Batch 3 |
| Trigger remote-call surface is allow-listed | C-05 RPC half | 🚧 Batch 3 |
| Plugin secret settings are encrypted at rest | C-08 | 🚧 Batch 3 |
| Community-PR auto-apply gated by Verified-org membership | C-11 | 🚧 Batch 3 |
| Bearer tokens hashed at rest | H-01 | 🚧 Batch 3 |
| Anonymous sessions bind to IP/UA + short TTL | H-04 / H-05 | 🚧 Batch 3 |
| Distributed throttler with per-user lockout | H-17 / H-18 | 🚧 Batch 3 |
| K8s pod runs as non-root with capabilities dropped | H-20 | 🚧 Batch 3 |
| MCP server has per-user identity (dual-mode) | H-21 | 🚧 Batch 3 |
| Agentic boundaries are feature-flag toggled | H-24 / H-25 | 🚧 Batch 3 |
| Plugin loader verifies integrity / signature | C-12 | ❌ Deferred — see §6 |
| K8s secrets live in `Secret` resources | H-13 | ❌ Deferred — operator opted out for now |

## 8. Revision log

| Date | Author | Change |
|------|--------|--------|
| 2026-05-17 | Platform team (drafted by audit-batch session) | First draft, in response to the 2026-05-17 platform security audit. |

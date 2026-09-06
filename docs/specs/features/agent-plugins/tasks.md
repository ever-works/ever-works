# Task Breakdown: Agent Plugins Standard Interop

**Feature ID**: `agent-plugins`
**Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-08-09

---

## How to use

Phases map to PRs (one or two PRs per phase, stacked on `develop`). Tasks
sequential unless `(parallel)`. Every phase ends with the same **standing DoD
gate**:

> **DoD gate (every phase)**: fresh full `pnpm build` green (catches TS2305
> cross-package export misses); `pnpm test` green in touched packages;
> `node dist/openapi/generate-openapi.js` full-app bootstrap green (DI
> crash-loop gate) whenever a module/provider changed; migration included in the
> SAME PR as any entity change, entity added to
> `packages/agent/src/database/_entities-inventory.ts`; module-shape pin specs
> (`apps/api/src/agents/agents.module.spec.ts`,
> `apps/api/src/trigger/trigger-internal.module.spec.ts`) updated with any
> provider add; `pnpm format:check` with the ROOT glob; grep `apps/web/e2e` for
> every touched endpoint/DTO; branch e2e dispatched and green before merge; PR
> reviewed to a clean bot pass (NN #14/#18).

**Nothing-changes invariant (every phase)**: `git diff` must show zero behavioral
edits to: `plugin-loader.service.ts`, `plugin-manifest-validator.service.ts`,
`plugin-installer.service.ts` (native paths), `everworks-skills` plugin, `Skill`/
`SkillBinding` entities' existing columns, existing skills routes/DTOs, `apps/mcp`,
`.agents/.claude/.cursor` skill dirs, `skills-lock.json`. Additive-only files
(capability interface additions, `_entities-inventory.ts` appends, module provider
appends, locale key appends) are expected and fine.

---

## Phase 0 — Conformance library (PR-1)

- [x] **T1**. Scaffold `packages/agent-plugins` (`@ever-works/agent-plugins`):
      tsup ESM build, Vitest, MIT, zero NestJS deps. Own deps: `ajv@^8`,
      `gray-matter@^4`, `yaml` if needed.
- [x] **T2**. Vendor canonical schemas under `src/schemas/1.0.0/`
      (plugin.schema.json, mcp.schema.json) imported via `resolveJsonModule`
      so they ship inside `dist/`.
- [x] **T3**. `src/manifest.ts`: closed manifest validator with exact AP-4
      severity split. Unit tests per AP-1…AP-6 (incl. MUST-NOT-reject cases:
      non-semver version, weird URLs, 1-char and dotted names).
- [x] **T4** (parallel). `src/skills.ts`: discovery walker (immediate children,
      regular-file check) + Agent Skills frontmatter validator (name=dir,
      charset, lengths, `allowed-tools` string→array tokenizer, metadata
      string-map check). Tests per AP-7…AP-9.
- [x] **T5** (parallel). `src/mcp.ts`: closed mcp.json validator, closed server
      union, URL/header rules, reserved env keys, version-match with
      plugin.json. Tests per AP-11…AP-15.
- [x] **T6** (parallel). `src/paths.ts` containment (realpath symlink
      resolution) + `src/expand.ts` placeholder expansion. Tests per AP-10,
      AP-16…AP-17 (expansion in args/env-values/cwd only; non-recursive;
      unknown placeholders literal).
- [x] **T7**. `fixtures/`: full conformance corpus (valid minimal, valid full,
      every fatal/non-fatal manifest case, skip-one-skill, disable-MCP-only,
      per-server skip, containment escapes, dir-name mismatch, oversized
      description). Add fixtures path to `.prettierignore`.
- [x] **T8**. `src/serialize.ts`: plugin.json + SKILL.md emitters; slug→name
      guard; round-trip property test (emit → parse → deep-equal).
- [x] **T9**. Optional CI oracle job: `skills-ref validate` (Python) over skill
      fixtures, non-blocking.

## Phase 1 — Package registry + local-dir source + skills read-side (PR-2, PR-3)

- [x] **T10**. Entities `agent_plugin_packages` (Tier A, incl. `dataManifest`) +
      `agent_plugin_package_allowlist` (Tier D) per plan §2.5; append to
      `_entities-inventory.ts`; migration `CreateAgentPluginPackages`.
      **Read the generated SQL** before commit (NN #16). Account-transfer
      whitelist entries for packages land HERE, same PR (types.ts + export
      literal + both import paths + SyncPushOptions) — reference-only export
      (name+version+source), never package content; deferring this to Phase 3
      would reopen the silent-no-round-trip bug class.
- [x] **T11**. `packages/agent/src/agent-plugins/` module:
      `AgentPluginPackageService` (register/validate/list/remove; findings
      persisted per package), local-dir acquirer (`AGENT_PLUGINS_DIR` scan,
      optional-with-default env per constants.ts pattern). Barrel export entry
      in `packages/agent/package.json` export map.
- [x] **T12**. Feature flag `FEATURE_AGENT_PLUGINS` default false in
      `apps/api/src/config/constants.ts` + `.env.example` + compose env files.
- [x] **T13**. `AgentPluginCatalogService` (plan §2.2) in
      `packages/agent/src/agent-plugins/`: entries from registered package rows + conformance lib; version synthesis per AP-21; pre-flight findings by
      calling the existing gates directly (`MAX_BODY_BYTES`/`assertNoSecrets`/
      `assertNoInjectionTokens` — reachable because this is platform code, not
      a plugin). Wire into `SkillsFacadeService.listEntries` as an
      `@Optional()`-injected additive source merged LAST (existing behavior
      bit-identical when absent/flag-off). Add optional provenance fields
      (`packageName?`/`packageVersion?`/`sourceKind?`) to `SkillCatalogEntry`
      (additive interface change). Barrel-export the new module in
      `packages/agent/package.json` export map.
- [x] **T14**. API controller `apps/api/src/agent-plugins/` (list/install
      local/uninstall/findings), throttled 5/min, admin allowlist CRUD parallel
      to `admin/plugins/allowlist`. DTO validation + validation-authz-matrix
      e2e specs for every new route.
- [x] **T15**. CLI verbs (`agent-plugins list/install/status/uninstall`)
      following `dynamic.command.ts` pattern.
- [x] **T16**. Integration test (Jest, in `packages/agent` — the facade +
      services live there; conformance-lib unit tests stay Vitest in
      `packages/agent-plugins`): fixture package on disk → register → catalog
      entries appear via `SkillsFacadeService` → `installFromCatalog` →
      identical `Skill` rows; assert existing catalog e2e pins unaffected
      (flag off by default; `flow-skills-catalog-pagination.spec.ts`
      untouched).

## Phase 2 — git + npm sources + updates (PR-4)

- [x] **T17**. Git acquirer: URL-first shallow clone (isomorphic-git primitives
      per plan §2.3), ref-pin + resolved-SHA recording, containment validation
      post-clone, re-fetch/update path.
- [x] **T18**. npm acquirer: pacote manifest→allowlist→extract (no symlink, no
      scripts, no dep install); registry config reuse; 409/424/502/504 error
      mapping parity with the code-plugin installer.
- [x] **T19**. Boot re-materialization (warmupFromDb pattern) for git/npm
      packages; startupProbe budget check.
- [x] **T20**. Update-available end-to-end: catalog service computes updates for
      git/npm packages; facade surfaces a badge + explicit re-sync action; the
      same facade wiring finally calls the existing provider `checkForUpdates`
      seam (zero non-test callers today) so `everworks-skills` updates surface
      too.
- [x] **T21**. Web UI: Sources + Packages pages under settings; install flow
      with per-component findings display; i18n keys in ALL
      `apps/web/messages/*.json`; PostHog events.
- [x] **T22**. Env wiring per 2026-06-12 checklist (k8s manifests dev/stage/
      prod + deploy workflows + compose; defaults make it non-fatal) + explicit
      operator note re ArgoCD-managed live env (outside this repo).

## Phase 3 — MCP client: remote transports + bindings (PR-5, PR-6)

> **2026-09-04 — T24-T27 were largely ALREADY BUILT.** PR #2082 ("MCP client —
> external server connections with per-agent bindings") shipped
> `mcp_server_connections`, `agent_mcp_server_bindings`, `McpClientService`,
> `McpToolSource`, `McpConnectionsService`, the `@modelcontextprotocol/sdk`
> dependency and the API controllers. `McpServerConnection.source` is typed
> `'manual' | 'package'` with the comment "'package' reserved for the
> agent-plugins package work" — the seam for this work was designed in advance.
>
> Following these task descriptions literally would have built a SECOND binding
> table and duplicated a whole working subsystem. The real remaining gap was
> narrow: nothing turned a package-declared server into something that machinery
> could see. `PackageMcpReconcilerService` closes it by materialising package
> servers as ordinary connection rows with `source: 'package'` — created
> **disabled and unbound**, because a package arriving on disk must never grant
> an agent network reach on its own.
>
> Re-verify T25-T28 against live code before starting them; they are likely
> done or much smaller than written here.

- [x] **T23**. `McpServerConfigService` (plan §2.2) in
      `packages/agent/src/agent-plugins/`: resolves bound servers → validated
      configs + provenance via the conformance lib. No plugin capability, no
      `facade-capabilities.ts` append. Barrel-export from
      `packages/agent/package.json` export map (TS2305 bug class).
- [x] **T24**. Entity `agent_mcp_server_bindings` (Tier C — skill_bindings
      template PLUS net-new columns `serverName`/`enabled`/`settings`/
      `secretSettings`/`credentialsSecretRef`, per plan §2.5) + migration +
      inventory append. Account-transfer whitelist entries for bindings (same
      4-place set as T10) — masked secrets, `credentialsSecretRef` pointers
      deliberately omitted — implementing the ordered package-reference import
      contract (plan §2.5): resolve/remap destination `packageId` FIRST; absent
      package → pending-reference row + bindings imported `enabled: false`;
      disallowed source → skip-and-report; never auto-fetch content on import;
      never fail the whole import.
- [x] **T25**. `packages/agent/src/mcp/`: `McpClientService`
      (streamable-http + sse via `@modelcontextprotocol/sdk` — new dep of
      `packages/agent`), per-server failure isolation, connect-time credential
      injection (client-generated headers; masked reads), SSRF egress policy,
      **redirect policy per AP-15** (no package-header cross-origin forwarding
      without explicit authorization; no client-generated credential forwarding
      cross-origin at all — with tests), run-end disconnect.
- [x] **T26**. `McpToolSource` injected into `AgentToolService.
resolveAllowedTools` as a new optional source (domain-tool-source
      pattern); `mcp__<server>__<tool>` naming; name/description sanitization;
      builtin-collision drop + WARN; run-log WARNs for skipped servers.
      Update module pin specs.
- [x] **T27**. Bindings API (`/api/agents/:id/mcp-servers` CRUD + standalone
      delete; agent-scoped targets only in v1) + **MCP Servers tab** on
      `/agents/[id]` + i18n + e2e specs (binding CRUD, authz matrix,
      cross-tenant isolation). Domain chat tools per the in-code DoD
      (`agent-tool.service.ts:317-319`, "every new entity"): packages +
      bindings get tool sources here; `agent_plugin_package_allowlist` is
      exempt (admin-only surface, like `plugin_allowlist` which has no chat
      tools) and `skill_files` is exempt (child rows surfaced through existing
      skill tools) — exemptions stated so the DoD check is explicit.
- [x] **T28**. Decision + implementation: MCP tool invocations →
      `PluginUsageEvent` usage accounting (recommended: on).

## Phase 4 — stdio transport + PLUGIN_DATA (PR-7)

- [x] **T29**. `AGENT_PLUGINS_DATA_DIR` (default `/app/agent-plugins-data`);
      per-(tenant, package) data dirs; create-before-launch; delete on
      uninstall; SaaS write-through sync via boot-selected `IStoragePlugin`
      with DB-side key manifest.
- [x] **T30**. Stdio launcher: from-scratch env (`buildSubprocessEnv` pattern) +
      expanded package env overlay + `PLUGIN_ROOT`/`PLUGIN_DATA` last; single-
      token command resolution (bare vs `./`-relative) with containment; cwd
      rules per AP-13; process supervision + teardown at run end.
- [x] **T31**. Triple gate: feature flag + `AGENT_PLUGINS_STDIO` deployment
      setting (default off; v1 SaaS keeps it off — no sandbox route is built in
      this feature) + per-binding explicit enable; disabled stdio surfaces as
      "present, disabled by policy" (AP-19).
- [x] **T31b**. Phase-4 env wiring repeat of the 2026-06-12 checklist for
      `AGENT_PLUGINS_DATA_DIR` + `AGENT_PLUGINS_STDIO`: k8s manifests
      (dev/stage/prod) + deploy workflow env blocks + `.env.example` + compose
      files + explicit operator note for the ArgoCD-managed live env (outside
      this repo). Defaults keep boot non-fatal; the wiring is still required
      for the values to be settable.
- [x] **T32**. Full-spec conformance run: fixture packages exercising every
      Appendix A checklist row against the live loader; publish the checklist result
      as a doc page.

## Phase 5 — Sidecars + export (PR-8, PR-9)

> **2026-09-04 — T33 was ALREADY BUILT, and verified rather than rebuilt.**
> `skill_files` exists (`entities/skill-file.entity.ts`), with
> `SkillFileRepository`, `SkillFilesService`, the upload route on
> `skills.controller.ts`, and account-transfer support for
> `ExportedSkillFile`. `SkillFilesService.add` already caps size
> (`MAX_SKILL_FILE_BYTES`), stores through the uploads spine with sha256
> naming, coerces the MIME via the spine's own `acceptsSaveFileMime`
> predicate, and calls the `assertNoSecrets` this task asks to wire — plus
> `assertNoInjectionTokens`, which it does not.
>
> The remaining clause, "package service ingests sidecars", is satisfied
> differently and deliberately: a package's `scripts/`, `references/` and
> `assets/` are already ON DISK inside the package, so copying them into
> `skill_files` would duplicate bytes the acquirer already validated and
> contained. They are materialised straight from the package by
> `planWorkspaceMaterialization` (T34) under the execution-gate split.
> `skill_files` remains what it was: storage for PLATFORM-authored skills,
> whose files arrive by upload and have nowhere else to live.

- [x] **T33**. `skill_files` entity + migration + storage via `IStoragePlugin`
      (uploads-stack validation: sha256 naming, MIME sniff, per-file + per-skill
      size caps). NOTE: uploads stack does NOT secret-scan — wire
      `assertNoSecrets` (`packages/agent/src/utils/secret-scan.ts`) as a NEW
      check on text-like files only. Package service ingests sidecars; findings
      for oversized/rejected files.
- [x] **T34**. Materialization into claude-code workspace staging
      (`claude-code.plugin.ts:542-558` seam): `.claude/skills/<name>/…` +
      `.mcp.json` next to `seedMetadata` writes — with the **execution-gate
      split** (plan §4.5/§5, Greptile P1 on PR #2000): `references/`+`assets/`
      only by default (executable bits stripped); `scripts/` only for packages
      passing the stdio-grade triple gate; `.mcp.json` only for bind-enabled
      servers. Tests assert a non-gated package's scripts NEVER reach the
      workspace. Explicitly does NOT touch the Wave-2 Task-workspace path
      (`workspaceCwd` has no consumer — see plan §4.5).
- [x] **T35**. Export API + CLI + UI: scope-selected skills → conformant
      package (zip); round-trip gate (AP-22/23); slug guard enforcing the FULL
      spec name rule (≤64, no `--`, no leading/trailing hyphen — the DTO
      accepts all three) with rename prompt.
- [x] **T36**. `ever-works-mcp` package descriptor export (streamable-http
      `https://mcp.ever.works/mcp`, credential-free; docs updated by addition —
      pointer from `docs/features/mcp-server.md`, no removal).

## Phase 6 — Hardening + docs + conformance claim (PR-10)

- [x] **T37**. User-facing docs page `docs/features/agent-plugins.md` +
      sidebar entry in `apps/docs/sidebarsPlatform.ts`; internal docs stay
      off-nav.
- [x] **T38**. Desktop staging (`prepare-bundle.js` + `<userData>/agent-plugins`
      default source) + headless-node XDG dir.
- [x] **T39**. apps/mcp whitelist decision: expose `agent-plugins` management
      tools or document out-of-scope.
- [x] **T40**. Security review pass (stdio gate, SSRF policy, containment
      fuzzing over fixture escapes); Sentry tags; rate-limit re-check.
- [x] **T41**. Conformance statement doc: map every Appendix A row + AP-1…AP-23 to
      test evidence; announce "Agent Plugins v1.0.0 compatible (client: skills + MCP; producer: skills packages, plus the Ever Works MCP-server package
      descriptor)" — the single canonical claim wording, used verbatim in spec
      §1.3, the ADR, and marketing. MUST document client-side policy refusals
      explicitly (64KB body cap, secret/injection gates, stdio-off deployments,
      SSRF egress denies): spec-valid packages a deployment may decline to load,
      stated as policy, not as conformance gaps.

---

## Effort estimate (engineer-days, honest)

| Phase                         | Days                                  |
| ----------------------------- | ------------------------------------- |
| 0 — conformance lib           | 4–5                                   |
| 1 — registry + local + skills | 5–6                                   |
| 2 — git/npm + updates + UI    | 5–6                                   |
| 3 — MCP remote + bindings     | 6–8                                   |
| 4 — stdio + PLUGIN_DATA       | 5–7                                   |
| 5 — sidecars + export         | 5–6                                   |
| 6 — hardening + docs          | 3–4                                   |
| **Total**                     | **33–42** (plus review/CI wall-clock) |

Skills-only value ships at end of Phase 2 (~14–17 d); the full-standard claim
lands with Phase 4; export completes the producer story in Phase 5.

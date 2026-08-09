# Feature Specification: Agent Plugins Standard Interop

**Feature ID**: `agent-plugins`
**Branch**: `feat/agent-plugins`
**Status**: `Draft`
**Created**: 2026-08-09
**Last updated**: 2026-08-09
**Owner**: Product (Ruslan)

**External standards this feature implements**:

- **Agent Plugins v1.0.0** — <https://github.com/agentplugins/agent-plugins-spec> (`spec/1.0.0.md`);
  canonical schemas `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` and
  `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`.
- **Agent Skills** — <https://agentskills.io/specification> (authoritative for `SKILL.md`
  format, delegated to by Agent Plugins §6.1). Reference validator:
  [`skills-ref`](https://github.com/agentskills/agentskills/tree/main/skills-ref).
- **Model Context Protocol (MCP)** — <https://modelcontextprotocol.io/specification>
  (wire behavior for the MCP servers component type).

**Related code today**:

- Skills capability seam: `packages/agent/src/facades/skills.facade.ts`,
  `packages/plugin/src/contracts/capabilities/skills-provider.interface.ts`
- First-party skills provider: `packages/plugins/everworks-skills/` (ADR-012, ADR-014)
- Skill storage + install: `packages/agent/src/entities/skill.entity.ts`,
  `packages/agent/src/skills/skills.service.ts`, `apps/api/src/skills/`
- Native plugin system (unchanged): `packages/agent/src/plugins/services/plugin-loader.service.ts`,
  `packages/plugin/src/contracts/plugin-manifest.types.ts`
- Dynamic install machinery (ADR-016): `packages/agent/src/plugins/services/plugin-installer.service.ts`
- MCP server (we already ship one): `apps/mcp/`
- Agent run + tools: `packages/agent/src/agents/agent-tool.service.ts`,
  `packages/agent/src/policy/skill-activation.ts`

> **Scope**: Ever Works becomes a **conformant Agent Plugins v1.0.0 client** — it can
> load any third-party Agent Plugins package (both component types: **Skills** and
> **MCP servers**, all three transports) sourced from a **local directory, a git
> repository, or an npm package**, and it can **export** its own Skills (and its MCP
> server) as conformant packages. Ever Works Agents thereby consume and produce the
> open standard.
>
> **Hard rule (additive)**: Nothing existing changes. The native plugin system (open
> `everworks.plugin` manifest in `package.json`, all ~102 code plugins, the loader, the
> validator, `PLUGIN_ID_PATTERN`), the Skills subsystem (entities, API, UI, bindings,
> prompt injection), `skills-lock.json`, the checked-in `.agents/.claude/.cursor`
> skill dirs, and `apps/mcp` all keep working **exactly as they do now**. Agent Plugins
> packages are a **second, parallel format**: inert *data* packages read by new code —
> they are never loaded as Ever Works code plugins, and Ever Works code plugins do not
> gain `plugin.json` files.

---

## 0. Two plugin systems, one platform (read this first)

Ever Works' native plugins are **executable TypeScript packages** (dynamic-`import()`-ed
classes with capabilities, settings schemas, lifecycle hooks). Agent Plugins packages
are **inert data directories** (a manifest + markdown skills + MCP connection configs).
These are different species and MUST stay separate:

| | Native Ever Works plugin | Agent Plugins package |
|---|---|---|
| Manifest | `everworks.plugin` block in `package.json` (open schema) | `plugin.json` (closed schema, spec §4) |
| Content | Executable JS/TS (`dist/index.js`) | Data: `skills/*/SKILL.md`, `mcp.json`, assets |
| Loaded by | `PluginLoaderService` (`import()`) | New spec-package reader (fs reads only) |
| Validated by | `PluginManifestValidator` (unchanged) | New closed-schema validator (parallel, per spec §4) |
| Trust | First-party / ADR-016 allowlist; code runs in-process | Data is safe to parse; **only** stdio MCP servers execute anything, behind an explicit gate (§4.4) |

The bridge between the two worlds is **one new native plugin**
(`packages/plugins/agent-plugins`) that discovers installed spec packages and feeds
their contents into existing platform seams (skills catalog) and one new seam (MCP).

The existing validator MUST NOT be reused for spec manifests and MUST NOT be relaxed:
the two schemas disagree by design (spec `name` allows dots and 1-char names and
requires nothing but `$schema`+`name`; ours requires `id/name/version/category` and
rejects non-semver versions — which the spec forbids a client to reject, §4.4).

---

## 1. Overview & goals

1. **Consume (import)** — any conformant Agent Plugins package can be installed into
   Ever Works from:
   - a **local directory** (self-hosted / desktop / dev: point at a folder on disk),
   - a **git repository** (any host; ref-pinned),
   - an **npm package** (any registry we allow; version-pinned).
   Both component types are supported: its Skills appear in the existing Skills
   catalog and install/bind/inject exactly like catalog skills today; its MCP servers
   become bindable tool sources for Agents.
2. **Execute (MCP)** — Agents bound to a package's MCP server get that server's tools
   in their runs, via the official `@modelcontextprotocol/sdk` client, with all three
   transports (`stdio`, `streamable-http`, and legacy `sse` — the spec makes `sse`
   optional; we implement it because the SDK provides it).
3. **Export (produce)** — any set of Ever Works Skills can be exported as a conformant
   Agent Plugins package (`plugin.json` + `skills/`), and the Ever Works MCP server can
   be described as a conformant package (`mcp.json`, `streamable-http`), so other
   ecosystems' agents can consume what our users build.
4. **Full client conformance** — we target the complete §10.1 client checklist, not
   the §10.2 skills-only subset. A conformance fixture suite (valid + malformed
   packages) proves every MUST.

**Non-goals** (v1): hosting a public registry of Agent Plugins packages; converting
native Ever Works plugins into spec packages; supporting spec packages as a *code*
distribution channel (spec packages never contain platform-executable plugin code);
a marketplace UI beyond the sources/install surface described here.

---

## 2. Product behavior (user stories)

### 2.1 Installing a package

- **US-1 (local dir)**: A self-hosted operator sets one or more *package source
  directories* (env/setting). Every immediate child directory containing a valid
  `plugin.json` is listed as an *available package*. Install = register + validate +
  (skills) surface in catalog. No copy needed for local sources.
- **US-2 (git)**: A user pastes a git URL (+ optional ref/subdirectory) in
  **Settings → Agent Plugins → Sources**. The platform clones/fetches it into the
  managed packages directory, validates, and registers the package. Updating = re-fetch
  the pinned ref or move the pin.
- **US-3 (npm)**: A user enters an npm package name (+ version/dist-tag). The platform
  downloads the tarball (no `npm install`, no scripts — data-only extraction),
  validates, registers. Registry set and allowlist behavior follow ADR-016's
  configuration shape.
- **US-4 (validation feedback)**: Invalid packages are rejected with the spec-mandated
  granularity: fatal manifest violation → whole package rejected; unknown top-level
  manifest key → warn + continue; broken skill → that skill skipped, listed with a
  reason; broken `mcp.json` → MCP disabled for the package, skills still load; broken
  single server entry → that server skipped. The install UI shows each finding.

### 2.2 Using package skills

- **US-5**: Installed packages' skills appear in the existing `/skills` catalog UI
  (source-labeled with the package name/version), and behave *identically* to
  `everworks-skills` catalog entries: install-to-scope, bind to Agents/Works/Missions,
  prompt injection under the existing token budget, the `getSkillBody` on-demand tool,
  `allowed-tools` gating. (Note: today's injection is full-body-within-budget, with
  dropped skills omitted entirely — see plan §Progressive disclosure for the optional
  additive stub enhancement that closes the gap to the Agent Skills spec's level-1
  disclosure. Existing behavior is unchanged either way.)
- **US-6 (sidecars)**: Skills that ship `scripts/`, `references/`, or `assets/` keep
  those files. They are stored with the installed package and **materialized into the
  agent's workspace** when a run's environment supports file access (CLI runners /
  task workspaces), so `scripts/extract.py`-style references in skill bodies actually
  resolve. Runs without a workspace get the body only, plus a note that sidecar files
  are attached to the skill (progressive disclosure level 3).

### 2.3 Using package MCP servers

- **US-7**: An Agent's detail page gains an **MCP Servers** tab (additive, next to the
  existing Skills tab). It lists the MCP servers of installed packages; the user binds
  servers to the Agent. On the Agent's next run, the platform connects to bound servers
  (per declared transport) and exposes their tools to the model, namespaced
  `mcp__<server>__<tool>`, subject to the same allowed-tools policy that gates skills.
- **US-8 (secrets)**: Packages cannot ship credentials (spec §6.2.1). When a server
  needs auth, the user provides it in Ever Works per-server settings (encrypted at
  rest like plugin `x-secret` settings). At connect time Ever Works injects them as
  *client-generated* headers/env — which the spec explicitly permits and gives
  precedence over package-configured values.
- **US-9 (stdio gate)**: `stdio` servers execute a subprocess. This is OFF by default
  and gated per ADR-018: enabled by operator setting on self-hosted/desktop; on the
  managed SaaS it requires the sandbox/workspace execution path (same trust family as
  CLI runner plugins). `streamable-http`/`sse` servers are network clients and are
  enabled wherever outbound network policy allows.

### 2.4 Exporting

- **US-10**: From the `/skills` page (or CLI), a user selects skills they own at a
  scope and exports an Agent Plugins package: a zip/directory with a generated
  `plugin.json` and one `skills/<name>/SKILL.md` per skill (plus stored sidecars).
  Ever Works-specific fields ride in `extensions["works.ever"]`. Round-trip law:
  export → import into a fresh Ever Works → identical skill rows (modulo ids/scopes).
- **US-11**: `GET /api/agent-plugins/export/ever-works-mcp` (or CLI) emits the
  canonical package describing our own MCP server as a `streamable-http` entry —
  **without credentials** (auth is documented as client-generated headers), fixing the
  spec-illegal `env: {EVER_WORKS_API_KEY}` example currently in
  `docs/features/mcp-server.md` *by addition* (the new package is the conformant path;
  the existing doc gains a pointer, nothing is removed).

### 2.5 Where this runs

All deployment modes: **desktop/local** (sources default to a well-known local dir),
**self-hosted** (operator-configured dirs + git/npm), **managed SaaS** (git/npm
sources; managed packages directory on persistent storage). Mode differences are
configuration, not code paths.

---

## 3. Component model mapping (spec → Ever Works)

| Agent Plugins concept | Ever Works representation |
|---|---|
| Plugin (package) | New `agent_plugin_packages` row + files under the managed packages dir (or a registered local source dir) |
| `plugin.json` manifest | Parsed by the new conformance library; stored on the package row (`manifest` json column) |
| Skill (`skills/<name>/SKILL.md`) | `SkillCatalogEntry` via the `skills-provider` capability → existing `Skill` row on install (frontmatter preserved verbatim in the open `frontmatter` json column, body in `instructionsMd`) |
| Skill sidecar files (`scripts/`, `references/`, `assets/`) | Stored with the package; materialized into run workspaces (plan §Workspace) |
| MCP server (`mcp.json` entry) | New `mcp-provider` capability output → bindable via new `agent_mcp_server_bindings`; connected at run time by the new MCP client service in `packages/agent` |
| `extensions["works.ever"]` | Ever Works' reverse-domain namespace (our domain `ever.works` reversed). Carries EW-specific package/skill metadata on export; ignored-if-absent on import |
| `works.ever/` extension directory | Reserved for future EW-specific package files; v1 writes none, reads none (spec-legal) |
| `PLUGIN_ROOT` / `PLUGIN_DATA` | Absolute package dir / new per-package persistent data dir (plan §Data dirs) |

**Namespace decision**: the reverse-domain namespace is **`works.ever`** (from
`ever.works`). All Ever Works-specific manifest data lives under
`extensions["works.ever"]`; we never add unknown top-level keys to `plugin.json`
(that would be spec-invalid to *emit* even though clients must tolerate it).

---

## 4. Conformance requirements (normative for our implementation)

Every requirement below is testable and MUST be covered by the conformance fixture
suite (tasks.md). References are to Agent Plugins v1.0.0 sections.

### 4.1 Manifest loading (spec §4)

- **AP-1**: Load `plugin.json` from the package root; it MUST be a JSON object.
- **AP-2**: Permitted top-level fields only: `$schema`, `name`, `version`,
  `description`, `author`, `homepage`, `repository`, `license`, `keywords`,
  `extensions`. Required: `$schema` (exact canonical id) and `name`.
- **AP-3**: `name` MUST match `^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`
  and be 1–64 chars.
- **AP-4**: Severity split, exactly: unknown top-level field → **report + ignore,
  continue**; non-object `extensions` → **report + ignore, continue**; any other
  schema violation (missing/invalid `$schema` or `name`, wrong types, malformed
  `author`) → **fatal: reject the package, discover/execute nothing**.
- **AP-5**: MUST NOT reject for: non-semver `version`, unrecognized URL formats,
  non-email `author.email`, non-SPDX `license`. (Metadata is type-checked only.)
- **AP-6**: `extensions` namespaces we don't implement are ignored **without
  validating their contents**. We implement only `works.ever`.

### 4.2 Component discovery (spec §5, §6.1 + Agent Skills spec)

- **AP-7**: Skills discovered ONLY from `skills/`: each **immediate** child directory
  whose `SKILL.md` resolves to a regular file is one skill. No recursion. Missing
  `skills/` is not an error; `skills` present-but-not-a-directory invalidates the
  skills component type only.
- **AP-8**: Each `SKILL.md` is validated against the Agent Skills spec: frontmatter
  `name` (required; 1–64; `[a-z0-9-]`; no leading/trailing `-`; no `--`; MUST equal
  the parent directory name) and `description` (required; 1–1024; non-empty);
  optional `license`, `compatibility` (≤500), `metadata` (string→string map),
  `allowed-tools` (space-separated string). Unknown frontmatter keys are preserved,
  not rejected.
- **AP-9**: A non-conforming skill is **skipped alone** (reported); other skills and
  component types continue loading.
- **AP-10**: All resolved paths MUST stay inside the package root (symlinks allowed
  only if the target stays inside). Escapes: invalid root/manifest path → reject
  package; escaped `SKILL.md` → skip that skill; escaped MCP `command`/`cwd` → that
  server invalid; any other escaped path → access denied to that path.

### 4.3 MCP configuration (spec §6.2)

- **AP-11**: MCP config loaded ONLY from `mcp.json` at package root. Closed schema:
  `$schema` (canonical mcp id) + `mcpServers` map, nothing else. Empty map is valid.
- **AP-12**: `mcp.json` `$schema` version MUST match `plugin.json`'s targeted version;
  mismatch (or any top-level violation) disables MCP for the package **only** —
  skills keep loading.
- **AP-13**: Server entries form a closed union on `type`:
  - `stdio`: required `command` (single executable token: bare name OR `./`-relative;
    NO placeholder expansion in `command`); optional `args: string[]`,
    `env: {string: string}` (MUST NOT contain keys `PLUGIN_ROOT`/`PLUGIN_DATA`),
    `cwd` (must be `./…`, `${PLUGIN_ROOT}[/…]`, or `${PLUGIN_DATA}[/…]`; containment
    enforced post-expansion; omitted → package root).
  - `streamable-http` / `sse`: required `url` (absolute http(s); no userinfo; no
    fragment; https mandatory unless loopback); optional `headers` (valid header
    names; case-insensitive duplicate names invalid; no expansion performed).
  Unknown fields or unknown `type` → that entry invalid → **skip it, keep others**.
- **AP-14**: Transports: we support all three (`stdio`, `streamable-http`, `sse`);
  initial connection uses the declared transport; no fallback. A server that fails to
  start/connect/handshake is reported and does not affect other servers/components.
- **AP-15**: Package-configured `headers`/`env` are treated as visible, non-secret
  data. Ever Works-managed credentials are injected as client-generated values, which
  take precedence over same-name package values (case-insensitive for headers). We
  never forward package headers cross-origin on redirect without explicit user
  authorization.

### 4.4 Subprocess environment (spec §8) — stdio only

- **AP-16**: Every spawned server process gets `PLUGIN_ROOT` (absolute package root)
  and `PLUGIN_DATA` (absolute per-installed-package writable data dir that persists
  across package updates; deletable on uninstall). The client creates `PLUGIN_DATA`
  before launch.
- **AP-17**: `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded by single,
  non-recursive textual replacement in: `args` elements, `env` **values**, and `cwd`
  — nowhere else (not `env` keys, not `command`). No other placeholder or env-var
  expansion is performed; unrecognized placeholder-like text stays literal.
- **AP-18**: The subprocess base environment is client-chosen (we reuse the
  restrictive allowlist approach of the CLI-runner plugins); package `env` overlays
  it; `PLUGIN_ROOT`/`PLUGIN_DATA` are set last and win.
- **AP-19**: `stdio` execution is gated (US-9). When the gate is off, `stdio` entries
  are surfaced as "present but disabled by policy" — which the spec treats the same
  as an unsupported transport: skip, report, continue.

### 4.5 Versioning & updates (spec §9)

- **AP-20**: We use the manifest `$schema` id to select the targeted spec version;
  v1.0.0 is the only supported version at launch (unknown → reject with a clear
  message; the version registry is a table in the conformance library, ready for
  1.x additions).
- **AP-21**: Package `version` (when present and parseable) drives update checks and
  the catalog's "update available" surface. Absent/unparseable `version` is legal
  (AP-5): such packages are updateable only by re-fetch (git ref / npm version
  pin), and skill catalog entries synthesize their version from the package content
  hash.

### 4.6 Export (producer side)

- **AP-22**: Exported packages MUST validate against our own importer at maximum
  strictness (round-trip law, US-10) and against the published JSON Schemas.
- **AP-23**: Export maps: skill `slug` → directory name + frontmatter `name` (slugs
  longer than 64 chars or containing `--` are rejected with a rename prompt — spec
  names are stricter than our slug DTO); `frontmatter` json → YAML frontmatter
  (preserving unknown keys; `allowedTools: string[]` serialized back to the
  spec's space-separated `allowed-tools` string); `instructionsMd` → body;
  stored sidecars → files. EW-specific metadata (owner scope, catalog provenance)
  goes under `extensions["works.ever"]`, never top-level.

---

## 5. What does NOT change (checkable guarantee)

Verifiable by `git diff` on the implementing PRs — these surfaces are untouched:

- `packages/agent/src/plugins/services/plugin-loader.service.ts`,
  `plugin-manifest-validator.service.ts` (`PLUGIN_ID_PATTERN`, `SEMVER_PATTERN`
  not relaxed), `plugin-installer.service.ts` behavior for native plugins,
  `plugins.constants.ts` `DEFAULT_PLUGIN_PATHS`.
- `packages/plugin/src/contracts/plugin-manifest.types.ts` — `PluginManifest` stays
  the native manifest; `package.json` `everworks.plugin` stays authoritative for
  native plugins. (The contracts package gains **new** capability interfaces only.)
- All existing plugins including `packages/plugins/everworks-skills` (keeps
  `defaultForCapabilities`, its GitHub catalog source, and its builtin fallback).
- `Skill` / `SkillBinding` entities and every existing column; existing skills API
  routes and DTOs; `/skills` and `/agents/[id]/skills` UI (they gain additive
  source labels/tabs only).
- `apps/mcp` (the server), its transports and deployment.
- `.agents/skills`, `.claude/skills`, `.cursor/skills`, `skills-lock.json`.
- ADR-016 dynamic distribution for native plugins — untouched; spec-package sources
  are a parallel, data-only channel.
- The `ever-works/skills` GitHub catalog repo and its `manifest.json` format.

New surfaces are additions: new packages, new entities (+migrations), new API routes,
new UI tabs/pages, new env vars, new capability interface — enumerated in plan.md.

---

## 6. Resolved decisions (founder, 2026-08-09)

1. **Both component types** — Skills AND MCP servers; all three transports; full
   §10.1 conformance, not §10.2 skills-only.
2. **All three source kinds** — local directory AND git AND npm, availability
   governed by deployment mode + operator policy.
3. **Strictly additive** — nothing existing is dropped or changed in behavior.
4. **Terminology**: Agent Plugins v1.0.0 has exactly two component types. "Agents"
   (e.g. Claude Code's `agents/` subagent dirs) are NOT a spec component type; such
   client-specific dirs are extension directories we ignore per AP-6. If a future
   spec version adds component types, AP-20's version registry is the extension
   point.

## 7. Open questions

1. **SaaS stdio default** — stdio-on-SaaS ships behind the sandbox/workspace path;
   whether any SaaS tier enables it at launch is a go-to-market call (spec-wise,
   AP-19 keeps us conformant either way).
2. **Package-skill auto-updates** — when a git/npm source updates, do installed
   skills re-sync automatically or on explicit user action? Default: explicit, with
   an "update available" indicator (mirrors today's catalog behavior; the unwired
   `checkForUpdates` seam becomes reachable in this feature).
3. ~~**skills-ref adoption**~~ — **resolved 2026-08-09**: `skills-ref` is a Python
   reference library (PyPI), incompatible with our TypeScript runtime — the NN #22
   exception (d) applies. We implement Agent Skills frontmatter validation in our
   conformance library, with the spec's constraint tables as fixtures;
   `skills-ref validate` MAY be run in CI as an independent oracle over the same
   fixtures (non-blocking job).

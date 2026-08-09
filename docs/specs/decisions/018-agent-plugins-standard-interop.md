# ADR-018: Agent Plugins v1.0.0 Standard Interop (parallel data-package format)

## Status

**Proposed** — spec at [`../features/agent-plugins/spec.md`](../features/agent-plugins/spec.md);
scope decisions confirmed with @evereq 2026-08-09 (both component types, all three
source kinds, strictly additive).

## Date

2026-08-09

## Context

[Agent Plugins v1.0.0](https://github.com/agentplugins/agent-plugins-spec) is an
open, vendor-neutral packaging standard for agent capabilities with exactly two
component types: **Skills** (delegating `SKILL.md` format to the
[Agent Skills spec](https://agentskills.io/specification)) and **MCP servers**
(a `mcp.json` connection-config format over the
[MCP spec](https://modelcontextprotocol.io/specification)). We want Ever Works
Agents to consume and produce this standard.

Ever Works already has a plugin system — but it is a different kind of thing:
native plugins are **executable TypeScript packages** declared via an open
`everworks.plugin` manifest in `package.json`, dynamically `import()`-ed by
`PluginLoaderService`, with capabilities/settings/lifecycle (ADR-012, ADR-016).
The Agent Plugins manifest is a **closed** schema (`plugin.json`,
`additionalProperties: false`) describing an **inert data directory**. The two
manifests are mutually incompatible by construction:

- Spec `name` permits dots and 1-char names; our `PLUGIN_ID_PATTERN`
  (`plugin-manifest-validator.service.ts`) forbids both and enforces a 3-char
  minimum.
- Our validator fatally rejects non-semver `version`; spec §4.4 forbids a client
  from rejecting exactly that.
- Our manifest requires `id`/`name`/`version`/`category`
  (`plugin-manifest-validator.service.ts:45-48`); `id` and `category` are not
  legal top-level keys in the spec manifest at all.

Meanwhile, the _destination_ side of skills is already built: the
`skills-provider` capability seam (`SkillsFacadeService` fan-out, first-wins slug
dedupe), `Skill` rows with an open `frontmatter` json column, install → bind →
progressive-disclosure prompt injection + `getSkillBody` tool. The missing pieces
are a spec-conformant package reader, an MCP _client_ (we only ship an MCP
_server_, `apps/mcp`), and an export serializer.

## Decision

1. **Parallel format, never a merge.** Agent Plugins packages are a second,
   coexisting format. Native plugins do not gain `plugin.json`; spec packages
   never contain platform-executable plugin code; `PluginManifestValidator` is
   not reused and not relaxed. A new, standalone conformance library implements
   the closed spec schemas (plugin.json, mcp.json, Agent Skills frontmatter),
   discovery, path containment, and `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` expansion.

2. **Platform bridge services connect the two worlds.** A new module in
   `packages/agent/src/agent-plugins/` exposes (a) package skills through an
   additive, optional second source in `SkillsFacadeService` — merged last, so
   catalog/install/bindings/injection are reused unchanged and existing entries
   can never be displaced — and (b) MCP server configs through a
   `McpServerConfigService` consumed by a new MCP client service in
   `packages/agent` (official `@modelcontextprotocol/sdk`, per NN #22). This is
   deliberately NOT a native plugin: plugins are instantiated bare with no
   repository access, and the package registry is tenant-scoped DB state a
   plugin could neither query nor scope (and the `skills-provider` seam is
   scope-blind).

3. **Sources: local directory, git, npm — data-only acquisition.** Local dirs
   are registered in place. Git sources are fetched ref-pinned. npm sources are
   tarball-extracted **without** `npm install` and **without** lifecycle scripts
   (data packages have no dependencies to install). Source configuration and
   allowlisting follow the shape of ADR-016 but form a separate, parallel
   channel: ADR-016's registry/trust config governs _code_ plugins; this ADR's
   sources govern _data_ packages. Neither reuses the other's trust grants.

4. **Trust boundary: parsing is safe; only stdio executes.** Reading manifests,
   skills, and `mcp.json` is pure data handling and is available everywhere.
   Remote MCP transports (`streamable-http`, `sse`) are outbound network clients,
   enabled where outbound policy allows, with Ever Works-managed credentials
   injected as client-generated headers (never stored in packages — spec §6.2.1
   forbids it). `stdio` MCP servers execute a subprocess: **disabled by
   default**, operator-enabled on self-hosted/desktop; on the managed SaaS,
   stdio stays disabled in v1 — enabling it there requires a sandboxed
   execution route this feature does not build (explicit follow-up decision).
   Skill sidecar `scripts/` are never executed by the platform itself — but a
   CLI-runner workspace IS an execution surface (the runner spawns without a
   sandbox), so `scripts/` materialization is gated by the same execution gate
   as stdio, while non-executable `references/`/`assets/` materialize under
   standard content validation only.

5. **`works.ever` is our extension namespace** (reverse-domain of `ever.works`),
   for Ever Works-specific data in exported manifests (`extensions["works.ever"]`)
   and, if ever needed, a `works.ever/` package directory. We ignore all other
   namespaces without validating them (spec §7).

6. **Full client conformance is the target** — spec §10.1 including the optional
   `sse` transport, proven by a fixture suite of valid and malformed packages
   exercising every MUST (fatal vs non-fatal manifest errors, skip-one-skill,
   disable-MCP-only, per-server skip, containment escapes, expansion rules).

## Consequences

- Ever Works can truthfully claim "Agent Plugins v1.0.0 compatible (client,
  skills + MCP)" and "exports Agent Plugins packages".
- Two manifest validators exist permanently, by design. Documentation must say
  plainly which format a given directory is.
- New persistent surfaces: installed-package registry table, per-package
  `PLUGIN_DATA` directories (persistent storage in SaaS), MCP server bindings
  table, new env vars for the packages/data dirs — each wired through deploy
  manifests per the 2026-06-12 `PLATFORM_ENCRYPTION_KEY` lesson.
- The unwired `checkForUpdates` seam on `skills-provider` becomes load-bearing
  (update-available indicators for git/npm sources).
- Export makes our skills portable to any conformant client — the open-standard
  posture matches the product's "you own everything" positioning.

## Alternatives considered

- **Extend the native manifest to swallow the spec** — rejected: the schemas
  conflict on closed-vs-open and validation severity; merging would either
  relax our validator (regression risk for 102 plugins) or violate spec MUSTs.
- **Skills-only conformance (§10.2)** — valid per spec, rejected by product:
  MCP servers are half the standard's value and the founder wants full support.
- **Treat spec packages as a new native plugin category** — rejected: spec
  packages are data; loading them through `import()`-based machinery would grant
  them a code-execution trust class they must not have.

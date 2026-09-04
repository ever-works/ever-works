# Agent Plugins v1.0.0 — conformance statement

> **Claim**: Agent Plugins v1.0.0 compatible (client: skills + MCP; producer:
> skills packages, plus the Ever Works MCP-server package descriptor).
>
> This page is checked by
> `packages/agent-plugins/src/__tests__/conformance-statement.spec.ts`, which
> fails the build if a requirement in
> [`spec.md`](spec.md) has no row here, if a row names a requirement that does
> not exist, or if a row cites evidence that has been deleted. It is a
> statement that can be falsified, not a badge.

## How to read the status column

| Status            | Meaning                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Met**           | Implemented, with the cited evidence exercising it.                                                                                                     |
| **Met (library)** | The specification rule is enforced by `@ever-works/agent-plugins`; nothing outside it can accept a package the library rejects.                         |
| **Not yet**       | Deliberately unimplemented at this point in the programme. The row says what is missing and what the current behaviour is instead — never a silent gap. |

A "Not yet" row is not a conformance failure on its own: v1.0.0 lets a client
support a subset of component types, provided it is honest about which. The
claim above names skills and MCP as the supported client components, and the
rows below say exactly where the subprocess half stops.

---

## Manifest (AP-1 … AP-6)

| ID   | Requirement                                                          | Status        | Evidence                                                                                                    |
| ---- | -------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| AP-1 | Load `plugin.json` from the package root; MUST be a JSON object      | Met (library) | `manifest.ts` `loadManifest`; fixtures `fatal-manifest-invalid-json`, `fatal-manifest-not-an-object`        |
| AP-2 | Permitted top-level fields only                                      | Met (library) | `PERMITTED_MANIFEST_FIELDS`; `conformance.spec.ts`                                                          |
| AP-3 | `name` matches the specified pattern                                 | Met (library) | `PLUGIN_NAME_PATTERN`; eight `fatal-manifest-name-*` fixtures covering each way the pattern can be violated |
| AP-4 | Severity split, exactly as specified                                 | Met (library) | `findings.ts` severities; `manifest.ts` §5.2 split; `conformance.spec.ts` fatal/non-fatal boundary          |
| AP-5 | MUST NOT reject for non-semver `version` or unrecognised URL formats | Met (library) | `validateManifest`; the catalog synthesises a version rather than rejecting — `package-catalog.service.ts`  |
| AP-6 | Unimplemented `extensions` namespaces ignored without error          | Met (library) | `readExtension`, `isReverseDomainNamespace`                                                                 |

## Skills (AP-7 … AP-10)

| ID    | Requirement                                                 | Status        | Evidence                                                                                                                                                                                                                                                                  |
| ----- | ----------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AP-7  | Skills discovered only from immediate children of `skills/` | Met (library) | `discoverSkills` — directory **listing**, matching `SKILL.md` exactly                                                                                                                                                                                                     |
| AP-8  | Each `SKILL.md` validated against the Agent Skills spec     | Met (library) | `parseSkillMd`, `validateSkillFrontmatter`                                                                                                                                                                                                                                |
| AP-9  | A non-conforming skill is skipped **alone**                 | Met           | `conformance.spec.ts` isolation cases; end-to-end in `catalog-integration.spec.ts` ("keeps the good skills of a package whose other skills are broken")                                                                                                                   |
| AP-10 | All resolved paths stay inside the package root             | Met           | `paths.ts` `resolveRelativeSegments` walks segment by segment applying `realpath`, because `path.join` collapses `..` lexically **before** symlinks are followed; enforced again after every remote fetch in `remote-acquire.service.ts`, which deletes a tree that fails |

## MCP (AP-11 … AP-15)

| ID    | Requirement                                                                               | Status        | Evidence                                                                                                                                                                                                                           |
| ----- | ----------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AP-11 | MCP config only from `mcp.json`, closed schema                                            | Met (library) | `PERMITTED_MCP_FIELDS`, `parseMcpConfig`                                                                                                                                                                                           |
| AP-12 | `mcp.json` `$schema` version must match `plugin.json`'s                                   | Met (library) | `versions.ts`. Note the trap recorded in ADR-018: this is a string **equality** check, not a compatibility-set check, so a 1.0.0 manifest beside a 1.1.0 `mcp.json` disables MCP even though both releases load                    |
| AP-13 | Server entries form a closed union on `type`                                              | Met (library) | `validateMcpConfig`; `McpServerConfig` union                                                                                                                                                                                       |
| AP-14 | All three transports supported                                                            | **Partial**   | `streamable-http` and `sse` reach the client. `stdio` is now parsed, gated, planned and launchable (`stdio-server.service.ts`), but nothing in the agent run path calls it yet, so a stdio server contributes no tools to an agent |
| AP-15 | Package `headers`/`env` are visible and non-secret; no cross-origin credential forwarding | Met           | `guarded-fetch.ts` — redirects are followed manually, each hop re-checked, and **every** caller header dropped on an origin change; `guarded-fetch.spec.ts` covers port-only and scheme-downgrade hops                             |

## Subprocess (AP-16 … AP-19)

| ID    | Requirement                                                            | Status        | Evidence                                                                                                                                                                                                                                                                          |
| ----- | ---------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AP-16 | Every spawned process gets `PLUGIN_ROOT` and `PLUGIN_DATA`             | **Met**       | `stdio-launcher.ts` `buildLaunchEnv` writes both LAST and unconditionally, so a package cannot redirect them by declaring them; `AgentPluginPackageDataDirService` allocates the data directory per (owner, package) before launch                                                |
| AP-17 | `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` expanded by single substitution    | Met (library) | `expand.ts`; `mcp-server-config.service.ts` expands `PLUGIN_ROOT` and **refuses** any server referencing `PLUGIN_DATA`, because no data directory is allocated yet — a refusal with a reason rather than an empty path that fails at launch                                       |
| AP-18 | Subprocess base environment is client-chosen                           | **Met**       | Built from `{}` with only PATH/HOME/TMPDIR inherited, never filtered from `process.env` — a denylist would have to enumerate every platform secret added later. `stdio-launcher.spec.ts` asserts DATABASE*URL, AUTH_SECRET, a PLUGIN*\* key and the encryption key are all absent |
| AP-19 | `stdio` execution is gated; when off, entries are present-but-disabled | **Met**       | `AGENT_PLUGINS_STDIO`, default off. A stdio server is reported with `code: "disabled-by-policy"` and `enableable: true` — distinguishable from every other skip, all of which are `enableable: false`. `mcp-server-config.service.spec.ts`                                        |

## Versioning and updates (AP-20 … AP-21)

| ID    | Requirement                                             | Status        | Evidence                                                                                                                                                                                                                               |
| ----- | ------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AP-20 | Manifest `$schema` id selects the targeted spec version | Met (library) | `specVersionFromPluginSchemaId`; 1.0.0 and 1.1.0 both accepted, 1.0.0 published                                                                                                                                                        |
| AP-21 | Package `version` drives update checks                  | Met           | `update.service.ts`. npm compares the registry version; git compares the resolved **commit**, since a git package has no version to compare. Unreachable is reported separately from up-to-date — an outage must not read as "current" |

## Producer (AP-22 … AP-23)

| ID    | Requirement                                            | Status        | Evidence                                                                                                                                                            |
| ----- | ------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AP-22 | Exported packages validate against our own importer    | **Not yet**   | `serialize.ts` produces conforming manifests and `SKILL.md` bodies byte-for-byte, and is round-trip tested; the export **flow** that assembles a package is Phase 5 |
| AP-23 | Export maps slug → directory name + frontmatter `name` | Met (library) | `serialize.ts` `toSpecSkillName`, `repairName` — including the case where a legal period must survive repair                                                        |

---

## Summary

|                     | Count     |
| ------------------- | --------- |
| Met / Met (library) | 21        |
| Partial             | 1 (AP-14) |
| Not yet             | 1 (AP-22) |

What remains traces to two things. **AP-22** waits on the package export flow,
which is Phase 5. **AP-14** is partial because the stdio launcher exists and is
tested but is not yet called from the agent run path — a stdio server can be
planned, gated and spawned, and still contributes no tools to an agent.

Neither is required for the claim as stated: a client may support a subset of
component types, and the claim names skills and MCP. Both are written here so
the boundary is visible rather than implied.

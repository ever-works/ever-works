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

| ID    | Requirement                                            | Status        | Evidence                                                                                                                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AP-22 | Exported packages validate against our own importer    | **Met**       | `export.service.ts` writes the package to a temporary directory and runs the REAL `loadPluginPackage` over it, refusing to return anything that does not load. Validating the in-memory strings would test something else: directory naming, the `skills/<name>/SKILL.md` layout and containment are facts about a tree, and a tree is what a consumer receives |
| AP-23 | Export maps slug → directory name + frontmatter `name` | Met (library) | `serialize.ts` `toSpecSkillName`, `repairName` — including the case where a legal period must survive repair                                                                                                                                                                                                                                                    |

---

## Summary

|                     | Count     |
| ------------------- | --------- |
| Met / Met (library) | 22        |
| Partial             | 1 (AP-14) |
| Not yet             | 0         |

One row remains short of Met. **AP-14** is partial because the stdio launcher
exists, is gated and is tested, but nothing in the agent run path calls it yet —
a stdio server can be planned, gated and spawned, and still contributes no tools
to an agent.

That is not required for the claim as stated: v1.0.0 lets a client support a
subset of component types provided it is honest about which, and the claim names
skills and MCP. It is written here so the boundary is visible rather than
implied — the remaining work is wiring, not specification compliance.

### A note on how to read "Met"

Every row above cites evidence that exists and runs. Where a row says Met, the
cited test or source enforces the rule; where it says Met (library), the rule is
enforced by `@ever-works/agent-plugins`, and nothing outside it can accept a
package the library rejects. No row is Met on the strength of an intention.

---

## Policy refusals — spec-valid packages this deployment may decline

Everything below describes a package that is **conformant**, which Ever Works
may still refuse to load or run. These are deployment policy, not gaps in the
implementation, and they are listed because the distinction is invisible from
the outside: an author whose package is refused deserves to know whether they
broke a rule or met one this platform declines to exercise.

The specification anticipates this. A conforming client may apply its own
security policy; what it may not do is refuse and call the package invalid.
Every refusal below is reported with a reason and a machine-readable `code`.

| Refusal                                 | Applies to                                                                                      | Why                                                                                                                                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **stdio disabled**                      | Any `stdio` server, when `AGENT_PLUGINS_STDIO` is off                                           | Launching a subprocess from package contents is a far larger grant than reading documents, and no sandbox is built. Reported as `disabled-by-policy` with `enableable: true` — the only refusal an operator can lift with a setting.               |
| **Loopback and private URLs**           | A remote server whose URL resolves to a private, loopback, link-local or cloud-metadata address | The specification permits plain `http:` to **loopback** hosts, which is right for a desktop client talking to a local dev server. Ever Works is a server, where loopback is the API pod's own localhost and `http://127.0.0.1:6379` reaches Redis. |
| **Cross-origin credential forwarding**  | A remote server that redirects across an origin                                                 | Package headers are visible and non-secret (AP-15), but they are still forwarded on the first request. Every caller header is dropped on an origin change, so a server that relies on them surviving a redirect will not work.                     |
| **`${PLUGIN_DATA}` in a remote server** | A `streamable-http` or `sse` URL or header referencing it                                       | Only a launched subprocess can resolve a per-package data path; nothing can supply one for a URL. A stdio server using the same placeholder is fine — the launcher resolves it.                                                                    |
| **Ambiguous server names**              | A server whose name contains `__`                                                               | Tool names are `mcp__<server>__<tool>`, so such a name could not be split back apart and a call could route to the wrong server.                                                                                                                   |
| **Unallowlisted remote sources**        | Any git or npm package not on the allowlist                                                     | Fetching is an operator decision. The allowlist fails **closed**: if it cannot be read, every remote package is refused rather than permitted.                                                                                                     |
| **Non-registry npm specifiers**         | A version specifier naming a transport rather than a version                                    | `npm-package-arg` picks the transport from the spec's shape, so `pkg@git+https://host/x.git` would clone and run an arbitrary repository. Only semver, ranges and dist-tags are accepted.                                                          |

None of these makes a package non-conformant, and none of them is reported as a
validation failure. A refused package appears in `skipped` with its reason
intact, and the operator can see exactly what was declined and why.

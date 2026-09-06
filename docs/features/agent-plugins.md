---
id: agent-plugins
title: Agent Plugins
sidebar_label: Agent Plugins
sidebar_position: 14
---

# Agent Plugins

Ever Works supports the open
[Agent Plugins v1.0.0](https://github.com/agentplugins/agent-plugins-spec)
standard, so skills and MCP servers can be packaged once and used across any
client that supports it — not only Ever Works.

:::tip What this changes
Nothing about the plugins you already use. Agent Plugins is an **addition**: a
second, cross-vendor way to bring skills and MCP servers into your workspace,
alongside the existing plugin system, which is unchanged.
:::

## What a package is

A package is a directory with a small, fixed shape:

```
my-package/
  plugin.json              # who the package is
  skills/
    release-notes/
      SKILL.md             # a skill: instructions the agent can follow
  mcp.json                 # optional: MCP servers the package declares
```

Every part is optional except `plugin.json`. A package may ship only skills,
only an MCP server declaration, or both — the standard lets a package support
any subset, and lets a client support any subset too.

## Turning it on

Agent Plugins support is **off by default**. An operator enables it by setting
`FEATURE_AGENT_PLUGINS=true`; see the
[deployment runbook](/specs/features/agent-plugins/deployment) for the full
list of variables.

With it off, nothing changes: no package directory is read, no additional
catalog source is consulted, and the API reports `enabled: false` so you can
tell "turned off" from "turned on with nothing installed".

## Installing packages

Three ways, in increasing order of how much the platform does for you:

1. **A directory on disk.** Point `AGENT_PLUGINS_DIR` at it. You own the bytes,
   so nothing else is required.
2. **From git or npm.** Requires an **allowlist entry** for that exact package
   name or git URL. Fetching code on someone's behalf is an operator decision,
   so it is one you have to make explicitly.
3. **Built by Ever Works.** Export your own skills as a package — see below.

A fetched package is validated before it is kept. One that fails is **deleted**,
not left on disk, so it cannot be picked up later by the directory scanner.

## Seeing what a package contributed

**Settings → Agent Plugins** lists every installed package, the skills and MCP
servers it contributes, and every validation finding — grouped **per component**.

That grouping matters. The standard isolates failure: a package whose `mcp.json`
is invalid still contributes its skills. A flat list of errors would make such a
package look broken when most of it works, and would not tell you which half to
fix.

Packages that could not be loaded are shown too, rather than hidden. Somebody
put that directory there deliberately, so its absence needs an explanation.

## MCP servers from packages

A package can declare MCP servers, and Ever Works turns them into ordinary MCP
connections you manage in the usual place.

They arrive **disabled and unbound**. Installing a package never grants an agent
new network reach on its own — you enable the connection and bind it to an agent
yourself, exactly as you would for a server you had never seen before, which is
what a package's server is.

### stdio servers

A package can also declare a server that runs as a **subprocess**. That is a
much larger grant than reading documents, so it sits behind a second switch
(`AGENT_PLUGINS_STDIO`) that is also off by default and stays off on the hosted
service.

When it is off, such a server is shown as **present and disabled by policy** —
not hidden — so you can see what a package would run before deciding whether to
allow it.

## Exporting your own skills

Skills you have written can be exported as a conformant package for use in any
other client:

```bash
ever-works plugins agent-plugins list
```

Before an export is handed to you, Ever Works loads it back through its own
importer. A tool that emitted packages its own reader rejects would be
publishing a format nobody could rely on, and the failure would surface in
somebody else's client rather than here.

If a skill's name cannot be expressed under the standard's naming rule, the
export **tells you and suggests an alternative** rather than renaming it
quietly — a renamed skill is a different skill to anything that references it.

## Using the Ever Works MCP server elsewhere

The Ever Works MCP server is itself published as a package descriptor, so any
conforming client can install it rather than being configured by hand. It
contains **no credentials** — your client supplies its own. See
[MCP Server](./mcp-server) for details.

## What Ever Works does and does not implement

The [conformance statement](/specs/features/agent-plugins/conformance) maps
every requirement in the standard to the evidence for it, including the parts
that are not implemented and the spec-valid packages this platform may decline
to load as a matter of policy. It is checked by a test, so it cannot quietly
drift from what the code does.

## Related

- [Skills Catalog](./skills-catalog) — where package skills appear
- [MCP Server](./mcp-server) — the Ever Works MCP server, and its package descriptor
- [Plugin System](/plugin-system/) — the existing plugin system, unchanged

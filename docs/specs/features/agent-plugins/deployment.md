# Agent Plugins standard interop — deployment & operator runbook

> **Status**: env keys are wired in this repository and the feature flag
> defaults to `false`. Nothing changes in any environment until the variable
> is set to `true`.
>
> **Owner**: `ever@ever.co`. Files touched by this runbook: the three k8s
> manifests, the three deploy workflows, `.env.compose`, and the ArgoCD-managed
> environment described in §4 — which lives **outside this repository**.

Ever Works supports the open
[Agent Plugins v1.0.0](https://github.com/agentplugins/agent-plugins-spec)
format in addition to, and without altering, its own plugin system. A package
is a directory containing `plugin.json`, optional `skills/<name>/SKILL.md`
files, and an optional `mcp.json`. Any conforming client can read it, and the
same packages work across vendors.

---

## 1. The two variables

| Variable                 | Default                   | Meaning                                                                                                                                                              |
| ------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FEATURE_AGENT_PLUGINS`  | `false`                   | Lets installed packages contribute to the skills catalog.                                                                                                            |
| `AGENT_PLUGINS_DIR`      | `/app/agent-plugins`      | Where packages live. Several directories may be given, separated by `,`, `;` or the platform path delimiter. The **first** is the write target for fetched packages. |
| `AGENT_PLUGINS_STDIO`    | `false`                   | Whether stdio MCP servers declared by packages may be **launched**.                                                                                                  |
| `AGENT_PLUGINS_DATA_DIR` | `/app/agent-plugins-data` | Root for per-package writable data (`${PLUGIN_DATA}`).                                                                                                               |

Both are **safe to leave unset**. This is deliberate, and it is the reason
this feature cannot repeat the 2026-06-12 `PLATFORM_ENCRYPTION_KEY` incident,
where a required variable that was never wired crash-looped the API and rolled
silently back to the previous pods.

Two details that look like nitpicks and are not:

- The config layer reads these with `||`, **not** `??`. `envsubst` renders an
  unset variable as an **empty string**, not as `undefined`, so `??` would
  accept `''` as a deliberate value and resolve the package directory to
  nothing.
- They are repository **variables**, not secrets. Neither value is sensitive,
  and a secret is masked in the deploy log — which is precisely where an
  operator looks when packages are not appearing.

---

## 2. Turning it on

1. Set the repository variable `FEATURE_AGENT_PLUGINS` to `true` for the
   environment you are enabling (Settings → Secrets and variables → Actions →
   Variables).
2. Optionally set `AGENT_PLUGINS_DIR` if packages are mounted somewhere other
   than `/app/agent-plugins`.
3. Re-run the deploy workflow for that environment.
4. Verify with `GET /api/agent-plugins`. The response reports `enabled`
   explicitly, so **"the feature is off" and "it is on and there are no
   packages" are distinguishable** — without that field an operator who has
   just flipped the flag cannot tell which they are looking at.

To verify from the CLI instead:

```bash
ever-works plugins agent-plugins list
```

---

## 3. What the flag does and does not gate

**Gated.** Package skills appearing in the catalog; the boot re-materialisation
pass; update checks for packages.

**Not gated, because it never runs on its own.** Remote acquisition. Fetching a
package additionally requires an **allowlist entry** for that exact package
name or git URL. The allowlist fails closed: if it cannot be read, every remote
package is refused rather than permitted. A database outage must not become
unrestricted remote acquisition.

**Unaffected either way.** The existing plugin system, the existing skills
catalog, and every provider plugin. With the flag off the code paths are not
merely inert — the package source is not consulted at all, and the API reports
`enabled: false` without touching the filesystem.

---

## 4. The ArgoCD-managed live environment — outside this repo

The manifests in `.deploy/k8s/` are the source of truth for the **DigitalOcean**
deploy workflows in this repository. The live `*.ever.works` environment is
reconciled by **ArgoCD from a separate configuration repository**, and editing
the manifests here does **not** change it.

To enable the feature there, the same two variables must be added to that
repository's environment configuration for the API workload. Until that is
done, a package directory mounted into the live cluster will be ignored,
because the flag will read as empty and therefore `false`.

This is called out explicitly because the split is not visible from inside this
repository: every file this runbook touches is here, and the one that matters
for production is not.

---

## 5. Mounting packages

Packages can reach a pod three ways:

1. **Baked into the image** under `/app/agent-plugins`. Simplest, immutable,
   requires a rebuild to change.
2. **A mounted volume** at `AGENT_PLUGINS_DIR`. Survives restarts; the operator
   owns the contents.
3. **Fetched from git or npm** into the first configured directory. Requires an
   allowlist entry, and the fetched tree is validated before it is kept — a
   package that fails validation is deleted rather than left on disk, so it
   cannot be picked up by the directory scanner on a later boot.

For 1 and 2 the operator owns the bytes, so no allowlist entry is needed.

---

## 6. Rollback

Set `FEATURE_AGENT_PLUGINS` back to `false` and redeploy. Package skills
disappear from the catalog immediately; nothing else is touched, and no data is
removed. Packages already on disk stay there and are simply not read.

---

## 7. `AGENT_PLUGINS_STDIO` — a second, larger grant

This is deliberately **not** covered by `FEATURE_AGENT_PLUGINS`, and the
difference is worth being precise about.

The master flag lets a package contribute **documents** — Markdown skills — and
**declarations** of remote MCP servers. Those are inert: nothing in a package is
executed, and a remote server still needs an allowlist entry and an explicit
per-agent binding before an agent can reach it.

`AGENT_PLUGINS_STDIO` lets the platform **execute a subprocess from a package's
own contents**. That is a categorically larger grant, and one a deployment may
never want even while using packages happily. No sandbox is built in this
feature, so a stdio server runs with the API pod's own privileges and file
access.

**SaaS keeps this off.** Self-hosted operators who control exactly what they
install can turn it on.

### What "off" looks like

A stdio server on a deployment with the gate closed is reported as **present and
disabled by policy** (AP-19), not hidden. It appears under `skipped` with
`code: "disabled-by-policy"` and `enableable: true`, so an operator can see what
a package _would_ run before deciding whether to allow it — and a UI can offer
"enable stdio" rather than the misleading "contact the package author".

Every other skip reason carries `enableable: false`, because nothing the
operator sets will change it.

### `AGENT_PLUGINS_DATA_DIR`

Per-package writable state for `${PLUGIN_DATA}`. Kept **outside**
`AGENT_PLUGINS_DIR` on purpose: package contents are read-only and replaced
wholesale on update, while data has to survive that — and a writable directory
inside a scanned tree would also be walked by the package scanner.

Nothing creates it at boot; the launcher creates the per-package subdirectory it
needs, so setting the variable cannot fail a startup.

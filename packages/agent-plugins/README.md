# `@ever-works/agent-plugins`

A TypeScript reference loader for the
[Agent Plugins specification](https://github.com/agentplugins/agent-plugins-spec) — the
open, cross-vendor format for packaging agent capabilities as a directory containing a
`plugin.json` manifest, `skills/<name>/SKILL.md` bodies and an `mcp.json` declaring MCP
servers.

The package is pure by design: no NestJS, no database, no network, no filesystem access
outside the package root it is handed. It knows the standard and nothing about Ever
Works, which is what makes it usable on its own and lets it be the single place in the
monorepo where conformance is decided.

```ts
import { loadPluginPackage, summarizeLoad } from '@ever-works/agent-plugins';

const result = await loadPluginPackage('/path/to/some-plugin');

if (!result.ok) {
	// The manifest was fatally invalid, so nothing was discovered (spec 5.3).
	console.error(result.findings);
} else {
	console.log(result.skills.map((s) => s.name));
	console.log(result.mcpServers.map((s) => `${s.name} (${s.transport})`));
	console.log(summarizeLoad(result));
}
```

## What it implements

| Area                   | Covered                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest (spec 5)      | Closed `plugin.json` validation with the exact severity split, the name rule, and the metadata leniency a client MUST honour          |
| Skills (spec 7.1)      | Discovery from `skills/`, plus full Agent Skills frontmatter validation and the `allowed-tools` tokenizer                             |
| MCP servers (spec 7.2) | Closed `mcp.json` and closed server union, URL and header rules, stdio command and `cwd` forms, exact version match with the manifest |
| Containment (spec 4.1) | `realpath`-based checks with the five narrowest-failure-boundary rules                                                                |
| Expansion (spec 9.2)   | Single-pass, non-recursive `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` substitution in `args`, `env` values and `cwd`                       |
| Producer side          | Conformant `plugin.json` and `SKILL.md` emitters, with a guard that narrows internal identifiers to specification-legal names         |

It deliberately does **not** install packages, connect to MCP servers or launch
subprocesses. Those need policy, tenancy and credentials, and belong to the platform
layers above.

## Three things worth knowing

**The severity split is the hard part, not the schema.** Spec 5.2 draws a line through
"does not conform to the schema": an unknown top-level field and a non-object
`extensions` are reported and ignored, while every other violation is fatal and the
plugin is rejected without discovering anything. A plain `additionalProperties: false`
validation cannot express that, so the two tolerated cases are stripped — each with a
finding — before the document reaches the schema.

**Validation runs against the canonical upstream schemas**, vendored verbatim under
`src/schemas/` rather than paraphrased. A change in the published artifact then shows up
as a diff in a vendored file instead of as quiet drift between our reading of the
specification and the specification itself. The specification forbids fetching a schema
while loading a plugin (spec 5.2), so they are compiled in.

**Two releases are recognised, but a package may not mix them.** 1.0.0 and 1.1.0 map to
the same implementation because their published schemas are byte-identical apart from
version strings, which spec 5.2 explicitly permits when a client recognises the versions
as compatible. Spec 10.1 still requires `mcp.json` to match `plugin.json` **exactly**, so
a 1.0.0 manifest beside a 1.1.0 MCP configuration disables MCP for that package even
though both releases are supported.

## Findings

Nothing throws for a problem a package author can cause. Every problem comes back as a
`Finding` carrying a stable `code`, a `severity` and a `scope` that names which failure
boundary of the specification applies:

- `fatal` — the package is rejected; no component is discovered.
- `error` — one component type, one skill or one MCP server is unusable. Everything else
  loads.
- `warning` — nothing was lost; the specification asks for the report.

Codes are part of the public contract. Platform code and tests match on them, so a
rename is a breaking change.

## Tests

```bash
pnpm --filter @ever-works/agent-plugins test
```

371 tests across eight suites, including a corpus of ~50 real packages under
`fixtures/`. `conformance.spec.ts` walks the whole corpus and asserts the
specification's package-level properties — the fatal boundary, failure isolation between
component types, and one test per row of the Appendix A checklist.

`dist-artifact.spec.ts` is the odd one out and earns its place: it loads the **built**
bundles in a real Node process instead of importing `../src` through the test runner.
Bundler resolution is more forgiving than Node's, so a packaging defect is otherwise
invisible to a fully green suite — which is exactly how an unimportable ESM bundle
survived 366 passing tests here. It also proves that a load performs no network access,
since spec §5.2 forbids retrieving a schema while loading a plugin.

Tests that depend on the environment — real symlinks for containment, a built `dist/`
for the artifact checks — report a **visible skip** naming the reason when the
environment cannot provide it. None of them passes vacuously.

`fixtures/` is Prettier-ignored on purpose; see its README.

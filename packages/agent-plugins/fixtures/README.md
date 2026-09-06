# Agent Plugins conformance fixtures

Every directory here is a **real package on disk**, not a snippet: the loader
reads them exactly as it would read an installed package, so the corpus
exercises filesystem behaviour (directory listings, filesystem kinds, missing
locations) alongside document validation.

Naming says what the fixture proves:

| Prefix | Meaning |
| ------ | ------- |
| `valid-` | Loads. Some also carry non-fatal findings the specification asks a client to report. |
| `fatal-` | Rejected outright: the manifest is invalid, so no component is discovered (spec 5.3, 11.3.2). |
| `skills-` | The skills component type: discovery rules and per-skill skipping (spec 6.2, 7.1). |
| `mcp-` | The MCP component type: document-level disabling versus per-entry skipping (spec 7.2.2). |

**These files are deliberately malformed and MUST NOT be reformatted.**
`packages/agent-plugins/fixtures/` is listed in the repository
`.prettierignore`: the root `format:check` glob covers `**/*.{ts,tsx,jsx,json,css,md}`,
so without that entry CI would fail on the invalid-JSON fixtures and
`pnpm format` would silently repair them into valid documents, quietly
deleting the test cases.

Containment fixtures are **not** here. Escaping a package root needs symlinks,
which do not survive a git checkout on Windows without developer mode, so those
cases are built in a temporary directory at test time instead and skipped when
the platform refuses to create a symlink.

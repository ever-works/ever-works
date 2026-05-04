# `works.yml` v1 — Manifest Schema

> The manifest is the source of truth for a Work in the zero-friction onboarding
> flow. It lives at the root of the agent's GitHub repository and is read each
> time the platform reconciles.

**Feature**: [`agent-zero-friction-onboarding`](./spec.md)
**Status**: `Draft`
**Last updated**: 2026-05-04

---

## File location and form

- Path: `works.yml` at the repository root.
- Format: YAML 1.2.
- Encoding: UTF-8, LF line endings.
- Size: ≤ 64 KiB. Larger manifests should split fixed configuration here and put
  per-item content under a directory the manifest references.

## Top-level shape

```yaml
apiVersion: works.ever.works/v1
kind: Work
metadata:
  name: Awesome MCP Servers
  slug: awesome-mcp-servers       # optional; derived from name if absent
  description: A curated directory of Model Context Protocol servers.
  subdomain: mcp-servers          # optional; allocated automatically otherwise

spec:
  pipeline: agent-pipeline        # any registered pipeline plugin id
  domain: software                # software | ecommerce | services | general

  taxonomy:
    categories: [client, server, gateway, observability]
    tags: [open-source, paid, hosted]

  items:
    sources:
      - type: awesome-readme
        url: https://github.com/punkpeye/awesome-mcp-servers
        expansionFactor: 2
      - type: web-search
        query: "MCP server for X"
        max: 50

  generators:
    aiProvider: openai            # falls back to the platform default
    searchProvider: tavily

  deployment:
    target: vercel
    customDomain: optional.example.com   # optional

  output:
    repos:
      website: managed             # managed | none — should the platform create a website code repo?
      awesomeList: managed         # managed | none — should the platform create / sync an awesome README repo?
    llmsTxt: true                  # default true; emits /llms.txt on the deployed site
    itemsJson: true                # default true; emits /items.json
```

## Field reference

### `apiVersion` (required, string)

- Must be `works.ever.works/v1` for this version.
- Future versions get a new `apiVersion` rather than breaking changes here.

### `kind` (required, enum)

- `Work` — the only kind in v1.

### `metadata` (required, object)

| Field         | Type   | Required | Description                                                                  |
| ------------- | ------ | -------- | ---------------------------------------------------------------------------- |
| `name`        | string | yes      | 1–120 chars; human-readable.                                                 |
| `slug`        | string | no       | 3–63 chars, lowercase, `[a-z0-9](-[a-z0-9])*`. Defaults to slugified `name`. |
| `description` | string | no       | ≤ 1024 chars; used in SEO and the registry card.                             |
| `subdomain`   | string | no       | 3–63 chars, DNS-safe. If omitted or taken, the platform allocates one based on `slug`. |

### `spec` (required, object)

#### `spec.pipeline` (required, string)

The id of a registered `pipeline` plugin. Unknown values cause `unsupported_capability`.

#### `spec.domain` (required, enum)

One of `software`, `ecommerce`, `services`, `general`. Drives image routing and badge strategies (mirrors the existing `domainType` field on Works).

#### `spec.taxonomy` (optional, object)

| Field        | Type      | Default | Description                                                                                |
| ------------ | --------- | ------- | ------------------------------------------------------------------------------------------ |
| `categories` | string[]  | `[]`    | 0–64 entries, each 1–64 chars. Generation may add more if the manifest does not lock them. |
| `tags`       | string[]  | `[]`    | 0–128 entries, each 1–64 chars.                                                            |
| `lockTaxonomy` | boolean | `false` | If true, generation will not invent new categories/tags.                                   |

#### `spec.items.sources` (required, array, ≥ 1)

Each entry is one of the source variants below. Variants are tagged by `type`.

```yaml
# 1. awesome-readme — bootstrap from a GitHub Awesome README
- type: awesome-readme
  url: https://github.com/punkpeye/awesome-mcp-servers
  expansionFactor: 2     # 1–10, default 1

# 2. web-search — driven by the search-capability plugin
- type: web-search
  query: "MCP server for X"
  max: 100               # default 50, hard cap 500

# 3. data-repo — copy from an existing Ever Works data repo
- type: data-repo
  url: https://github.com/<owner>/<data-repo>
  mode: copy             # copy | link

# 4. inline — small lists declared directly
- type: inline
  items:
    - name: Foo Server
      url: https://example.com
      categories: [server]
```

#### `spec.generators` (optional, object)

| Field            | Type   | Default               | Description                                |
| ---------------- | ------ | --------------------- | ------------------------------------------ |
| `aiProvider`     | string | platform default      | Plugin id (e.g. `openai`, `anthropic`).    |
| `searchProvider` | string | platform default      | Plugin id (e.g. `tavily`, `brave`).        |
| `screenshot`     | string | platform default      | Plugin id (e.g. `screenshotone`, `urlbox`). |
| `model`          | string | provider's preferred  | Model identifier; passes to AI gateway.    |

#### `spec.deployment` (optional, object)

| Field          | Type   | Default  | Description                                              |
| -------------- | ------ | -------- | -------------------------------------------------------- |
| `target`       | string | `vercel` | Plugin id of the `deployment` capability.                 |
| `customDomain` | string | none     | DNS name; agent must point CNAME to the platform's host. |

#### `spec.output` (optional, object)

| Field                  | Type    | Default     | Description                                                                          |
| ---------------------- | ------- | ----------- | ------------------------------------------------------------------------------------ |
| `repos.website`        | enum    | `managed`   | `managed` lets the platform create a website code repo under the agent's user/org.    |
| `repos.awesomeList`    | enum    | `none`      | `managed` creates / syncs an Awesome-style README repo.                              |
| `llmsTxt`              | boolean | `true`      | Emit `/llms.txt` on the deployed site for downstream agents.                         |
| `itemsJson`            | boolean | `true`      | Emit `/items.json` (canonical item dump) on the deployed site.                       |
| `markerFile`           | string  | `.works/state.json` | Path the platform writes terminal status to in the manifest repo. Always under `.works/`. |

## Validation rules

The platform validates with a Zod schema living in
`packages/contracts/src/api/onboarding/manifest.schema.ts`. Failures produce a
typed `manifest_invalid` response with one error object per offending path:

```json
{
  "code": "manifest_invalid",
  "errors": [
    { "path": "spec.items.sources[0].url", "message": "Invalid GitHub URL" }
  ]
}
```

### Per-rule error subcodes (informational)

| Subcode                            | Cause                                                                |
| ---------------------------------- | -------------------------------------------------------------------- |
| `manifest.invalid_yaml`            | YAML parse error                                                     |
| `manifest.unsupported_apiversion`  | `apiVersion` not `works.ever.works/v1`                               |
| `manifest.invalid_kind`            | `kind` ≠ `Work`                                                      |
| `manifest.metadata.name_required`  | Missing or empty                                                     |
| `manifest.metadata.slug_format`    | Slug doesn't match DNS rule                                          |
| `manifest.spec.pipeline_unknown`   | Pipeline plugin not registered                                        |
| `manifest.spec.domain_invalid`     | Not one of the 4 allowed                                             |
| `manifest.items.sources_empty`     | `sources` array is missing or empty                                   |
| `manifest.items.source_type`       | Source `type` discriminator unknown                                  |
| `manifest.deployment.target_unknown` | Deployment plugin not registered                                    |
| `manifest.output.marker_outside_works` | `markerFile` not under `.works/`                                  |

## Examples

### Minimal valid manifest

```yaml
apiVersion: works.ever.works/v1
kind: Work
metadata:
  name: Open Source Time Trackers
spec:
  pipeline: standard-pipeline
  domain: software
  items:
    sources:
      - type: web-search
        query: "open source time tracker"
        max: 30
```

### Awesome-README-driven, with custom domain

```yaml
apiVersion: works.ever.works/v1
kind: Work
metadata:
  name: Awesome Vector Databases
  subdomain: vector-db
spec:
  pipeline: agent-pipeline
  domain: software
  taxonomy:
    categories: [self-hosted, managed]
    tags: [open-source, paid]
  items:
    sources:
      - type: awesome-readme
        url: https://github.com/dhamaniasad/awesome-vector-databases
        expansionFactor: 2
  generators:
    aiProvider: anthropic
    searchProvider: brave
  deployment:
    target: vercel
    customDomain: vector-db.example.com
  output:
    repos:
      website: managed
      awesomeList: managed
    llmsTxt: true
    itemsJson: true
```

## Compatibility

- **v1**: backwards-compatible additions only. Adding a new optional field is a
  patch-level change. Adding a required field requires bumping `apiVersion` to
  `v2`.
- The platform retains support for `v1` indefinitely; future versions are
  opt-in via `apiVersion` per manifest, not a global cutover.

## See also

- [Spec](./spec.md)
- [Plan](./plan.md)
- [Tasks](./tasks.md)
- Public-facing reference: `docs/agent-services/works-yml-schema.md`
  (mirrors this file for the docs site).

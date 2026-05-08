# @ever-works/apify-plugin

Apify - Import items from Apify datasets into your Work

## Plugin metadata

| Field        | Value                                 |
| ------------ | ------------------------------------- |
| ID           | `apify`                               |
| Category     | `data-source`                         |
| Capabilities | `data-source`, `form-schema-provider` |
| Author       | Ever Works Team                       |
| License      | AGPL-3.0                              |
| Built-in     | no                                    |
| Auto-enable  | no                                    |

## What does the Apify plugin do?

Apify is a web scraping and automation platform. This plugin imports items from Apify datasets into your work, enabling you to transform existing scraped data into structured work content.

## Why use it?

- **Bulk import** — import hundreds or thousands of items from an existing Apify dataset
- **Field mapping** — map Apify result fields (title, URL, description) to work item fields
- **Relevance filtering** — automatically filter imported items by relevance to your work topic
- **Compatible with any actor** — import data from any Apify actor or dataset

## How it works in Ever Works

During work generation, the data source facade queries the Apify plugin to fetch items from your specified dataset or actor run. The results are fed into the generation pipeline alongside other data sources. You can enable relevance filtering to ensure only topically relevant items are included.

## Getting started

1. Create an Apify account at [apify.com](https://apify.com)
2. Run an actor or prepare a dataset with the items you want to import
3. Enable the Apify plugin on this page and enter your API token
4. When creating a work, provide your dataset ID in the Apify section of the generation form

## Settings

- **Apify API Token** (`apiToken`) — secret, user-scoped. Found in your Apify Settings > Integrations.
- **Default Field Mapping** (`defaultFieldMapping`) — object mapping Apify fields to item fields. Defaults: `name → title`, `description → description`, `source_url → url`, `category → category`, `image_url → image`.

Per-work generator form fields (Level 3):

- **Dataset ID** (`apify_datasetId`) — the Apify dataset ID to import items from.
- **Actor Run ID** (`apify_actorRunId`) — alternative to dataset ID; import from a specific actor run.
- **Maximum Items** (`apify_maxItems`) — limit the number of items to import (default `100`, `0` = no limit).
- **Filter by Relevance** (`apify_filterByRelevance`) — only import items relevant to the work prompt (default `true`).

## Troubleshooting

| Symptom                          | Likely cause                                                                | Fix                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `401 Unauthorized`               | API token missing or revoked                                                | Re-issue the API token from the Apify console and re-enter it; or set `PLUGIN_APIFY_API_KEY` for default fallback             |
| Actor / dataset returns no items | Actor input misconfigured, dataset filter too restrictive, or run timed out | In the Apify dashboard re-run the actor manually with the same input, inspect the run log, then adjust input fields and retry |
| Plugin not used as data source   | Another data-source plugin is set as the default                            | In **Settings → Plugins**, set `apify` as the default for `data-source`, or disable competing plugins                         |
| `healthCheck` reports unhealthy  | Credential invalid OR Apify endpoint unreachable from the host              | Verify the credential against the upstream API and confirm outbound HTTPS is allowed by the firewall                          |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/apify-plugin build
pnpm --filter @ever-works/apify-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Apify homepage](https://apify.com)

## License

AGPL-3.0

# @ever-works/jina-plugin

Jina AI Plugin - Web search and content extraction using Jina AI APIs

## Plugin metadata

| Field        | Value                         |
| ------------ | ----------------------------- |
| ID           | `jina`                        |
| Category     | `content-extractor`           |
| Capabilities | `search`, `content-extractor` |
| Author       | Ever Works Team               |
| License      | AGPL-3.0                      |
| Built-in     | yes                           |
| Auto-enable  | no                            |

## What does Jina AI do?

Jina AI provides web search with LLM-optimized results and content extraction that converts any web page into clean markdown.

## Why use it?

- **Web search** — search the web and get results with content already extracted
- **Content extraction** — converts pages to clean markdown, strips ads and navigation
- **Domain filtering** — restrict search to specific domains

## How it works in Ever Works

During work generation, Jina finds relevant information about each item via search and extracts clean content from web pages for enriching descriptions.

## Getting started

1. Get an API key at [jina.ai](https://jina.ai)
2. Enter the key in the **API Key** field below
3. Enable the plugin

## Settings

- **API Key** (`apiKey`) — required, secret. Your Jina API key (also configurable via the `PLUGIN_JINA_API_KEY` environment variable).
- Stored at user scope so each user can supply their own credentials.
- Configuration mode is `hybrid` — admins can preset values and users may override them.

## Troubleshooting

| Symptom                                        | Likely cause                                                                                     | Fix                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` / `403` from the extractor               | API key / token missing or revoked                                                               | Re-enter the credential from the Jina AI dashboard, or set `PLUGIN_JINA_API_KEY` in the host environment for default fallback                                             |
| `Failed to extract content` for a specific URL | Page requires authentication, JavaScript rendering, or a custom client (Notion, PDF, login wall) | Verify the URL is publicly reachable; if it requires JavaScript/auth, switch to a more capable extractor (`scrapfly` / `notion-extractor` / `pdf-extractor`) for that URL |
| Plugin not used during extraction              | Another content-extractor plugin is set as the default                                           | In **Settings → Plugins**, set `jina` as the default for `content-extractor`, or disable competing plugins                                                                |
| `healthCheck` reports unhealthy                | Credential invalid OR Jina AI endpoint unreachable from the host                                 | Verify the credential with a manual call to the upstream API and confirm outbound HTTPS is allowed by the firewall                                                        |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/jina-plugin build
pnpm --filter @ever-works/jina-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Jina AI homepage](https://jina.ai)

## License

AGPL-3.0

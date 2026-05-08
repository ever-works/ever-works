# @ever-works/scrapfly-plugin

Scrapfly Plugin - Screenshot capture and content extraction using Scrapfly API

## Plugin metadata

| Field        | Value                             |
| ------------ | --------------------------------- |
| ID           | `scrapfly`                        |
| Category     | `content-extractor`               |
| Capabilities | `screenshot`, `content-extractor` |
| Author       | Ever Works Team                   |
| License      | AGPL-3.0                          |
| Built-in     | yes                               |
| Auto-enable  | no                                |

## What does Scrapfly do?

Scrapfly is a web scraping and screenshot API that handles JavaScript rendering, anti-bot bypass, and proxy rotation. It can capture screenshots of any web page and extract content from even heavily protected sites.

## Why use it?

- **Anti-bot bypass** — handles CAPTCHAs, JavaScript challenges, and bot detection
- **Screenshot capture** — full-page screenshots with JavaScript rendering
- **Content extraction** — pulls raw HTML from any page, including SPAs
- **Global proxy network** — access region-locked content from any country

## How it works in Ever Works

Scrapfly serves dual purposes during work generation: capturing screenshots for item preview images and extracting content from web pages. Its anti-bot capabilities make it effective for scraping sites that block standard HTTP requests.

## Getting started

1. Sign up at [scrapfly.io](https://scrapfly.io)
2. Copy your API key from the dashboard
3. Enter the key in the **API Key** field below
4. Enable this plugin for screenshot capture and/or content extraction

## Settings

- **API Key** (`apiKey`) — required, secret, user-scoped. Get one at [scrapfly.io](https://scrapfly.io). Backed by env var `PLUGIN_SCRAPFLY_API_KEY`.

This plugin uses a `hybrid` configuration mode, so the API key can be supplied at the admin level, the user level, or via the environment variable.

## Troubleshooting

| Symptom                                        | Likely cause                                                                                     | Fix                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` / `403` from the extractor               | API key / token missing or revoked                                                               | Re-enter the credential from the Scrapfly dashboard, or set `PLUGIN_SCRAPFLY_API_KEY` in the host environment for default fallback                                        |
| `Failed to extract content` for a specific URL | Page requires authentication, JavaScript rendering, or a custom client (Notion, PDF, login wall) | Verify the URL is publicly reachable; if it requires JavaScript/auth, switch to a more capable extractor (`scrapfly` / `notion-extractor` / `pdf-extractor`) for that URL |
| Plugin not used during extraction              | Another content-extractor plugin is set as the default                                           | In **Settings → Plugins**, set `scrapfly` as the default for `content-extractor`, or disable competing plugins                                                            |
| `healthCheck` reports unhealthy                | Credential invalid OR Scrapfly endpoint unreachable from the host                                | Verify the credential with a manual call to the upstream API and confirm outbound HTTPS is allowed by the firewall                                                        |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/scrapfly-plugin build
pnpm --filter @ever-works/scrapfly-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Scrapfly homepage](https://scrapfly.io)

## License

AGPL-3.0

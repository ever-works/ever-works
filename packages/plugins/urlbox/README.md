# @ever-works/urlbox-plugin

Urlbox screenshot plugin for Ever Works - capture website screenshots using the Urlbox Screenshot API

## Plugin metadata

| Field        | Value           |
| ------------ | --------------- |
| ID           | `urlbox`        |
| Category     | `screenshot`    |
| Capabilities | `screenshot`    |
| Author       | Ever Works Team |
| License      | AGPL-3.0        |
| Built-in     | no              |
| Auto-enable  | no              |

## What does Urlbox do?

Urlbox is a screenshot capture API. When work items include source URLs, this plugin automatically generates preview images by capturing a screenshot of each page.

## Why use it?

- **Automated capture** — preview images are generated for each work item without manual effort
- **Consistent output** — every screenshot uses the same viewport size, format, and rendering settings
- **Ad and cookie banner blocking** — captures clean screenshots free of ads and cookie banners
- **Retina rendering** — supports HiDPI output for crisp images on high-resolution displays
- **Multiple formats** — supports PNG, JPG, and WebP output with configurable quality

## How it works in Ever Works

During work generation, the screenshot facade sends capture requests to Urlbox for items that have a source URL. The resulting images are used as item preview thumbnails. You can configure viewport dimensions, image format, quality, retina rendering, and ad/cookie blocking behavior.

## Getting started

1. Sign up at [urlbox.com](https://urlbox.com)
2. Copy your API key and API secret
3. Enable the Urlbox plugin on this page
4. Enter your credentials in the settings below

## Settings

- **API Key** (required, secret) — your Urlbox API key; falls back to `PLUGIN_URLBOX_API_KEY`.
- **API Secret** (secret) — used to generate signed render links; falls back to `PLUGIN_URLBOX_API_SECRET`.
- **Viewport Width / Height** — default capture viewport in pixels (defaults: 1280 x 1024).
- **Image Format** — output format: `png`, `jpg`, `jpeg`, or `webp` (default: `png`).
- **Image Quality** — quality for lossy formats, range 1–100 (default: 80).
- **Retina** — enable HiDPI rendering at 2x device scale factor (default: off).
- **Block Ads** — strip ads from captured pages (default: on).
- **Hide Cookie Banners** — remove cookie consent banners (default: on).

## Troubleshooting

| Symptom                                    | Likely cause                                                                                     | Fix                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` / `Authentication failed`            | API key (or signing secret) missing or wrong                                                     | Re-enter the credential(s) from the Urlbox dashboard, or set `PLUGIN_URLBOX_API_KEY` (and signing-secret env var if applicable) for default fallback |
| Black / blank / `null` `imageUrl` returned | Target page failed to render within the configured timeout, or is blocked by anti-bot protection | Increase the timeout, enable wait-for-network-idle / `full_page` mode, or set a custom `user_agent` and `viewport`                                   |
| Plugin not used for screenshot capture     | Another screenshot plugin is set as the default                                                  | In **Settings → Plugins**, set `urlbox` as the default for `screenshot`, or disable competing plugins                                                |
| Quota exhausted / `429`                    | Monthly / per-minute screenshot cap reached on Urlbox                                            | Throttle calls, wait for the quota reset, or upgrade the plan in the Urlbox dashboard                                                                |
| `healthCheck` reports unhealthy            | Credential invalid OR Urlbox endpoint unreachable from the host                                  | Verify the credential with a manual call to the upstream API and confirm outbound HTTPS is allowed by the firewall                                   |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/urlbox-plugin build
pnpm --filter @ever-works/urlbox-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Urlbox homepage](https://urlbox.com)

## License

AGPL-3.0

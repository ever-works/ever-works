# @ever-works/screenshotone-plugin

ScreenshotOne screenshot plugin for Ever Works - capture website screenshots using the ScreenshotOne API

## Plugin metadata

| Field        | Value           |
| ------------ | --------------- |
| ID           | `screenshotone` |
| Category     | `screenshot`    |
| Capabilities | `screenshot`    |
| Author       | Ever Works Team |
| License      | AGPL-3.0        |
| Built-in     | no              |
| Auto-enable  | no              |

## What does ScreenshotOne do?

ScreenshotOne is a screenshot capture API. When work items include source URLs, this plugin automatically generates preview images by capturing a screenshot of each page.

## Why use it?

- **Automated capture** — preview images are generated for each work item without manual effort
- **Consistent output** — every screenshot uses the same viewport size, format, and rendering settings
- **Ad and tracker blocking** — captures clean screenshots free of ads and cookie banners
- **Multiple formats** — supports PNG, JPG, and WebP output with configurable resolution

## How it works in Ever Works

During work generation, the screenshot facade sends capture requests to ScreenshotOne for items that have a source URL. The resulting images are used as item preview thumbnails. You can configure viewport dimensions, image format, device scale factor, and caching behavior.

## Getting started

1. Sign up at [screenshotone.com](https://screenshotone.com)
2. Copy your access key and optional secret key (for signed URLs)
3. Enable the ScreenshotOne plugin on this page
4. Enter your credentials in the settings below

## Settings

- **Access Key** (required, secret) — your ScreenshotOne access key; falls back to `PLUGIN_SCREENSHOTONE_ACCESS_KEY`.
- **Secret Key** (secret) — used to generate signed URLs; falls back to `PLUGIN_SCREENSHOTONE_SECRET_KEY`.
- **Viewport Width / Height** — default capture viewport in pixels (defaults: 1280 x 800).
- **Image Format** — output format: `png`, `jpg`, `jpeg`, or `webp` (default: `png`).
- **Full Page** — capture the full scrollable page (default: off).
- **Device Scale Factor** — `1` for normal, `2` for retina (range 0.5–3).
- **Block Ads** — strip ads from captured pages (default: on).
- **Block Trackers** — strip tracking scripts (default: on).

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/screenshotone-plugin build
pnpm --filter @ever-works/screenshotone-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [ScreenshotOne homepage](https://screenshotone.com)

## License

AGPL-3.0

---
id: urlbox-deep-dive
title: Urlbox Plugin Deep Dive
sidebar_label: Urlbox
sidebar_position: 70
---

# Urlbox Plugin Deep Dive

## Overview

The Urlbox plugin (`@ever-works/plugins/urlbox`) is a screenshot capture plugin that uses the Urlbox API to generate website screenshots for directory items. It provides an alternative to the ScreenshotOne plugin, with additional features like retina rendering, cookie banner hiding, and configurable image quality.

The plugin implements the `IScreenshotPlugin` interface and uses the official `urlbox` npm package for API communication. It supports both unsigned and signed render links (when an API secret is provided).

- **Plugin ID**: `urlbox`
- **Category**: `screenshot`
- **Capabilities**: `screenshot`
- **Configuration Mode**: `hybrid`
- **Source**: `packages/plugins/urlbox/src/`

## Architecture

### Interface Implementation

```
IPlugin (lifecycle, manifest)
  └── IScreenshotPlugin (capture, URL generation, validation)
        └── UrlboxPlugin
```

### SDK Integration

The plugin uses the `urlbox` npm package which provides:

- `Urlbox(apiKey, apiSecret)` factory function for client creation
- `generateRenderLink(options)` for URL generation
- `RenderOptions` type for screenshot parameters

The Urlbox SDK generates render links (URLs) that, when fetched, trigger the screenshot capture on Urlbox's servers and return the image.

## Configuration

### Settings Schema

| Field               | Type      | Default | Description                                                                                            |
| ------------------- | --------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `apiKey`            | `string`  | -       | Urlbox API key (`x-secret`, `x-envVar: PLUGIN_URLBOX_API_KEY`, `x-scope: user`)                        |
| `apiSecret`         | `string`  | -       | API secret for signed render links (`x-secret`, `x-envVar: PLUGIN_URLBOX_API_SECRET`, `x-scope: user`) |
| `viewportWidth`     | `number`  | `1280`  | Default viewport width (320-3840 px)                                                                   |
| `viewportHeight`    | `number`  | `1024`  | Default viewport height (200-2160 px)                                                                  |
| `format`            | `string`  | `'png'` | Image format (png, jpg, jpeg, webp)                                                                    |
| `fullPage`          | `boolean` | `false` | Capture full page scroll height                                                                        |
| `quality`           | `number`  | `80`    | Image quality for lossy formats (1-100)                                                                |
| `retina`            | `boolean` | `false` | Enable 2x device scale factor                                                                          |
| `blockAds`          | `boolean` | `true`  | Block advertisements                                                                                   |
| `hideCookieBanners` | `boolean` | `true`  | Hide cookie consent banners                                                                            |

### Environment Variables

| Variable                   | Maps To     |
| -------------------------- | ----------- |
| `PLUGIN_URLBOX_API_KEY`    | `apiKey`    |
| `PLUGIN_URLBOX_API_SECRET` | `apiSecret` |

### Comparison with ScreenshotOne

| Feature              | Urlbox          | ScreenshotOne             |
| -------------------- | --------------- | ------------------------- |
| Default Viewport     | 1280x1024       | 1280x800                  |
| Quality Control      | Yes (1-100)     | No                        |
| Retina Mode          | Explicit toggle | Device scale factor (1-3) |
| Cookie Banner Hiding | Yes             | No (has tracker blocking) |
| Signed URLs          | Via API secret  | Via secret key            |
| SDK                  | `urlbox`        | `screenshotone-api-sdk`   |

## Capabilities

### Screenshot Capture

- **Direct Capture** - Generates render link, fetches image, returns buffer and base64
- **URL Generation** - Generates render links for deferred loading
- **Signed URLs** - Cryptographically signed when API secret is provided
- **Ad Blocking** - Removes ads before capture
- **Cookie Banner Hiding** - Hides cookie consent banners for cleaner screenshots
- **Retina Rendering** - 2x device scale factor for HiDPI displays
- **Quality Control** - Configurable quality for JPG/WebP (1-100)
- **Full Page** - Capture entire scrollable page height

### Supported Formats

| Format | Extension |
| ------ | --------- |
| PNG    | `.png`    |
| JPG    | `.jpg`    |
| JPEG   | `.jpeg`   |
| WebP   | `.webp`   |

### Maximum Dimensions

- **Width**: 3840 pixels
- **Height**: 2160 pixels

## API Reference

### Plugin Class

```typescript
class UrlboxPlugin implements IPlugin, IScreenshotPlugin {
	readonly id = 'urlbox';
	readonly name = 'Urlbox';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'screenshot';
	readonly capabilities = ['screenshot'];
	readonly providerName = 'Urlbox';

	async capture(options: ScreenshotOptions): Promise<ScreenshotResult>;
	async getScreenshotUrl(options: ScreenshotOptions): Promise<string | null>;
	async isAvailable(): Promise<boolean>;
	async validateCredentials(): Promise<ScreenshotValidationResult>;
	getSupportedFormats(): readonly ScreenshotFormat[];
	getMaxDimensions(): { width: number; height: number };

	async onLoad(context: PluginContext): Promise<void>;
	async onUnload(): Promise<void>;
	async healthCheck(): Promise<PluginHealthCheck>;
	getManifest(): PluginManifest;
}
```

## Implementation Details

### Client Creation

```typescript
private createClient(settings: UrlboxSettings) {
    const apiKey = settings.apiKey;
    const apiSecret = settings.apiSecret ?? '';

    if (!apiKey) {
        throw new Error(
            'Urlbox API key not configured. ' +
            'Set it in plugin settings or via PLUGIN_URLBOX_API_KEY environment variable.'
        );
    }

    return Urlbox(apiKey, apiSecret);
}
```

The `Urlbox()` factory accepts both the API key and an optional API secret. When the secret is provided, render links are cryptographically signed, preventing URL tampering.

### Render Option Building

The `buildOptions()` method maps `ScreenshotOptions` to Urlbox's `RenderOptions`:

```typescript
private buildOptions(options: ScreenshotOptions, settings: UrlboxSettings): RenderOptions {
    const renderOptions: RenderOptions = {
        url: options.url,
        width: options.viewportWidth ?? settings.viewportWidth ?? 1280,
        height: options.viewportHeight ?? settings.viewportHeight ?? 1024,
        format: format as RenderOptions['format'],
        full_page: options.fullPage ?? settings.fullPage ?? false,
        quality: settings.quality ?? 80,
        retina: settings.retina ?? false,
        block_ads: options.blockAds ?? settings.blockAds ?? true,
        hide_cookie_banners: options.blockCookieBanners ?? settings.hideCookieBanners ?? true
    };

    if (options.delay !== undefined) renderOptions.delay = options.delay;
    if (options.waitForSelector) renderOptions.selector = options.waitForSelector;
    if (options.userAgent) renderOptions.user_agent = options.userAgent;

    return renderOptions;
}
```

Note the mapping from the generic `ScreenshotOptions` property names to Urlbox's snake_case naming convention (`full_page`, `block_ads`, `hide_cookie_banners`, `user_agent`).

### Capture Flow

1. Merge per-request options with plugin settings
2. Create Urlbox client with API key and secret
3. Build `RenderOptions` from merged configuration
4. Generate render link via `client.generateRenderLink(options)`
5. Fetch the image from the render link URL
6. Verify response status (non-200 = failure)
7. Convert response to `ArrayBuffer` -> `Buffer` -> base64
8. Return `ScreenshotResult` with image data, dimensions, and file size

### URL Generation

The `getScreenshotUrl()` method generates a render link without actually fetching the image:

```typescript
async getScreenshotUrl(options: ScreenshotOptions): Promise<string | null> {
    const settings = this.mergeSettings(options.settings);
    const client = this.createClient(settings);
    const renderOptions = this.buildOptions(options, settings);
    return client.generateRenderLink(renderOptions);
}
```

This is useful when the screenshot URL will be stored and the image fetched later (e.g., by the browser or a CDN).

### Credential Validation

```typescript
async validateCredentials(): Promise<ScreenshotValidationResult> {
    const settings = await this.context.getSettings();
    const resolvedSettings = this.mergeSettings(settings);

    if (!resolvedSettings.apiKey) {
        return { valid: false, message: 'API key is not configured' };
    }

    const client = this.createClient(resolvedSettings);
    const url = client.generateRenderLink({ url: 'https://example.com' });

    if (url && url.includes('api.urlbox.com')) {
        return { valid: true, message: 'Credentials are valid' };
    }

    return { valid: false, message: 'Invalid credentials format' };
}
```

### Settings Merge

```typescript
private mergeSettings(settings?: PluginSettings): UrlboxSettings {
    return {
        apiKey: settings?.apiKey as string | undefined,
        apiSecret: settings?.apiSecret as string | undefined,
        viewportWidth: (settings?.viewportWidth as number | undefined) ?? 1280,
        viewportHeight: (settings?.viewportHeight as number | undefined) ?? 1024,
        format: (settings?.format as ScreenshotFormat | undefined) ?? 'png',
        fullPage: (settings?.fullPage as boolean | undefined) ?? false,
        quality: (settings?.quality as number | undefined) ?? 80,
        retina: (settings?.retina as boolean | undefined) ?? false,
        blockAds: (settings?.blockAds as boolean | undefined) ?? true,
        hideCookieBanners: (settings?.hideCookieBanners as boolean | undefined) ?? true
    };
}
```

## Usage Examples

### Used by Pipeline

The Urlbox plugin is invoked through the `ScreenshotFacade` during image capture steps:

```typescript
// ScreenshotFacade routes to Urlbox if it's the active screenshot provider
const result = await screenshotFacade.getSmartImage(item.sourceUrl, facadeOptions);
```

### Direct Capture

```typescript
const plugin = new UrlboxPlugin();
await plugin.onLoad(context);

const result = await plugin.capture({
	url: 'https://example.com',
	viewportWidth: 1440,
	viewportHeight: 900,
	format: 'webp',
	blockAds: true,
	settings: {
		apiKey: 'your-api-key',
		apiSecret: 'your-api-secret',
		quality: 90,
		retina: true,
		hideCookieBanners: true
	}
});

if (result.success) {
	console.log(`Captured: ${result.width}x${result.height}, ${result.fileSize} bytes`);
	// result.imageBase64 contains the base64-encoded image
	// result.imageUrl contains the render link
}
```

### Generate URL Only

```typescript
const url = await plugin.getScreenshotUrl({
	url: 'https://example.com',
	format: 'png',
	settings: { apiKey: 'key', apiSecret: 'secret' }
});
// Returns: https://api.urlbox.com/v1/...?url=https%3A%2F%2Fexample.com&...
```

## Error Handling

### Capture Errors

| Error                         | Cause            | Handling                                       |
| ----------------------------- | ---------------- | ---------------------------------------------- |
| `API key not configured`      | Missing `apiKey` | Throws error in `createClient()`               |
| `Render failed with status X` | Urlbox API error | Returns `{ success: false, error: '...' }`     |
| `Network error`               | API unreachable  | Caught, logged, returns failure result         |
| `URL generation failed`       | Invalid options  | Caught in `getScreenshotUrl()`, returns `null` |

### Graceful Failure

The `capture()` method wraps all operations in try/catch:

```typescript
async capture(options: ScreenshotOptions): Promise<ScreenshotResult> {
    try {
        // ... capture logic ...
    } catch (error) {
        this.context?.logger.error(`Urlbox capture failed: ${errorMessage}`);
        return { success: false, error: errorMessage };
    }
}
```

This ensures screenshot failures never crash the pipeline. Items simply remain without preview images.

### Health Check

```typescript
async healthCheck(): Promise<PluginHealthCheck> {
    return {
        status: 'healthy',
        message: 'Urlbox plugin is ready (API key required for operations)',
        checkedAt: Date.now()
    };
}
```

The health check returns healthy regardless of API key configuration, since the plugin itself is properly loaded. Actual API key validation happens through `validateCredentials()`.

## Related Plugins

- **[ScreenshotOne](./screenshotone-deep-dive.md)** - Alternative screenshot provider
- **[Standard Pipeline](./standard-pipeline-deep-dive.md)** - Uses ScreenshotFacade in the `image-capture` step
- **[Agent Pipeline](./agent-pipeline-deep-dive.md)** - Uses ScreenshotFacade in the `capture-screenshots` step
- **[Claude Code](./claude-code-deep-dive.md)** - Uses ScreenshotFacade in the `capture-screenshots` step

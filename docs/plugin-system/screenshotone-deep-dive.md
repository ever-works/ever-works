---
id: screenshotone-deep-dive
title: ScreenshotOne Plugin Deep Dive
sidebar_label: ScreenshotOne
sidebar_position: 69
---

# ScreenshotOne Plugin Deep Dive

## Overview

The ScreenshotOne plugin (`@ever-works/plugins/screenshotone`) is a screenshot capture plugin that uses the ScreenshotOne API to generate website screenshots for directory items. When directory items include source URLs, this plugin automatically captures preview images that serve as item thumbnails.

The plugin implements the `IScreenshotPlugin` interface, providing screenshot capture, URL generation, credential validation, and format/dimension queries. It uses the official `screenshotone-api-sdk` for API communication and supports signed URLs for secure access.

- **Plugin ID**: `screenshotone`
- **Category**: `screenshot`
- **Capabilities**: `screenshot`
- **Configuration Mode**: `hybrid`
- **Source**: `packages/plugins/screenshotone/src/`

## Architecture

### Interface Implementation

```
IPlugin (lifecycle, manifest)
  └── IScreenshotPlugin (capture, URL generation, validation)
        └── ScreenshotOnePlugin
```

The `IScreenshotPlugin` interface requires:

- `capture(options)` - Capture a screenshot and return image data
- `getScreenshotUrl(options)` - Generate a screenshot URL without capturing
- `isAvailable()` - Check if the plugin is ready
- `validateCredentials()` - Verify API credentials
- `getSupportedFormats()` - List supported image formats
- `getMaxDimensions()` - Report maximum capture dimensions

### SDK Integration

The plugin uses the official `screenshotone-api-sdk` which provides:

- `Client` class for API communication
- `TakeOptions` builder for screenshot parameters
- Signed URL generation for secure, time-limited access

## Configuration

### Settings Schema

| Field               | Type      | Default | Description                                                                                                         |
| ------------------- | --------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `accessKey`         | `string`  | -       | ScreenshotOne access key (`x-secret`, `x-envVar: PLUGIN_SCREENSHOTONE_ACCESS_KEY`, `x-scope: user`)                 |
| `secretKey`         | `string`  | -       | ScreenshotOne secret key for signed URLs (`x-secret`, `x-envVar: PLUGIN_SCREENSHOTONE_SECRET_KEY`, `x-scope: user`) |
| `viewportWidth`     | `number`  | `1280`  | Default viewport width (320-3840 px)                                                                                |
| `viewportHeight`    | `number`  | `800`   | Default viewport height (200-2160 px)                                                                               |
| `format`            | `string`  | `'png'` | Image format (png, jpg, jpeg, webp)                                                                                 |
| `fullPage`          | `boolean` | `false` | Capture full page scroll height                                                                                     |
| `deviceScaleFactor` | `number`  | `1`     | Device pixel ratio (1-3)                                                                                            |
| `blockAds`          | `boolean` | `true`  | Block advertisements                                                                                                |
| `blockTrackers`     | `boolean` | `true`  | Block tracking scripts                                                                                              |

### Environment Variables

| Variable                          | Maps To     |
| --------------------------------- | ----------- |
| `PLUGIN_SCREENSHOTONE_ACCESS_KEY` | `accessKey` |
| `PLUGIN_SCREENSHOTONE_SECRET_KEY` | `secretKey` |

## Capabilities

### Screenshot Capture

- **Direct Capture** - Downloads screenshot image as a buffer with base64 encoding
- **URL Generation** - Generates signed screenshot URLs for deferred or client-side loading
- **Signed URLs** - When `secretKey` is provided, generates cryptographically signed URLs for security
- **Ad Blocking** - Blocks ads before capture for clean screenshots
- **Tracker Blocking** - Blocks tracking scripts for privacy
- **Device Scale Factor** - Supports 1x, 2x, 3x for retina/HiDPI screenshots
- **Full Page** - Captures entire scrollable page, not just the viewport

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
class ScreenshotOnePlugin implements IPlugin, IScreenshotPlugin {
	readonly id = 'screenshotone';
	readonly name = 'ScreenshotOne';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'screenshot';
	readonly capabilities = ['screenshot'];
	readonly providerName = 'ScreenshotOne';

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

### ScreenshotOptions

```typescript
interface ScreenshotOptions {
	url: string;
	viewportWidth?: number;
	viewportHeight?: number;
	format?: ScreenshotFormat;
	fullPage?: boolean;
	delay?: number;
	waitForSelector?: string;
	userAgent?: string;
	blockAds?: boolean;
	blockCookieBanners?: boolean;
	settings?: PluginSettings;
}
```

### ScreenshotResult

```typescript
// Success
interface ScreenshotResult {
	success: true;
	imageBuffer: Buffer;
	imageBase64: string;
	imageUrl: string;
	width: number;
	height: number;
	fileSize: number;
}

// Failure
interface ScreenshotResult {
	success: false;
	error: string;
}
```

## Implementation Details

### Client Creation

The plugin creates a ScreenshotOne SDK client from settings:

```typescript
private createClient(settings: ScreenshotOneSettings) {
    if (!settings.accessKey) {
        throw new Error('ScreenshotOne access key not configured.');
    }
    return new Client(settings.accessKey, settings.secretKey);
}
```

When a `secretKey` is provided, the client generates signed URLs. Without it, unsigned URLs are used (less secure but still functional).

### Screenshot Option Building

The `buildOptions()` method maps `ScreenshotOptions` to the SDK's `TakeOptions`:

```typescript
private buildOptions(options: ScreenshotOptions, settings: ScreenshotOneSettings) {
    const takeOptions = TakeOptions.url(options.url)
        .viewportWidth(options.viewportWidth ?? settings.viewportWidth ?? 1280)
        .viewportHeight(options.viewportHeight ?? settings.viewportHeight ?? 800)
        .format(format)
        .fullPage(options.fullPage ?? settings.fullPage ?? false)
        .deviceScaleFactor(settings.deviceScaleFactor ?? 1)
        .blockAds(options.blockAds ?? settings.blockAds ?? true)
        .blockTrackers(settings.blockTrackers ?? true);

    // Optional parameters
    if (options.delay) takeOptions.delay(options.delay);
    if (options.waitForSelector) takeOptions.selector(options.waitForSelector);
    if (options.userAgent) takeOptions.userAgent(options.userAgent);

    return takeOptions;
}
```

### Capture Flow

1. Merge per-request options with plugin settings
2. Create SDK client with access key (and optional secret key)
3. Build `TakeOptions` from merged configuration
4. Generate the screenshot URL via the client
5. Fetch the image from the URL
6. Convert response to Buffer and base64
7. Return `ScreenshotResult` with image data and metadata

### Credential Validation

The `validateCredentials()` method:

1. Retrieves settings from the plugin context
2. Checks that `accessKey` is configured
3. Creates a client and generates a test URL for `https://example.com`
4. Verifies the URL contains `api.screenshotone.com`
5. Returns validation result with success/failure message

### Settings Merge

The `mergeSettings()` method combines per-request settings with defaults:

```typescript
private mergeSettings(settings?: PluginSettings): ScreenshotOneSettings {
    return {
        accessKey: settings?.accessKey as string | undefined,
        secretKey: settings?.secretKey as string | undefined,
        viewportWidth: (settings?.viewportWidth as number) ?? 1280,
        viewportHeight: (settings?.viewportHeight as number) ?? 800,
        format: (settings?.format as ScreenshotFormat) ?? 'png',
        fullPage: (settings?.fullPage as boolean) ?? false,
        deviceScaleFactor: (settings?.deviceScaleFactor as number) ?? 1,
        blockAds: (settings?.blockAds as boolean) ?? true,
        blockTrackers: (settings?.blockTrackers as boolean) ?? true
    };
}
```

## Usage Examples

### Used by Pipeline

The screenshot plugin is typically invoked through the `ScreenshotFacade` during the `image-capture` step:

```typescript
// In the image-capture step:
const result = await screenshotFacade.getSmartImage(item.sourceUrl, facadeOptions);
// Returns the screenshot URL or base64 data
```

### Direct Capture

```typescript
const plugin = new ScreenshotOnePlugin();
await plugin.onLoad(context);

const result = await plugin.capture({
	url: 'https://example.com',
	viewportWidth: 1440,
	viewportHeight: 900,
	format: 'webp',
	blockAds: true,
	settings: { accessKey: 'key', secretKey: 'secret' }
});

if (result.success) {
	console.log(`Image size: ${result.fileSize} bytes`);
	console.log(`Dimensions: ${result.width}x${result.height}`);
}
```

### URL Generation Only

```typescript
const url = await plugin.getScreenshotUrl({
	url: 'https://example.com',
	format: 'png',
	settings: { accessKey: 'key', secretKey: 'secret' }
});
// Returns signed URL like: https://api.screenshotone.com/take?...&signature=...
```

## Error Handling

### Capture Errors

| Error                         | Cause                | Handling                                   |
| ----------------------------- | -------------------- | ------------------------------------------ |
| `Access key not configured`   | Missing `accessKey`  | Returns `{ success: false, error: '...' }` |
| `Render failed with status X` | API returned error   | Logs error, returns failure result         |
| `Network error`               | API unreachable      | Caught, logged, returns failure result     |
| `Invalid URL`                 | Malformed target URL | API returns error status                   |

### Graceful Failure

All errors in `capture()` are caught and returned as `{ success: false, error: message }` rather than throwing exceptions. This prevents screenshot failures from crashing the pipeline -- items simply remain without preview images.

### Health Check

Returns healthy status with message indicating the plugin is ready but API key is required for operations:

```typescript
async healthCheck(): Promise<PluginHealthCheck> {
    return {
        status: 'healthy',
        message: 'ScreenshotOne plugin is ready (API key required for operations)',
        checkedAt: Date.now()
    };
}
```

## Related Plugins

- **[Urlbox](./urlbox-deep-dive.md)** - Alternative screenshot provider with similar capabilities
- **[Standard Pipeline](./standard-pipeline-deep-dive.md)** - Uses ScreenshotFacade in the `image-capture` step
- **[Agent Pipeline](./agent-pipeline-deep-dive.md)** - Uses ScreenshotFacade in the `capture-screenshots` step
- **[Claude Code](./claude-code-deep-dive.md)** - Uses ScreenshotFacade in the `capture-screenshots` step

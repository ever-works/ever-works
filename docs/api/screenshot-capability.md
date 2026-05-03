---
id: screenshot-capability
title: Screenshot Capability
sidebar_label: Screenshot Capability
sidebar_position: 15
---

# Screenshot Capability

The Screenshot capability provides webpage screenshot capture through the plugin system. It exposes REST API endpoints for capturing screenshots of any URL, with support for multiple screenshot providers (ScreenshotOne, Urlbox, etc.).

Source: `apps/api/src/plugins-capabilities/screenshot/`

## Architecture

```
ScreenshotModule
  ├── ScreenshotController       -- REST API endpoints
  ├── ScreenshotFacadeService    -- Plugin resolution (from @ever-works/agent)
  └── AuthModule                 -- JWT authentication
```

The controller delegates all screenshot operations to the `ScreenshotFacadeService` from the agent package, which resolves the active screenshot plugin and routes requests accordingly.

## Module Definition

```typescript
@Module({
	imports: [FacadesModule, AuthModule],
	controllers: [ScreenshotController]
})
export class ScreenshotModule {}
```

The module imports `FacadesModule` to access the `ScreenshotFacadeService` and `AuthModule` for JWT authentication. No additional providers are needed since the facade handles plugin resolution.

## API Endpoints

All endpoints are under the `/api/screenshot` prefix and require JWT authentication.

### Check Availability

```
GET /api/screenshot/check-availability
Authorization: Bearer <jwt-token>
```

Returns whether any screenshot provider is configured and lists available providers.

**Response:**

```json
{
	"status": "success",
	"available": true,
	"providers": ["screenshotone", "urlbox"]
}
```

### Capture Screenshot

```
POST /api/screenshot/capture
Authorization: Bearer <jwt-token>
Content-Type: application/json
```

Captures a screenshot of the specified URL and returns the result.

**Request Body (CaptureScreenshotDto):**

| Field                | Type      | Required | Validation           | Description                  |
| -------------------- | --------- | -------- | -------------------- | ---------------------------- |
| `url`                | `string`  | Yes      | Valid URL            | URL to capture               |
| `viewportWidth`      | `number`  | No       | 320-3840             | Viewport width in pixels     |
| `viewportHeight`     | `number`  | No       | 240-2160             | Viewport height in pixels    |
| `format`             | `string`  | No       | `png`, `jpg`, `webp` | Output image format          |
| `fullPage`           | `boolean` | No       | --                   | Capture full scrollable page |
| `delay`              | `number`  | No       | 0-10000              | Delay in ms before capture   |
| `blockAds`           | `boolean` | No       | --                   | Block advertisements         |
| `blockTrackers`      | `boolean` | No       | --                   | Block tracking scripts       |
| `blockCookieBanners` | `boolean` | No       | --                   | Block cookie consent banners |

**Example Request:**

```json
{
	"url": "https://example.com",
	"viewportWidth": 1280,
	"viewportHeight": 720,
	"format": "png",
	"fullPage": false,
	"delay": 1000,
	"blockAds": true,
	"blockCookieBanners": true
}
```

**Success Response:**

```json
{
	"status": "success",
	"imageUrl": "https://cdn.screenshotone.com/...",
	"cacheUrl": "https://cdn.screenshotone.com/...",
	"imageBase64": "iVBORw0KGgoAAAANSUhEUg..."
}
```

**Error Response (400):**

```json
{
	"status": "error",
	"message": "No screenshot provider configured"
}
```

### Get Screenshot URL

```
POST /api/screenshot/get-url
Authorization: Bearer <jwt-token>
Content-Type: application/json
```

Generates a signed screenshot URL without performing the capture immediately. Uses the same `GetScreenshotUrlDto` (which extends `CaptureScreenshotDto`).

**Success Response:**

```json
{
	"status": "success",
	"imageUrl": "https://api.screenshotone.com/take?url=..."
}
```

## DTO Validation

The `CaptureScreenshotDto` uses `class-validator` decorators for input validation:

```typescript
export class CaptureScreenshotDto {
	@IsUrl()
	url: string;

	@IsOptional()
	@IsNumber()
	@Min(320)
	@Max(3840)
	viewportWidth?: number;

	@IsOptional()
	@IsNumber()
	@Min(240)
	@Max(2160)
	viewportHeight?: number;

	@IsOptional()
	@IsIn(['png', 'jpg', 'webp'])
	format?: 'png' | 'jpg' | 'webp';

	@IsOptional()
	@IsBoolean()
	fullPage?: boolean;

	@IsOptional()
	@IsNumber()
	@Min(0)
	@Max(10000)
	delay?: number;

	@IsOptional()
	@IsBoolean()
	blockAds?: boolean;

	@IsOptional()
	@IsBoolean()
	blockTrackers?: boolean;

	@IsOptional()
	@IsBoolean()
	blockCookieBanners?: boolean;
}
```

`GetScreenshotUrlDto` directly extends `CaptureScreenshotDto` with no additional fields.

## Provider Integration

The controller uses `ScreenshotFacadeService` to interact with the plugin system:

```typescript
// Check if any provider is available
this.screenshotFacade.isAvailable();

// Get list of providers with their status
this.screenshotFacade.getAvailableProviders();
// Returns: [{ name: 'screenshotone', enabled: true }, ...]

// Capture a screenshot
const result = await this.screenshotFacade.capture(options, { userId });

// Generate a signed URL
const url = await this.screenshotFacade.getScreenshotUrl(options, { userId });
```

### Supported Providers

| Plugin ID       | Provider      | Configuration                                                        |
| --------------- | ------------- | -------------------------------------------------------------------- |
| `screenshotone` | ScreenshotOne | `PLUGIN_SCREENSHOTONE_ACCESS_KEY`, `PLUGIN_SCREENSHOTONE_SECRET_KEY` |
| `urlbox`        | Urlbox        | `PLUGIN_URLBOX_API_KEY`, `PLUGIN_URLBOX_API_SECRET`                  |

### Capture Result

The facade returns a result object with:

```typescript
interface CaptureResult {
	success: boolean;
	imageUrl?: string; // Direct image URL
	cacheUrl?: string; // Cached/CDN URL (preferred)
	imageBuffer?: Buffer; // Raw image data
	error?: string; // Error message if failed
}
```

The controller prioritizes `cacheUrl` over `imageUrl` when both are available, and converts `imageBuffer` to base64 for inline embedding.

## Error Handling

The controller throws `BadRequestException` in two scenarios:

1. **No provider configured**: When `screenshotFacade.isAvailable()` returns `false`
2. **Capture failed**: When the provider returns `success: false`

Both cases return a structured error response:

```json
{
	"status": "error",
	"message": "descriptive error message"
}
```

## Usage in the Platform

Screenshots are used for:

- **Work item previews**: Generating preview images for URLs added to works
- **Smart image generation**: Creating visual thumbnails for work websites
- **OG image creation**: Generating Open Graph images for social media sharing

## Source Files

| File                                                                    | Purpose                 |
| ----------------------------------------------------------------------- | ----------------------- |
| `apps/api/src/plugins-capabilities/screenshot/screenshot.module.ts`     | Module definition       |
| `apps/api/src/plugins-capabilities/screenshot/screenshot.controller.ts` | REST API controller     |
| `apps/api/src/plugins-capabilities/screenshot/dto/screenshot.dto.ts`    | Request validation DTOs |

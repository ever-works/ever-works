# Screenshot Facade Service Design Document

> **Status:** Design complete. Implementation blocked on Story 2 (Plugin Runtime).
>
> This document captures the facade design for screenshot capture operations.

---

## Overview

The ScreenshotFacade abstracts screenshot operations (ScreenshotOne, Playwright, Browserless, etc.) behind the plugin system. It follows the generic facade pattern documented in [facade-architecture.md](./facade-architecture.md).

---

## Provider Resolution

Screenshot provider selection follows the three-level configuration model:

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. USER LEVEL (Settings > Plugins)                                  │
│    - Install screenshot plugins (ScreenshotOne, Playwright, etc.)   │
│    - Configure API keys                                             │
│    - Stored in: UserPlugin.settings.accessKey/secretKey             │
├─────────────────────────────────────────────────────────────────────┤
│ 2. DIRECTORY LEVEL (Directory > Apps)                               │
│    - Select DEFAULT screenshot provider for this directory          │
│    - Override settings (viewport, block ads, etc.)                  │
│    - Stored in: DirectoryPlugin.settings.defaults['screenshot']     │
├─────────────────────────────────────────────────────────────────────┤
│ 3. GENERATION LEVEL (Generator Form)                                │
│    - Override provider for THIS generation only                     │
│    - Configure generation-specific options                          │
│    - Passed via: GenerationOptions.providers.screenshot             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Database Model (Plugin System)

### Token Storage: UserPlugin

```typescript
// UserPlugin for ScreenshotOne
{
    userId: 'user-123',
    pluginId: 'screenshotone',
    settings: {
        accessKey: 'so_xxxx...',     // Encrypted (secret: true)
        secretKey: 'so_secret...',   // Encrypted (secret: true)
        defaultViewport: {
            width: 1280,
            height: 800
        },
        cacheEnabled: true
    },
    enabled: true
}
```

### Provider Selection: DirectoryPlugin

```typescript
// DirectoryPlugin for screenshot
{
    directoryId: 'dir-456',
    pluginId: 'screenshotone',
    settings: {
        defaults: {
            'screenshot': 'screenshotone'
        },
        // Directory-specific overrides
        viewport: { width: 1920, height: 1080 },  // Override user default
        blockAds: true,
        fullPage: false
    },
    enabled: true
}
```

### Migration from Hardcoded Fields

| Current (Hardcoded)           | After (Plugin System)                             |
| ----------------------------- | ------------------------------------------------- |
| `User.screenshotoneAccessKey` | `UserPlugin.settings.accessKey` (screenshotone)   |
| `User.screenshotoneSecretKey` | `UserPlugin.settings.secretKey` (screenshotone)   |
| N/A (hardcoded ScreenshotOne) | `DirectoryPlugin.settings.defaults['screenshot']` |

---

## ScreenshotFacade Implementation

### Location

`packages/agent/src/facades/screenshot.facade.ts`

### Interface Design

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { IScreenshotPlugin, ScreenshotOptions, Screenshot, BulkScreenshotRequest } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { PluginSettingsService } from '../plugins/plugin-settings.service';

@Injectable()
export class ScreenshotFacade {
	private readonly logger = new Logger(ScreenshotFacade.name);

	constructor(
		private readonly registry: PluginRegistryService,
		private readonly settingsService: PluginSettingsService
	) {}

	// ========================================
	// PLUGIN RESOLUTION (Private)
	// ========================================

	private async getPlugin(directoryId: string, providerOverride?: string): Promise<IScreenshotPlugin> {
		const providerId =
			providerOverride ??
			(await this.settingsService.getDirectoryProvider(directoryId, 'screenshot')) ??
			(await this.settingsService.getPlatformDefault('screenshot'));

		if (!providerId) {
			throw new ScreenshotProviderNotFoundError('No screenshot provider configured');
		}

		const plugin = this.registry.getByCapability<IScreenshotPlugin>('screenshot', providerId);

		if (!plugin) {
			throw new ScreenshotProviderNotFoundError(providerId);
		}

		return plugin;
	}

	private async getSettings(userId: string, directoryId: string, pluginId: string): Promise<Record<string, unknown>> {
		return this.settingsService.resolveSettings(userId, directoryId, pluginId);
	}

	// ========================================
	// SCREENSHOT OPERATIONS
	// ========================================

	/**
	 * Capture a single screenshot.
	 */
	async capture(
		url: string,
		options: ScreenshotOptions,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<Screenshot> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const settings = await this.getSettings(userId, directoryId, plugin.id);

		// Merge options with resolved settings
		const mergedOptions: ScreenshotOptions = {
			...(settings.defaultViewport && { viewport: settings.defaultViewport }),
			...(settings.blockAds !== undefined && { blockAds: settings.blockAds }),
			...options // Request options override defaults
		};

		return plugin.capture(url, mergedOptions, settings);
	}

	/**
	 * Capture multiple screenshots in bulk.
	 */
	async bulkCapture(
		requests: BulkScreenshotRequest[],
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<Screenshot[]> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const settings = await this.getSettings(userId, directoryId, plugin.id);

		return plugin.bulkCapture(requests, settings);
	}

	/**
	 * Check if a cached screenshot exists.
	 */
	async getCached(
		url: string,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<Screenshot | null> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const settings = await this.getSettings(userId, directoryId, plugin.id);

		if (!plugin.getCached) {
			return null;
		}

		return plugin.getCached(url, settings);
	}

	/**
	 * Get the signed URL for a screenshot (if supported).
	 */
	async getSignedUrl(
		url: string,
		options: ScreenshotOptions,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<string> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const settings = await this.getSettings(userId, directoryId, plugin.id);

		if (!plugin.getSignedUrl) {
			throw new ScreenshotOperationNotSupportedError(plugin.id, 'getSignedUrl');
		}

		return plugin.getSignedUrl(url, options, settings);
	}
}
```

---

## Error Types

```typescript
// packages/agent/src/facades/errors/screenshot-facade.errors.ts

export class ScreenshotFacadeError extends Error {
	constructor(
		message: string,
		public readonly operation: string,
		public readonly provider?: string,
		public readonly cause?: Error
	) {
		super(message);
		this.name = 'ScreenshotFacadeError';
	}
}

export class ScreenshotProviderNotFoundError extends ScreenshotFacadeError {
	constructor(providerId: string) {
		super(`Screenshot provider not found: ${providerId}`, 'getPlugin', providerId);
		this.name = 'ScreenshotProviderNotFoundError';
	}
}

export class ScreenshotSettingsMissingError extends ScreenshotFacadeError {
	constructor(providerId: string) {
		super(
			`No ${providerId} credentials found. Please configure your ${providerId} API keys.`,
			'getSettings',
			providerId
		);
		this.name = 'ScreenshotSettingsMissingError';
	}
}

export class ScreenshotOperationNotSupportedError extends ScreenshotFacadeError {
	constructor(providerId: string, operation: string) {
		super(`Operation '${operation}' not supported by ${providerId}`, operation, providerId);
		this.name = 'ScreenshotOperationNotSupportedError';
	}
}
```

---

## Migration Pattern

```typescript
// BEFORE - Hardcoded ScreenshotOne
constructor(private readonly screenshotOneService: ScreenshotOneService) {}

async captureScreenshot(url: string, user: User) {
    const accessKey = user.screenshotoneAccessKey;  // ❌ From User entity
    const secretKey = user.screenshotoneSecretKey;  // ❌ From User entity
    return this.screenshotOneService.capture(url, accessKey, secretKey);
}
```

```typescript
// AFTER - Plugin system with facade
constructor(private readonly screenshotFacade: ScreenshotFacade) {}

async captureScreenshot(url: string, directory: Directory, user: User) {
    return this.screenshotFacade.capture(
        url,
        { viewport: { width: 1280, height: 800 } },
        directory.id,  // Facade reads DirectoryPlugin for provider
        user.id,       // Facade reads UserPlugin for credentials
    );
}
```

---

## Integration with SmartImageRouter

The existing `SmartImageRouter` will be updated to use the facade:

```typescript
// packages/agent/src/smart-image-router/smart-image-router.service.ts

@Injectable()
export class SmartImageRouter {
	constructor(
		private readonly screenshotFacade: ScreenshotFacade
		// ... other dependencies
	) {}

	async getImage(item: DirectoryItem, directory: Directory, user: User): Promise<string> {
		// ... domain type detection logic ...

		if (needsScreenshot) {
			const screenshot = await this.screenshotFacade.capture(
				item.url,
				{ fullPage: false, blockAds: true },
				directory.id,
				user.id
			);
			return screenshot.url;
		}

		// ... other image sources ...
	}
}
```

---

## Related Documentation

- [facade-architecture.md](./facade-architecture.md)
- [PLUGIN_SYSTEM_RFC.md - Migration from Hardcoded Infrastructure](../PLUGIN_SYSTEM_RFC.md#migration-from-hardcoded-infrastructure)

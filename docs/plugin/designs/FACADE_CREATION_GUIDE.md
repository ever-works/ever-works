# Facade Creation Guide

This guide explains how to create capability facades in the Ever Works platform. Facades provide a unified interface for pipeline steps to access plugin capabilities with proper enable resolution and settings management.

## Overview

Facades are thin service wrappers that abstract plugin interactions from the rest of the application. They handle:

1. **Provider Resolution** - Determining which plugin to use
2. **Enable Resolution** - Three-level configuration (Directory > User > Generation)
3. **Settings Resolution** - 4-level hierarchy (Directory > User > Admin > Plugin)
4. **Default Provider Resolution** - Using `activeCapability` to mark defaults
5. **Error Handling** - Uniform error handling across capabilities

## Architecture

### Three-Level Enable Configuration

```
isPluginEnabled(pluginId, directoryId, userId)
    │
    ├─ 1. Check DirectoryPlugin.enabled (Level 2)
    │     └─ If DirectoryPluginEntity exists for (directoryId, pluginId):
    │           return directoryPlugin.enabled
    │
    ├─ 2. Check UserPlugin.enabled (Level 1)
    │     └─ If UserPluginEntity exists for (userId, pluginId):
    │           return userPlugin.enabled
    │
    ├─ 3. Check manifest.autoEnable
    │     └─ If manifest.autoEnable is true:
    │           return true
    │
    └─ 4. Default to enabled (plugin is in registry with state=enabled)
```

### Settings Resolution (4-Level Hierarchy)

Settings are resolved from lowest to highest priority:

1. Plugin defaults (hardcoded in plugin)
2. Admin settings (platform-wide)
3. User settings (per-user configuration)
4. Directory settings (directory-specific overrides)

## Creating a New Facade

### Step 1: Define Error Classes

Create error classes specific to your capability:

```typescript
// my-capability.facade.ts

export class MyCapabilityFacadeError extends Error {
	constructor(
		message: string,
		public readonly operation: string,
		public readonly provider?: string,
		public readonly cause?: Error
	) {
		super(message);
		this.name = 'MyCapabilityFacadeError';
	}
}

export class NoMyCapabilityProviderError extends MyCapabilityFacadeError {
	constructor() {
		super('No my-capability provider configured or available', 'getPlugin');
		this.name = 'NoMyCapabilityProviderError';
	}
}

export class MyCapabilityProviderNotFoundError extends MyCapabilityFacadeError {
	constructor(providerId: string) {
		super(`My-capability provider not found: ${providerId}`, 'getPlugin', providerId);
		this.name = 'MyCapabilityProviderNotFoundError';
	}
}
```

### Step 2: Define Facade Options Interface

Extend `BaseFacadeOptions` for your facade:

```typescript
import { BaseFacadeOptions } from './base.facade';

export interface MyCapabilityFacadeOptions extends BaseFacadeOptions {
	// Add any capability-specific options
	customOption?: string;
}
```

### Step 3: Create the Facade Class

Extend `BaseFacadeService`:

```typescript
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { IMyCapabilityPlugin } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { DirectoryPluginRepository } from '../plugins/repositories/directory-plugin.repository';
import { UserPluginRepository } from '../plugins/repositories/user-plugin.repository';
import { BaseFacadeService } from './base.facade';

@Injectable()
export class MyCapabilityFacadeService extends BaseFacadeService {
	protected readonly logger = new Logger(MyCapabilityFacadeService.name);
	protected readonly CAPABILITY = 'my-capability';

	constructor(
		registry: PluginRegistryService,
		settingsService: PluginSettingsService,
		@Optional() directoryPluginRepository?: DirectoryPluginRepository,
		@Optional() userPluginRepository?: UserPluginRepository
	) {
		super(registry, settingsService, directoryPluginRepository, userPluginRepository);
	}

	/**
	 * Main capability method.
	 */
	async doSomething(input: SomeInput, options?: MyCapabilityFacadeOptions): Promise<SomeResult> {
		const plugin = await this.resolvePlugin(options?.providerOverride, options?.userId, options?.directoryId);

		const settings = await this.getResolvedSettings(plugin.id, options);

		return plugin.doSomething({
			...input,
			settings
		});
	}

	/**
	 * Resolve which plugin to use.
	 */
	private async resolvePlugin(
		providerOverride?: string,
		userId?: string,
		directoryId?: string
	): Promise<IMyCapabilityPlugin> {
		// 1. Explicit override
		if (providerOverride) {
			const registered = this.registry.get(providerOverride);
			if (
				registered &&
				registered.manifest.capabilities.includes(this.CAPABILITY) &&
				registered.state === 'enabled'
			) {
				const isEnabled = await this.isPluginEnabled(providerOverride, directoryId, userId);
				if (isEnabled) {
					return registered.plugin as IMyCapabilityPlugin;
				}
			}
			throw new MyCapabilityProviderNotFoundError(providerOverride);
		}

		// 2. Check for directory default via activeCapability
		const activePlugin = directoryId ? await this.findActivePluginForDirectory(directoryId) : null;

		if (activePlugin) {
			return activePlugin.plugin as IMyCapabilityPlugin;
		}

		// 3. Fall back to first enabled plugin that passes enable check
		const enabledPlugins = await this.getEnabledPlugins(directoryId, userId);
		if (enabledPlugins.length > 0) {
			return enabledPlugins[0].plugin as IMyCapabilityPlugin;
		}

		throw new NoMyCapabilityProviderError();
	}
}
```

### Step 4: Register in FacadesModule

Add your facade to `facades.module.ts`:

```typescript
// facades.module.ts
import { Module } from '@nestjs/common';
import { PluginsModule } from '../plugins/plugins.module';
import { MyCapabilityFacadeService } from './my-capability.facade';

const FACADES = [
	// ... existing facades
	MyCapabilityFacadeService
];

@Module({
	imports: [PluginsModule],
	providers: FACADES,
	exports: FACADES
})
export class FacadesModule {}
```

### Step 5: Export from Index

Add exports to `index.ts`:

```typescript
export {
	MyCapabilityFacadeService,
	MyCapabilityFacadeError,
	NoMyCapabilityProviderError,
	MyCapabilityProviderNotFoundError,
	type MyCapabilityFacadeOptions
} from './my-capability.facade';
```

## Base Class Methods

The `BaseFacadeService` provides these methods:

| Method                                             | Description                                        |
| -------------------------------------------------- | -------------------------------------------------- |
| `isConfigured()`                                   | Check if any provider is available                 |
| `getAvailableProviders()`                          | Get all available providers (id, name, enabled)    |
| `getDefaultProvider(directoryId?, userId?)`        | Get the default provider based on activeCapability |
| `isPluginEnabled(pluginId, directoryId?, userId?)` | Check if plugin is enabled (3-level resolution)    |
| `getResolvedSettings(pluginId, options?)`          | Get settings with 4-level hierarchy                |
| `getProviderName(plugin)`                          | Get display name for a plugin                      |
| `findActivePluginForDirectory(directoryId)`        | Find plugin marked as default for directory        |
| `getEnabledPlugins(directoryId?, userId?)`         | Get all enabled plugins after enable check         |

## Default Provider Resolution

### Plugin-Level Defaults (defaultForCapabilities)

Plugins can declare which capabilities they should be the default provider for using the `defaultForCapabilities` manifest property:

```typescript
// In plugin's getManifest()
getManifest(): PluginManifest {
    return {
        id: 'tavily',
        capabilities: ['search', 'content-extractor'],
        defaultForCapabilities: ['search'], // Only default for search, not content-extractor
        // ...
    };
}
```

Use `registry.getDefaultForCapability(capability)` to resolve the default:

```typescript
// Get platform-wide default for a capability
const defaultExtractor = registry.getDefaultForCapability('content-extractor');
```

### Directory-Level Defaults (activeCapability)

The `DirectoryPluginEntity.activeCapability` field marks which plugin is the default for a capability in a specific directory:

```typescript
// Set default provider for a directory
await directoryPluginRepository.setAsActiveForCapability(directoryId, pluginId, 'my-capability');

// Get default provider in facade
const defaultProvider = await facade.getDefaultProvider(directoryId, userId);
// Returns: { id: 'plugin-id', name: 'Plugin Name' } | null
```

### Resolution Priority

1. Provider override (explicit request)
2. Directory-level activeCapability
3. Plugin-level defaultForCapabilities
4. First enabled plugin with the capability

## Testing Facades

Create tests in `__tests__/my-capability.facade.spec.ts`:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { MyCapabilityFacadeService } from '../my-capability.facade';
import { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { DirectoryPluginRepository } from '../../plugins/repositories/directory-plugin.repository';
import { UserPluginRepository } from '../../plugins/repositories/user-plugin.repository';

describe('MyCapabilityFacadeService', () => {
	let service: MyCapabilityFacadeService;
	let registry: jest.Mocked<PluginRegistryService>;
	let settingsService: jest.Mocked<PluginSettingsService>;
	let directoryPluginRepository: jest.Mocked<DirectoryPluginRepository>;
	let userPluginRepository: jest.Mocked<UserPluginRepository>;

	beforeEach(async () => {
		const module: TestingModule = await Test.createTestingModule({
			providers: [
				MyCapabilityFacadeService,
				{
					provide: PluginRegistryService,
					useValue: {
						get: jest.fn(),
						getByCapability: jest.fn().mockReturnValue([])
					}
				},
				{
					provide: PluginSettingsService,
					useValue: {
						getSettings: jest.fn().mockResolvedValue({})
					}
				},
				{
					provide: DirectoryPluginRepository,
					useValue: {
						findByDirectoryAndPlugin: jest.fn().mockResolvedValue(null),
						findActiveByCapability: jest.fn().mockResolvedValue(null)
					}
				},
				{
					provide: UserPluginRepository,
					useValue: {
						findByUserAndPlugin: jest.fn().mockResolvedValue(null)
					}
				}
			]
		}).compile();

		service = module.get(MyCapabilityFacadeService);
		registry = module.get(PluginRegistryService);
		settingsService = module.get(PluginSettingsService);
		directoryPluginRepository = module.get(DirectoryPluginRepository);
		userPluginRepository = module.get(UserPluginRepository);
	});

	describe('three-level enable configuration', () => {
		it('should use DirectoryPlugin.enabled (Level 2) when record exists', async () => {
			// Setup
			const mockPlugin = createMockPlugin('my-plugin');
			const registered = createRegisteredPlugin(mockPlugin);
			registry.getByCapability.mockReturnValue([registered]);

			// DirectoryPlugin says enabled
			directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue({
				enabled: true
			} as any);

			// Act & Assert
			const result = await service.doSomething(input, {
				directoryId: 'dir-123'
			});
			expect(mockPlugin.doSomething).toHaveBeenCalled();
		});

		it('should fall back to UserPlugin.enabled (Level 1) when no directory record', async () => {
			// No DirectoryPlugin record
			directoryPluginRepository.findByDirectoryAndPlugin.mockResolvedValue(null);

			// UserPlugin says disabled
			userPluginRepository.findByUserAndPlugin.mockResolvedValue({
				enabled: false
			} as any);

			// Act & Assert
			await expect(
				service.doSomething(input, {
					directoryId: 'dir-123',
					userId: 'user-456'
				})
			).rejects.toThrow(NoMyCapabilityProviderError);
		});
	});
});
```

## Best Practices

1. **Always extend BaseFacadeService** - Don't duplicate enable resolution logic
2. **Use @Optional() for repositories** - Allow facades to work without database
3. **Override getProviderName()** - If your plugin interface has a specific name property
4. **Include userId and directoryId** - Pass context for proper enable resolution
5. **Handle errors gracefully** - Use capability-specific error classes
6. **Test all enable levels** - Verify Level 2 > Level 1 > autoEnable precedence

## Related Documentation

- [PLUGIN_SYSTEM_RFC.md](./PLUGIN_SYSTEM_RFC.md) - Overall plugin system design
- [PLUGIN_ARCHITECTURE_GUIDE.md](./PLUGIN_ARCHITECTURE_GUIDE.md) - Plugin development guide
- [designs/facade-architecture.md](./designs/facade-architecture.md) - Facade architecture overview

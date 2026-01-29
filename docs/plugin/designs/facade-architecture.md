# Facade Architecture Design Document

> **Status:** Design complete. Implementation blocked on Story 2 (Plugin Runtime).
>
> This document describes the generic facade pattern used by all capability facades.

---

## Overview

Facades are thin service wrappers in `packages/agent` that abstract plugin interactions from the rest of the application. Instead of services knowing about plugins and registries, they call facades which handle:

1. **Provider Resolution** - Determining which plugin to use
2. **Settings Resolution** - Getting the correct configuration
3. **Plugin Invocation** - Calling the plugin with resolved settings
4. **Error Handling** - Uniform error handling across capabilities

---

## Why Facades?

```
┌─────────────────────────────────────────────────────────────────────┐
│ WITHOUT FACADES                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  DataGeneratorService                                                │
│      │                                                               │
│      ├─→ PluginRegistryService.getByCapability('git-provider')      │
│      ├─→ PluginSettingsService.getDirectoryProvider(...)            │
│      ├─→ PluginSettingsService.getUserPluginSettings(...)           │
│      ├─→ plugin.createRepository(...)                               │
│      └─→ Error handling, logging...                                 │
│                                                                      │
│  WebsiteGeneratorService                                             │
│      │                                                               │
│      ├─→ PluginRegistryService.getByCapability('git-provider')      │
│      ├─→ PluginSettingsService.getDirectoryProvider(...)            │
│      ├─→ ... (same boilerplate repeated)                            │
│                                                                      │
│  MarkdownGeneratorService                                            │
│      │                                                               │
│      ├─→ ... (same boilerplate repeated again)                      │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ WITH FACADES                                                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  DataGeneratorService                                                │
│      └─→ GitFacade.createRepository(options, directoryId, userId)   │
│                                                                      │
│  WebsiteGeneratorService                                             │
│      └─→ GitFacade.createRepository(options, directoryId, userId)   │
│                                                                      │
│  MarkdownGeneratorService                                            │
│      └─→ GitFacade.push(options, directoryId)                       │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

**Benefits:**

- **DRY** - Provider/settings resolution logic in one place
- **Testable** - Easy to mock facades in unit tests
- **Maintainable** - Changes to plugin system don't affect consumers
- **Consistent** - Uniform error handling and logging

---

## Generic Facade Pattern

All facades follow this structure:

```typescript
@Injectable()
export class [Capability]Facade {
    private readonly logger = new Logger([Capability]Facade.name);

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly settingsService: PluginSettingsService,
    ) {}

    // ========================================
    // PRIVATE: Plugin Resolution
    // ========================================

    /**
     * Resolve which plugin to use for a directory.
     *
     * Resolution order:
     * 1. providerOverride (from GenerationOptions.providers.[capability])
     * 2. DirectoryPlugin.settings.defaults['[capability]']
     * 3. Platform default (AdminPlugin or first available)
     */
    private async getPlugin(
        directoryId: string,
        providerOverride?: string,
    ): Promise<I[Capability]Plugin> {
        const providerId =
            providerOverride ??
            (await this.settingsService.getDirectoryProvider(directoryId, '[capability]')) ??
            (await this.settingsService.getPlatformDefault('[capability]'));

        if (!providerId) {
            throw new [Capability]ProviderNotFoundError('No provider configured');
        }

        const plugin = this.registry.getByCapability<I[Capability]Plugin>(
            '[capability]',
            providerId,
        );

        if (!plugin) {
            throw new [Capability]ProviderNotFoundError(providerId);
        }

        return plugin;
    }

    // ========================================
    // PRIVATE: Settings Resolution
    // ========================================

    /**
     * Resolve settings for a plugin using 4-level hierarchy.
     *
     * Merge order:
     * 1. Plugin.defaultSettings (hardcoded in plugin)
     * 2. AdminPlugin.settings (platform-wide)
     * 3. UserPlugin.settings (user's configuration)
     * 4. DirectoryPlugin.settings (directory-specific overrides)
     */
    private async getSettings(
        userId: string,
        directoryId: string,
        pluginId: string,
    ): Promise<Record<string, unknown>> {
        return this.settingsService.resolveSettings(userId, directoryId, pluginId);
    }

    // ========================================
    // PUBLIC: Capability Methods
    // ========================================

    async someOperation(
        options: OperationOptions,
        directoryId: string,
        userId: string,
        providerOverride?: string,
    ): Promise<OperationResult> {
        const plugin = await this.getPlugin(directoryId, providerOverride);
        const settings = await this.getSettings(userId, directoryId, plugin.id);

        try {
            return await plugin.someOperation(options, settings);
        } catch (error) {
            this.logger.error(`[${plugin.id}] someOperation failed`, error);
            throw new [Capability]FacadeError('someOperation failed', error);
        }
    }
}
```

---

## Provider Resolution: Three-Level Configuration

All facades use the same three-level configuration model:

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. USER LEVEL (Settings > Plugins)                                  │
│    - Install plugins for each capability                            │
│    - Configure API keys / credentials                               │
│    - Connect OAuth where applicable                                 │
│    - Stored in: UserPlugin.settings                                 │
├─────────────────────────────────────────────────────────────────────┤
│ 2. DIRECTORY LEVEL (Directory > Apps)                               │
│    - Select DEFAULT provider per capability for this directory      │
│    - Override plugin settings (e.g., viewport for screenshots)      │
│    - Stored in: DirectoryPlugin.settings.defaults['capability']     │
├─────────────────────────────────────────────────────────────────────┤
│ 3. GENERATION LEVEL (Generator Form)                                │
│    - Override provider selection for THIS generation only           │
│    - Configure generation-specific plugin options                   │
│    - Passed via: GenerationOptions.providers.capability             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Settings Resolution: Four-Level Hierarchy

Settings are merged from four sources:

```typescript
// Resolution order (later overrides earlier)
const settings = {
	...plugin.defaultSettings, // 1. Hardcoded plugin defaults
	...adminPluginSettings, // 2. Platform admin settings
	...userPluginSettings, // 3. User's settings
	...directoryPluginSettings // 4. Directory overrides
};
```

### Configuration Modes

Plugins can declare how their settings can be configured:

| Mode               | Admin    | User     | Directory | Use Case                          |
| ------------------ | -------- | -------- | --------- | --------------------------------- |
| `admin-only`       | Required | Ignored  | Ignored   | Platform-provided shared API keys |
| `user-required`    | Ignored  | Required | Optional  | Users must bring their own keys   |
| `hybrid` (default) | Optional | Optional | Optional  | Most flexible                     |

---

## Facade Inventory

| Facade           | Capability     | Primary Methods                           | Design Doc                                                   |
| ---------------- | -------------- | ----------------------------------------- | ------------------------------------------------------------ |
| GitFacade        | `git-provider` | createRepository, push, createPullRequest | [git-facade-design.md](./git-facade-design.md)               |
| DeployFacade     | `deployment`   | deploy, getStatus, getDomains             | [deploy-facade-design.md](./deploy-facade-design.md)         |
| ScreenshotFacade | `screenshot`   | capture, bulkCapture                      | [screenshot-facade-design.md](./screenshot-facade-design.md) |
| SearchFacade     | `search`       | search                                    | [search-facade-design.md](./search-facade-design.md)         |
| AiFacade         | `ai-provider`  | chat, chatStream, askJson, route          | [ai-facade-design.md](./ai-facade-design.md)                 |
| GitOAuthFacade   | `git-oauth`    | getAuthUrl, handleCallback                | [git-facade-design.md](./git-facade-design.md)               |

---

## Error Handling Pattern

Each facade defines its own error hierarchy:

```typescript
// Base error for the facade
export class [Capability]FacadeError extends Error {
    constructor(
        message: string,
        public readonly operation: string,
        public readonly provider?: string,
        public readonly cause?: Error,
    ) {
        super(message);
        this.name = '[Capability]FacadeError';
    }
}

// Provider not found
export class [Capability]ProviderNotFoundError extends [Capability]FacadeError {
    constructor(providerId: string) {
        super(`Provider not found: ${providerId}`, 'getPlugin', providerId);
        this.name = '[Capability]ProviderNotFoundError';
    }
}

// Settings/credentials missing
export class [Capability]SettingsMissingError extends [Capability]FacadeError {
    constructor(providerId: string, field: string) {
        super(
            `Missing required setting '${field}' for ${providerId}`,
            'getSettings',
            providerId,
        );
        this.name = '[Capability]SettingsMissingError';
    }
}
```

---

## Module Structure

```
packages/agent/src/facades/
├── facades.module.ts           # NestJS module
├── index.ts                    # Barrel exports
├── git.facade.ts               # Git operations
├── deploy.facade.ts            # Deployment operations
├── screenshot.facade.ts        # Screenshot capture
├── search.facade.ts            # Web search
├── ai.facade.ts                # AI operations with routing
├── git-oauth.facade.ts         # Git provider OAuth
└── errors/
    ├── index.ts
    ├── git-facade.errors.ts
    ├── deploy-facade.errors.ts
    ├── screenshot-facade.errors.ts
    ├── search-facade.errors.ts
    └── ai-facade.errors.ts
```

---

## NestJS Module

```typescript
// packages/agent/src/facades/facades.module.ts
import { Module } from '@nestjs/common';
import { PluginsModule } from '../plugins/plugins.module';

import { GitFacade } from './git.facade';
import { DeployFacade } from './deploy.facade';
import { ScreenshotFacade } from './screenshot.facade';
import { SearchFacade } from './search.facade';
import { AiFacade } from './ai.facade';
import { GitOAuthFacade } from './git-oauth.facade';

const facades = [GitFacade, DeployFacade, ScreenshotFacade, SearchFacade, AiFacade, GitOAuthFacade];

@Module({
	imports: [PluginsModule],
	providers: facades,
	exports: facades
})
export class FacadesModule {}
```

---

## Dependencies

All facades require Story 2 (Plugin Runtime) services:

| Service                 | Purpose                                 |
| ----------------------- | --------------------------------------- |
| `PluginRegistryService` | Get plugin instances by capability      |
| `PluginSettingsService` | Resolve settings with 4-level hierarchy |

---

## Testing Facades

Facades are easy to test by mocking the registry and settings services:

```typescript
describe('GitFacade', () => {
	let facade: GitFacade;
	let mockRegistry: jest.Mocked<PluginRegistryService>;
	let mockSettings: jest.Mocked<PluginSettingsService>;
	let mockPlugin: jest.Mocked<IGitProviderPlugin>;

	beforeEach(() => {
		mockPlugin = {
			id: 'github',
			createRepository: jest.fn()
			// ...
		};

		mockRegistry = {
			getByCapability: jest.fn().mockReturnValue(mockPlugin)
		};

		mockSettings = {
			getDirectoryProvider: jest.fn().mockResolvedValue('github'),
			getUserPluginSettings: jest.fn().mockResolvedValue({
				accessToken: 'test-token'
			}),
			resolveSettings: jest.fn().mockResolvedValue({})
		};

		facade = new GitFacade(mockRegistry, mockSettings);
	});

	it('should create repository using resolved plugin', async () => {
		mockPlugin.createRepository.mockResolvedValue({ id: 123, name: 'test' });

		const result = await facade.createRepository(
			{ name: 'test', description: 'Test repo' },
			'directory-123',
			'user-456'
		);

		expect(mockSettings.getDirectoryProvider).toHaveBeenCalledWith('directory-123', 'git-provider');
		expect(mockRegistry.getByCapability).toHaveBeenCalledWith('git-provider', 'github');
		expect(result.name).toBe('test');
	});

	it('should use provider override when specified', async () => {
		await facade.createRepository(
			{ name: 'test' },
			'directory-123',
			'user-456',
			'gitlab' // Override
		);

		expect(mockRegistry.getByCapability).toHaveBeenCalledWith(
			'git-provider',
			'gitlab' // Used override, not directory default
		);
	});
});
```

---

## Related Documentation

- [PLUGIN_SYSTEM_RFC.md - Settings Resolution](../PLUGIN_SYSTEM_RFC.md#settings-resolution)
- [PLUGIN_SYSTEM_RFC.md - Generator Form Architecture](../PLUGIN_SYSTEM_RFC.md#generator-form-architecture)
- [PLUGIN_SYSTEM_CHECKLIST.md - Story 10](../PLUGIN_SYSTEM_CHECKLIST.md)
- [multi-provider-selection.md](./multi-provider-selection.md)

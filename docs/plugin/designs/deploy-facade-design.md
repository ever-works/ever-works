# Deploy Facade Service Design Document

> **Status:** Design complete. Implementation blocked on Story 2 (Plugin Runtime).
>
> This document captures the facade design for deployment operations.

---

## Overview

The DeployFacade abstracts deployment operations (Vercel, Netlify, Railway, etc.) behind the plugin system. It follows the generic facade pattern documented in [facade-architecture.md](./facade-architecture.md).

---

## Provider Resolution

Deployment provider selection follows the three-level configuration model:

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. USER LEVEL (Settings > Plugins)                                  │
│    - Install deployment plugins (Vercel, Netlify, etc.)             │
│    - Configure API tokens                                           │
│    - Stored in: UserPlugin.settings.apiToken                        │
├─────────────────────────────────────────────────────────────────────┤
│ 2. DIRECTORY LEVEL (Directory > Apps)                               │
│    - Select DEFAULT deployment provider for this directory          │
│    - Stored in: DirectoryPlugin.settings.defaults['deployment']     │
├─────────────────────────────────────────────────────────────────────┤
│ 3. GENERATION LEVEL (Generator Form)                                │
│    - Override provider for THIS deployment only                     │
│    - Passed via: DeployOptions.providerOverride                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Database Model (Plugin System)

### Token Storage: UserPlugin

```typescript
// UserPlugin for Vercel
{
    userId: 'user-123',
    pluginId: 'vercel',
    settings: {
        apiToken: 'vercel_xxxx...',  // Encrypted (secret: true)
        teamId: 'team_xxxx',         // Optional
        defaultRegion: 'iad1'
    },
    enabled: true
}
```

### Provider Selection: DirectoryPlugin

```typescript
// DirectoryPlugin for deployment
{
    directoryId: 'dir-456',
    pluginId: 'vercel',
    settings: {
        defaults: {
            'deployment': 'vercel'
        },
        // Provider-specific deployment settings
        projectId: 'prj_xxxx',
        productionBranch: 'main',
        domains: ['example.com']
    },
    enabled: true
}
```

### Migration from Hardcoded Fields

| Current (Hardcoded)    | After (Plugin System)                             |
| ---------------------- | ------------------------------------------------- |
| `User.vercelToken`     | `UserPlugin.settings.apiToken` (vercel)           |
| N/A (hardcoded Vercel) | `DirectoryPlugin.settings.defaults['deployment']` |

---

## DeployFacade Implementation

### Location

`packages/agent/src/facades/deploy.facade.ts`

### Interface Design

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { IDeploymentPlugin, DeployOptions, DeployResult, DeploymentStatus, Domain, Project } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { PluginSettingsService } from '../plugins/plugin-settings.service';

@Injectable()
export class DeployFacade {
	private readonly logger = new Logger(DeployFacade.name);

	constructor(
		private readonly registry: PluginRegistryService,
		private readonly settingsService: PluginSettingsService
	) {}

	// ========================================
	// PLUGIN RESOLUTION (Private)
	// ========================================

	private async getPlugin(directoryId: string, providerOverride?: string): Promise<IDeploymentPlugin> {
		const providerId =
			providerOverride ??
			(await this.settingsService.getDirectoryProvider(directoryId, 'deployment')) ??
			(await this.settingsService.getPlatformDefault('deployment'));

		if (!providerId) {
			throw new DeployProviderNotFoundError('No deployment provider configured');
		}

		const plugin = this.registry.getByCapability<IDeploymentPlugin>('deployment', providerId);

		if (!plugin) {
			throw new DeployProviderNotFoundError(providerId);
		}

		return plugin;
	}

	private async getSettings(userId: string, directoryId: string, pluginId: string): Promise<Record<string, unknown>> {
		return this.settingsService.resolveSettings(userId, directoryId, pluginId);
	}

	// ========================================
	// DEPLOYMENT OPERATIONS
	// ========================================

	/**
	 * Deploy a project.
	 */
	async deploy(
		options: DeployOptions,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<DeployResult> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const settings = await this.getSettings(userId, directoryId, plugin.id);

		return plugin.deploy(options, settings);
	}

	/**
	 * Get deployment status.
	 */
	async getStatus(
		deploymentId: string,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<DeploymentStatus> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const settings = await this.getSettings(userId, directoryId, plugin.id);

		return plugin.getStatus(deploymentId, settings);
	}

	/**
	 * Cancel a deployment.
	 */
	async cancel(deploymentId: string, directoryId: string, userId: string, providerOverride?: string): Promise<void> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const settings = await this.getSettings(userId, directoryId, plugin.id);

		return plugin.cancel(deploymentId, settings);
	}

	// ========================================
	// PROJECT OPERATIONS
	// ========================================

	/**
	 * Create a new project on the deployment platform.
	 */
	async createProject(
		name: string,
		options: Partial<Project>,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<Project> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const settings = await this.getSettings(userId, directoryId, plugin.id);

		return plugin.createProject(name, options, settings);
	}

	/**
	 * Get project details.
	 */
	async getProject(
		projectId: string,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<Project | null> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const settings = await this.getSettings(userId, directoryId, plugin.id);

		return plugin.getProject(projectId, settings);
	}

	/**
	 * Delete a project.
	 */
	async deleteProject(
		projectId: string,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<void> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const settings = await this.getSettings(userId, directoryId, plugin.id);

		return plugin.deleteProject(projectId, settings);
	}

	// ========================================
	// DOMAIN OPERATIONS
	// ========================================

	/**
	 * Get domains for a project.
	 */
	async getDomains(
		projectId: string,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<Domain[]> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const settings = await this.getSettings(userId, directoryId, plugin.id);

		return plugin.getDomains(projectId, settings);
	}

	/**
	 * Add a domain to a project.
	 */
	async addDomain(
		projectId: string,
		domain: string,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<Domain> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const settings = await this.getSettings(userId, directoryId, plugin.id);

		return plugin.addDomain(projectId, domain, settings);
	}

	/**
	 * Remove a domain from a project.
	 */
	async removeDomain(
		projectId: string,
		domain: string,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<void> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const settings = await this.getSettings(userId, directoryId, plugin.id);

		return plugin.removeDomain(projectId, domain, settings);
	}

	// ========================================
	// ENVIRONMENT VARIABLES
	// ========================================

	/**
	 * Set environment variables for a project.
	 */
	async setEnvVars(
		projectId: string,
		envVars: Record<string, string>,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<void> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const settings = await this.getSettings(userId, directoryId, plugin.id);

		return plugin.setEnvVars(projectId, envVars, settings);
	}

	/**
	 * Get environment variables for a project.
	 */
	async getEnvVars(
		projectId: string,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<Record<string, string>> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const settings = await this.getSettings(userId, directoryId, plugin.id);

		return plugin.getEnvVars(projectId, settings);
	}
}
```

---

## Error Types

```typescript
// packages/agent/src/facades/errors/deploy-facade.errors.ts

export class DeployFacadeError extends Error {
	constructor(
		message: string,
		public readonly operation: string,
		public readonly provider?: string,
		public readonly cause?: Error
	) {
		super(message);
		this.name = 'DeployFacadeError';
	}
}

export class DeployProviderNotFoundError extends DeployFacadeError {
	constructor(providerId: string) {
		super(`Deployment provider not found: ${providerId}`, 'getPlugin', providerId);
		this.name = 'DeployProviderNotFoundError';
	}
}

export class DeployTokenMissingError extends DeployFacadeError {
	constructor(providerId: string) {
		super(
			`No ${providerId} token found. Please configure your ${providerId} API token.`,
			'getSettings',
			providerId
		);
		this.name = 'DeployTokenMissingError';
	}
}
```

---

## Migration Pattern

```typescript
// BEFORE - Hardcoded Vercel
constructor(private readonly vercelService: VercelService) {}

async deployWebsite(directory: Directory, user: User) {
    const token = user.vercelToken;  // ❌ From User entity
    await this.vercelService.deploy(projectId, branch, token);
}
```

```typescript
// AFTER - Plugin system with facade
constructor(private readonly deployFacade: DeployFacade) {}

async deployWebsite(directory: Directory, user: User) {
    await this.deployFacade.deploy(
        { projectId, branch },
        directory.id,  // Facade reads DirectoryPlugin for provider
        user.id,       // Facade reads UserPlugin for token
    );
}
```

---

## User Flow Example

### Setup

1. User goes to **Settings > Plugins**
2. User installs "Vercel" plugin
3. User enters Vercel API token
    - Stored in `UserPlugin.settings.apiToken` (encrypted)

### Per-Directory Configuration

1. User creates Directory A
2. In **Directory A > Apps**, user selects deployment provider: "Vercel"
    - Stored in `DirectoryPlugin.settings.defaults['deployment'] = 'vercel'`
3. User configures project ID and domains in directory settings
    - Stored in `DirectoryPlugin.settings.projectId`, etc.

### Deployment

1. DeployFacade reads `DirectoryPlugin.settings.defaults['deployment']` → "vercel"
2. DeployFacade gets Vercel plugin from registry
3. DeployFacade resolves settings (user token + directory project config)
4. Vercel plugin deploys with resolved settings

---

## Related Documentation

- [facade-architecture.md](./facade-architecture.md)
- [PLUGIN_SYSTEM_RFC.md - Migration from Hardcoded Infrastructure](../PLUGIN_SYSTEM_RFC.md#migration-from-hardcoded-infrastructure)

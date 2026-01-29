# @ever-works/plugin

Plugin system contracts, helpers, and utilities for the Ever Works platform.

## Overview

This package provides everything needed to build plugins for the Ever Works ecosystem:

- **Contracts**: TypeScript interfaces defining plugin capabilities
- **Abstract Classes**: Base implementations for common plugin types
- **Helpers**: Utility functions for settings, validation, and context
- **Testing Utilities**: Mocks and test harnesses for plugin development

## Installation

```bash
pnpm add @ever-works/plugin
```

## Key Features

- **Standalone**: No NestJS dependencies - plugins work in any TypeScript environment
- **Type-Safe**: Compile-time validation with TypeScript unions and mapped types
- **Capability-Based**: Plugins declare capabilities and implement corresponding interfaces
- **Testable**: Built-in mocks and test harnesses for comprehensive testing

## Package Structure

```
@ever-works/plugin
├── /contracts      # Plugin interfaces and capability definitions
├── /pipeline       # Pipeline step types and execution context
├── /events         # Event system types
├── /settings       # Settings types and JSON Schema definitions
├── /common         # Shared types (domain, item, form-field)
├── /helpers        # Utility functions
├── /abstract       # Abstract base classes
└── /testing        # Test utilities and mocks
```

## Usage

### Creating a Basic Plugin

```typescript
import { BasePlugin, type PluginContext, type ValidationResult } from '@ever-works/plugin';

export class MyPlugin extends BasePlugin {
	readonly id = 'my-plugin';
	readonly name = 'My Plugin';
	readonly version = '1.0.0';
	readonly category = 'utility';
	readonly capabilities = ['custom'] as const;

	async onEnable(context: PluginContext): Promise<void> {
		await super.onEnable(context);
		this.log('Plugin enabled!');
	}
}
```

### Creating a Git Provider Plugin

Git provider plugins implement `IGitProviderPlugin` which includes:

- **Authentication methods**: `getAuth()`, `getCloneUrl()`, `getWebUrl()`
- **Repository API operations**: `createRepository()`, `getRepository()`, `deleteRepository()`
- **User/Org operations**: `getUser()`, `getOrganizations()`
- **Pull Request operations**: `createPullRequest()`, `mergePullRequest()`
- **Branch operations**: `listBranches()`

Local git operations (clone, push, commit) are provided by the platform's `GitProvider` base class in `packages/agent`.

```typescript
import { BaseGitProvider, type IGitProviderPlugin, type GitAuth } from '@ever-works/plugin';

export class GitHubPlugin extends BaseGitProvider implements IGitProviderPlugin {
	readonly id = 'github';
	readonly name = 'GitHub';
	readonly version = '1.0.0';
	readonly providerName = 'github';

	// Provider-specific authentication
	getAuth(token: string): GitAuth {
		return { username: 'x-access-token', password: token };
	}

	getCloneUrl(owner: string, repo: string): string {
		return `https://github.com/${owner}/${repo}.git`;
	}

	getWebUrl(owner: string, repo: string): string {
		return `https://github.com/${owner}/${repo}`;
	}

	// API Operations (provider-specific implementation)
	async createRepository(options, token) {
		// Use Octokit or fetch to call GitHub API
	}

	async getRepository(owner, repo, token) {
		// Use Octokit or fetch to call GitHub API
	}

	async getUser(token) {
		// Use Octokit or fetch to call GitHub API
	}

	async getOrganizations(token) {
		// Use Octokit or fetch to call GitHub API
	}

	async listBranches(owner, repo, token) {
		// Use Octokit or fetch to call GitHub API
	}

	async createPullRequest(options, token) {
		// Use Octokit or fetch to call GitHub API
	}

	async mergePullRequest(owner, repo, prNumber, options, token) {
		// Use Octokit or fetch to call GitHub API
	}

	async deleteRepository(owner, repo, token) {
		// Use Octokit or fetch to call GitHub API
	}

	// Local git operations - inherited from platform's GitProvider
	// clone, push, commit, pull, etc. are implemented once and shared
}
```

### Creating a Pipeline Step Plugin

```typescript
import { BasePipelineStep, type MutableGenerationContext } from '@ever-works/plugin';

export class MyPipelineStep extends BasePipelineStep {
	readonly id = 'my-step';
	readonly name = 'My Custom Step';
	readonly version = '1.0.0';
	readonly stepId = 'custom:my-step';
	readonly stepName = 'My Step';
	readonly stepDescription = 'Does something custom';
	readonly stepPosition = { after: 'fetch-page-content' };

	async execute(context: MutableGenerationContext): Promise<void> {
		this.reportProgress(0, 'Starting...');
		// Your logic here
		this.reportProgress(100, 'Complete');
	}
}
```

### Testing Plugins

```typescript
import { createMockPluginContext, createTestHarness, testBasePluginContract } from '@ever-works/plugin/testing';

describe('MyPlugin', () => {
	it('passes contract tests', async () => {
		const plugin = new MyPlugin();
		const results = await testBasePluginContract(plugin);
		expect(results.every((r) => r.passed)).toBe(true);
	});

	it('enables correctly', async () => {
		const plugin = new MyPlugin();
		const harness = createTestHarness(plugin, {
			settings: { apiKey: 'test-key' }
		});

		await harness.load();
		await harness.enable();

		expect(harness.isEnabled).toBe(true);
	});
});
```

## Available Capabilities

| Capability          | Interface                 | Description                       |
| ------------------- | ------------------------- | --------------------------------- |
| `git-provider`      | `IGitProviderPlugin`      | Git repository & API operations   |
| `oauth`             | `IOAuthPlugin`            | OAuth-based authentication        |
| `deployment`        | `IDeploymentPlugin`       | Deploy to hosting platforms       |
| `screenshot`        | `IScreenshotPlugin`       | Capture web page screenshots      |
| `search`            | `ISearchPlugin`           | Web search integration            |
| `content-extractor` | `IContentExtractorPlugin` | Extract content from web pages    |
| `data-source`       | `IDataSourcePlugin`       | External data sources             |
| `ai-provider`       | `IAiProviderPlugin`       | AI/LLM providers                  |
| `pipeline-step`     | `IPipelineStepPlugin`     | Custom pipeline steps             |
| `full-pipeline`     | `IFullPipelinePlugin`     | Complete pipeline implementations |
| `form-field`        | `IFormFieldPlugin`        | Custom form fields                |
| `sub-provider`      | `ISubProviderPlugin`      | Sub-provider implementations      |
| `config-aware`      | `IConfigAwarePlugin`      | React to config changes           |
| `custom-capability` | `ICustomCapabilityPlugin` | Define custom capabilities        |

## Git Provider Architecture

The git provider system separates concerns:

1. **`IGitOperations`** - Local git operations (clone, push, commit, pull)
    - Implemented once in the platform using isomorphic-git
    - Shared by all git providers (GitHub, GitLab, etc.)

2. **`IGitProviderPlugin`** - Provider-specific API operations
    - Each provider implements their own API calls
    - Includes: createRepository, getPullRequest, getUser, etc.

3. **`IOAuthPlugin`** - OAuth authentication (separate capability)
    - For providers that support OAuth
    - Can be combined with git-provider capability

```
┌─────────────────────────────────────────────────────────────────┐
│                    GIT PROVIDER ARCHITECTURE                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  IGitOperations (local git - shared implementation)             │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ cloneOrPull(), pull(), push(), commit(), add(), addAll()│    │
│  │ getCurrentBranch(), switchBranch(), getStatus()         │    │
│  │ getLocalDir(), removeLocalDir()                         │    │
│  │                                                          │    │
│  │ Implemented once in platform (packages/agent)           │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  IGitProviderPlugin (provider API - each plugin implements)     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ getAuth(), getCloneUrl(), getWebUrl()                   │    │
│  │ createRepository(), getRepository(), deleteRepository() │    │
│  │ getUser(), getOrganizations()                           │    │
│  │ createPullRequest(), mergePullRequest(), listBranches() │    │
│  │                                                          │    │
│  │ GitHub uses Octokit, GitLab uses their API, etc.        │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Type Guards

```typescript
import { isGitProviderPlugin, isAiProviderPlugin, hasCapability } from '@ever-works/plugin';

if (isGitProviderPlugin(plugin)) {
	const repo = await plugin.getRepository('owner', 'repo', token);
}

if (hasCapability(plugin, 'ai-provider')) {
	const models = await plugin.listModels();
}
```

## Exports

### Main Export

```typescript
import { IPlugin, BasePlugin, createMockPluginContext } from '@ever-works/plugin';
```

### Subpath Exports

```typescript
// Contracts only
import { IPlugin, IGitProviderPlugin, IGitOperations } from '@ever-works/plugin/contracts';

// Pipeline types
import { BuiltInStepId, MutableGenerationContext } from '@ever-works/plugin/pipeline';

// Events
import { PluginEventName, PluginEventPayloads } from '@ever-works/plugin/events';

// Settings
import { JsonSchema, ValidationResult } from '@ever-works/plugin/settings';

// Common types
import { DomainType, ItemData, Category } from '@ever-works/plugin/common';

// Helpers
import { resolveSetting, validateString } from '@ever-works/plugin/helpers';

// Abstract classes
import { BasePlugin, BaseGitProvider } from '@ever-works/plugin/abstract';

// Testing
import { createMockPluginContext, createTestHarness } from '@ever-works/plugin/testing';
```

## License

MIT

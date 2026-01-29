# AI Facade Service Design Document

> **Status:** Design complete. Implementation blocked on Story 2 (Plugin Runtime).
>
> This document captures the facade design for AI provider operations.

---

## Overview

The AiFacade is more complex than other facades because it must handle:

1. **Model Routing** - Map task complexity to model tiers
2. **Provider Failover** - Automatic fallback when providers fail
3. **Health Monitoring** - Track provider availability with caching
4. **Cost Aggregation** - Sum costs across multiple provider calls
5. **askJson Support** - Structured output with routing

It follows the generic facade pattern documented in [facade-architecture.md](./facade-architecture.md) but adds intelligent routing.

---

## Provider Resolution

AI provider selection follows the three-level configuration model with added complexity routing:

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. USER LEVEL (Settings > Plugins)                                  │
│    - Install AI provider plugins (OpenAI, Anthropic, Gemini, etc.)  │
│    - Configure API keys                                             │
│    - Stored in: UserPlugin.settings.apiKey                          │
├─────────────────────────────────────────────────────────────────────┤
│ 2. DIRECTORY LEVEL (Directory > Apps)                               │
│    - Select DEFAULT AI provider for this directory                  │
│    - Stored in: DirectoryPlugin.settings.defaults['ai-provider']    │
├─────────────────────────────────────────────────────────────────────┤
│ 3. GENERATION LEVEL (Generator Form)                                │
│    - Override provider for THIS generation                          │
│    - Passed via: GenerationOptions.providers.ai                     │
├─────────────────────────────────────────────────────────────────────┤
│ 4. TASK LEVEL (Per-Request Routing)                                 │
│    - AiFacade routes by task complexity                             │
│    - Simple → economy tier, Complex → premium tier                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Database Model (Plugin System)

### Token Storage: UserPlugin

```typescript
// UserPlugin for OpenAI
{
    userId: 'user-123',
    pluginId: 'openai',
    settings: {
        apiKey: 'sk-xxxx...',          // Encrypted (secret: true)
        organization: 'org-xxxx',       // Optional
        defaultModel: 'gpt-4o-mini'
    },
    enabled: true
}
```

### Provider Selection: DirectoryPlugin

```typescript
// DirectoryPlugin for AI
{
    directoryId: 'dir-456',
    pluginId: 'openai',
    settings: {
        defaults: {
            'ai-provider': 'openai'
        },
        // Directory-specific model preferences
        preferredModel: 'gpt-4o',
        temperature: 0.7
    },
    enabled: true
}
```

---

## Model Routing

The AiFacade maps task complexity to model tiers:

```typescript
type TaskComplexity = 'simple' | 'medium' | 'complex';
type ModelTier = 'economy' | 'standard' | 'premium';

// Complexity → Tier mapping
const COMPLEXITY_TO_TIER: Record<TaskComplexity, ModelTier> = {
	simple: 'economy', // Fast, cheap: GPT-3.5, Haiku, Gemini Flash
	medium: 'standard', // Balanced: GPT-4o-mini, Sonnet, Gemini Pro
	complex: 'premium' // Powerful: GPT-4, Opus, Gemini Ultra
};

// Provider model tiers (from plugin.getCapabilities())
interface AIProviderCapabilities {
	availableModels: Array<{
		id: string; // "gpt-4o-mini"
		name: string; // "GPT-4o Mini"
		tier: ModelTier; // "standard"
		contextWindow: number;
		inputCostPer1k: number;
		outputCostPer1k: number;
	}>;
}
```

---

## AiFacade Implementation

### Location

`packages/agent/src/facades/ai.facade.ts`

### Interface Design

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ZodSchema } from 'zod';
import {
	IAiProviderPlugin,
	ChatMessage,
	ChatResponse,
	ChatChunk,
	AskJsonResponse,
	HealthCheckResult,
	AIProviderCapabilities
} from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { PluginSettingsService } from '../plugins/plugin-settings.service';

type TaskComplexity = 'simple' | 'medium' | 'complex';
type ModelTier = 'economy' | 'standard' | 'premium';

interface RouteDecision {
	provider: string;
	model: string;
	tier: ModelTier;
}

interface AskJsonRoutingOptions {
	complexity?: TaskComplexity;
	temperature?: number;
	maxRetries?: number;
	userId: string;
	directoryId: string;
	providerOverride?: string;
}

interface ChatRoutingOptions {
	model?: string;
	temperature?: number;
	maxTokens?: number;
	userId: string;
	directoryId: string;
	providerOverride?: string;
}

@Injectable()
export class AiFacade {
	private readonly logger = new Logger(AiFacade.name);
	private healthCache = new Map<string, { result: HealthCheckResult; expiresAt: number }>();
	private readonly HEALTH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

	constructor(
		private readonly registry: PluginRegistryService,
		private readonly settingsService: PluginSettingsService
	) {}

	// ========================================
	// ROUTING LOGIC
	// ========================================

	/**
	 * CRITICAL: Structured output with routing.
	 * All pipeline AI operations use this method.
	 */
	async askJson<T>(
		prompt: string,
		schema: ZodSchema<T>,
		options: AskJsonRoutingOptions
	): Promise<AskJsonResponse<T>> {
		// 1. Route based on complexity to select provider and model
		const route = await this.route(options);

		// 2. Get the selected AI provider plugin
		const plugin = await this.getAiPlugin(route.provider, options.userId, options.directoryId);

		// 3. Get settings for the plugin
		const settings = await this.getSettings(options.userId, options.directoryId, route.provider);

		// 4. Delegate to plugin's askJson with selected model
		return plugin.askJson(prompt, schema, {
			model: route.model,
			temperature: options.temperature,
			maxRetries: options.maxRetries,
			...settings
		});
	}

	/**
	 * Route request based on complexity to select provider and model.
	 */
	private async route(options: AskJsonRoutingOptions): Promise<RouteDecision> {
		const complexity = options.complexity ?? 'medium';
		const tier = this.complexityToTier(complexity);

		// If provider override is specified, use it directly
		if (options.providerOverride) {
			const plugin = await this.getAiPlugin(options.providerOverride, options.userId, options.directoryId);
			const capabilities = plugin.getCapabilities();
			const model = this.findModelByTier(capabilities, tier);

			return {
				provider: options.providerOverride,
				model: model?.id ?? plugin.getDefaultModel(),
				tier
			};
		}

		// Get healthy providers
		const healthyProviders = await this.getHealthyProviders(options.userId, options.directoryId);

		if (healthyProviders.length === 0) {
			throw new NoHealthyAiProvidersError();
		}

		// Find provider with model matching the tier
		for (const { pluginId, plugin } of healthyProviders) {
			const capabilities = plugin.getCapabilities();
			const model = this.findModelByTier(capabilities, tier);

			if (model) {
				return {
					provider: pluginId,
					model: model.id,
					tier
				};
			}
		}

		// Fallback: use default model from first healthy provider
		const fallback = healthyProviders[0];
		return {
			provider: fallback.pluginId,
			model: fallback.plugin.getDefaultModel(),
			tier: 'standard'
		};
	}

	private complexityToTier(complexity: TaskComplexity): ModelTier {
		switch (complexity) {
			case 'simple':
				return 'economy';
			case 'medium':
				return 'standard';
			case 'complex':
				return 'premium';
		}
	}

	private findModelByTier(
		capabilities: AIProviderCapabilities,
		tier: ModelTier
	): AIProviderCapabilities['availableModels'][0] | undefined {
		return capabilities.availableModels.find((m) => m.tier === tier);
	}

	// ========================================
	// HEALTH MONITORING
	// ========================================

	private async getHealthyProviders(
		userId: string,
		directoryId: string
	): Promise<Array<{ pluginId: string; plugin: IAiProviderPlugin }>> {
		const aiPlugins = this.registry.getByCapability<IAiProviderPlugin>('ai-provider');
		const results: Array<{ pluginId: string; plugin: IAiProviderPlugin; responseTime: number }> = [];

		for (const { pluginId, plugin } of aiPlugins) {
			const health = await this.getHealthStatus(pluginId, plugin);
			if (health.success) {
				results.push({ pluginId, plugin, responseTime: health.responseTimeMs });
			}
		}

		// Sort by response time (fastest first)
		return results
			.sort((a, b) => a.responseTime - b.responseTime)
			.map(({ pluginId, plugin }) => ({ pluginId, plugin }));
	}

	private async getHealthStatus(pluginId: string, plugin: IAiProviderPlugin): Promise<HealthCheckResult> {
		const cached = this.healthCache.get(pluginId);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.result;
		}

		try {
			const result = await plugin.healthCheck();
			this.healthCache.set(pluginId, {
				result,
				expiresAt: Date.now() + this.HEALTH_CACHE_TTL
			});
			return result;
		} catch (error) {
			const failResult: HealthCheckResult = {
				success: false,
				responseTimeMs: 0,
				error: error.message
			};
			this.healthCache.set(pluginId, {
				result: failResult,
				expiresAt: Date.now() + this.HEALTH_CACHE_TTL
			});
			return failResult;
		}
	}

	// ========================================
	// BASIC CHAT OPERATIONS
	// ========================================

	/**
	 * Basic chat (no routing - uses specified or default model).
	 */
	async chat(messages: ChatMessage[], options: ChatRoutingOptions): Promise<ChatResponse> {
		const plugin = await this.getAiPlugin(options.providerOverride, options.userId, options.directoryId);
		const settings = await this.getSettings(options.userId, options.directoryId, plugin.id);

		return plugin.chat(messages, { ...options, ...settings });
	}

	/**
	 * Streaming chat.
	 */
	async *chatStream(messages: ChatMessage[], options: ChatRoutingOptions): AsyncIterable<ChatChunk> {
		const plugin = await this.getAiPlugin(options.providerOverride, options.userId, options.directoryId);
		const settings = await this.getSettings(options.userId, options.directoryId, plugin.id);

		yield* plugin.chatStream(messages, { ...options, ...settings });
	}

	/**
	 * Generate embeddings.
	 */
	async embed(
		texts: string[],
		options: {
			model?: string;
			userId: string;
			directoryId: string;
			providerOverride?: string;
		}
	): Promise<number[][]> {
		const plugin = await this.getAiPlugin(options.providerOverride, options.userId, options.directoryId);
		const settings = await this.getSettings(options.userId, options.directoryId, plugin.id);

		return plugin.embed(texts, { model: options.model, ...settings });
	}

	// ========================================
	// PLUGIN RESOLUTION (Private)
	// ========================================

	private async getAiPlugin(
		providerOverride: string | undefined,
		userId: string,
		directoryId: string
	): Promise<IAiProviderPlugin> {
		const providerId =
			providerOverride ??
			(await this.settingsService.getDirectoryProvider(directoryId, 'ai-provider')) ??
			(await this.settingsService.getPlatformDefault('ai-provider'));

		if (!providerId) {
			throw new AiProviderNotFoundError('No AI provider configured');
		}

		const plugin = this.registry.getByCapability<IAiProviderPlugin>('ai-provider', providerId);

		if (!plugin) {
			throw new AiProviderNotFoundError(providerId);
		}

		return plugin;
	}

	private async getSettings(userId: string, directoryId: string, pluginId: string): Promise<Record<string, unknown>> {
		return this.settingsService.resolveSettings(userId, directoryId, pluginId);
	}

	// ========================================
	// UTILITY METHODS
	// ========================================

	/**
	 * Get available AI providers for a user.
	 */
	async getAvailableProviders(userId: string): Promise<
		Array<{
			id: string;
			name: string;
			configured: boolean;
			models: AIProviderCapabilities['availableModels'];
		}>
	> {
		const aiPlugins = this.registry.getByCapability<IAiProviderPlugin>('ai-provider');

		const providers = await Promise.all(
			aiPlugins.map(async ({ pluginId, plugin }) => {
				const settings = await this.settingsService.getUserPluginSettings(userId, pluginId);
				return {
					id: pluginId,
					name: plugin.name,
					configured: !!settings?.apiKey,
					models: plugin.getCapabilities().availableModels
				};
			})
		);

		return providers;
	}

	/**
	 * Get models available for a specific provider.
	 */
	async getModels(providerId: string): Promise<AIProviderCapabilities['availableModels']> {
		const plugin = this.registry.getByCapability<IAiProviderPlugin>('ai-provider', providerId);

		if (!plugin) {
			throw new AiProviderNotFoundError(providerId);
		}

		return plugin.getCapabilities().availableModels;
	}
}
```

---

## Error Types

```typescript
// packages/agent/src/facades/errors/ai-facade.errors.ts

export class AiFacadeError extends Error {
	constructor(
		message: string,
		public readonly operation: string,
		public readonly provider?: string,
		public readonly cause?: Error
	) {
		super(message);
		this.name = 'AiFacadeError';
	}
}

export class AiProviderNotFoundError extends AiFacadeError {
	constructor(providerId: string) {
		super(`AI provider not found: ${providerId}`, 'getPlugin', providerId);
		this.name = 'AiProviderNotFoundError';
	}
}

export class AiApiKeyMissingError extends AiFacadeError {
	constructor(providerId: string) {
		super(
			`No ${providerId} API key found. Please configure your ${providerId} API key.`,
			'getSettings',
			providerId
		);
		this.name = 'AiApiKeyMissingError';
	}
}

export class NoHealthyAiProvidersError extends AiFacadeError {
	constructor() {
		super('No healthy AI providers available. Please check your API key configuration.', 'route');
		this.name = 'NoHealthyAiProvidersError';
	}
}
```

---

## Pipeline Integration

The pipeline uses `AiFacade.askJson()` with complexity hints:

```typescript
// Example: Categorization step (simple task)
const categories = await this.aiFacade.askJson(categorizePrompt, CategorySchema, {
	complexity: 'simple', // Uses economy tier
	userId,
	directoryId
});

// Example: Content generation (complex task)
const content = await this.aiFacade.askJson(generatePrompt, ContentSchema, {
	complexity: 'complex', // Uses premium tier
	userId,
	directoryId
});
```

---

## Related Documentation

- [facade-architecture.md](./facade-architecture.md)
- [multi-provider-selection.md](./multi-provider-selection.md)
- [PLUGIN_SYSTEM_RFC.md - Generator Form Architecture](../PLUGIN_SYSTEM_RFC.md#generator-form-architecture)

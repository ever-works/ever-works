# AI Provider Plugin Guide

> **Complete guide for implementing AI provider plugins for the Ever Works platform.**

## Table of Contents

1. [Overview](#overview)
2. [IAiProviderPlugin Interface](#iaiproviderPlugin-interface)
3. [Model Routing System](#model-routing-system)
4. [Settings Schema](#settings-schema)
5. [Implementation Guide](#implementation-guide)
6. [AI Facade Integration](#ai-facade-integration)
7. [Testing](#testing)
8. [Best Practices](#best-practices)
9. [Examples](#examples)

---

## Overview

AI provider plugins allow the Ever Works platform to use different LLM providers (OpenAI, Anthropic, Google, etc.) for content generation. The plugin system provides:

- **Multi-provider support** - Use any LLM provider
- **Model routing** - Automatic model selection based on task complexity
- **Settings resolution** - Directory → User → Admin → Plugin defaults hierarchy
- **Cost tracking** - Track token usage and costs per request
- **Capability detection** - Know what each model can do

### Key Concepts

1. **Provider Types** - Supported LLM providers (openai, anthropic, google, etc.)
2. **Model Capabilities** - What models can do (streaming, vision, tool calling)
3. **Complexity Routing** - Simple/Medium/Complex tasks use different models
4. **Facade Pattern** - Pipeline steps use AI Facade, not plugins directly

---

## IAiProviderPlugin Interface

Every AI provider plugin must implement the `IAiProviderPlugin` interface:

```typescript
import type { IPlugin } from '@ever-works/plugin';

interface IAiProviderPlugin extends IPlugin {
	// Provider identification
	readonly providerType: AiProviderType;
	readonly providerName: string;

	// Core operations
	createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse>;
	createStreamingChatCompletion?(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk>;
	createEmbedding?(options: EmbeddingOptions): Promise<EmbeddingResponse>;

	// Model management
	listModels(): Promise<readonly AiModel[]>;
	getModel(modelId: string): Promise<AiModel | null>;

	// Availability
	isAvailable(): Promise<boolean>;
	validateApiKey?(): Promise<boolean>;

	// Capabilities
	getCapabilities(): AiModelCapabilities;
}
```

### AiProviderType

Supported provider types:

```typescript
type AiProviderType =
	| 'openai' // OpenAI GPT models
	| 'anthropic' // Claude models
	| 'google' // Gemini models
	| 'groq' // Groq inference
	| 'openrouter' // OpenRouter gateway
	| 'ollama' // Local Ollama
	| 'mistral' // Mistral AI
	| 'cohere' // Cohere
	| 'custom'; // Custom/self-hosted
```

### AiModel

Model information returned by `listModels()`:

```typescript
interface AiModel {
	readonly id: string; // e.g., 'gpt-4-turbo'
	readonly name: string; // e.g., 'GPT-4 Turbo'
	readonly description?: string;
	readonly capabilities: AiModelCapabilities;
	readonly inputCostPer1k?: number; // Cost per 1K input tokens (USD)
	readonly outputCostPer1k?: number; // Cost per 1K output tokens (USD)
	readonly deprecated?: boolean;
}

interface AiModelCapabilities {
	readonly supportsStructuredOutput: boolean; // JSON mode
	readonly supportsStreaming: boolean;
	readonly supportsToolCalling: boolean; // Function calling
	readonly supportsVision: boolean; // Image input
	readonly maxContextLength: number; // Token limit
	readonly maxOutputTokens?: number;
}
```

### ChatCompletionOptions

Options passed to `createChatCompletion()`:

```typescript
interface ChatCompletionOptions {
	readonly model?: string; // Model to use (resolved by facade)
	readonly messages: readonly ChatMessage[];
	readonly temperature?: number; // 0-2
	readonly maxTokens?: number;
	readonly topP?: number;
	readonly frequencyPenalty?: number;
	readonly presencePenalty?: number;
	readonly stop?: readonly string[];
	readonly stream?: boolean;
	readonly tools?: readonly ToolDefinition[];
	readonly toolChoice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
	readonly responseFormat?: { type: 'text' | 'json_object' };
	readonly jsonSchema?: Record<string, unknown>; // For structured output
	readonly seed?: number;
	readonly user?: string;
	readonly settings?: PluginSettings; // Resolved settings from facade
}
```

### ChatCompletionResponse

Response from `createChatCompletion()`:

```typescript
interface ChatCompletionResponse {
	readonly id: string;
	readonly model: string; // Actual model used
	readonly choices: readonly ChatCompletionChoice[];
	readonly usage?: TokenUsage;
	readonly created: number;
}

interface TokenUsage {
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly totalTokens: number;
}
```

---

## Model Routing System

The AI Facade automatically selects the appropriate model based on task complexity.

### Complexity Levels

| Level     | Use Case                                 | Example Model               |
| --------- | ---------------------------------------- | --------------------------- |
| `simple`  | Keyword extraction, basic filtering      | GPT-3.5 Turbo, Claude Haiku |
| `medium`  | Standard analysis, content processing    | GPT-4, Claude Sonnet        |
| `complex` | Deep analysis, synthesis, creative tasks | GPT-4 Turbo, Claude Opus    |

### Resolution Order

When the AI Facade calls a plugin, it resolves the model in this order:

1. **Explicit modelOverride** - Consumer specifies exact model
2. **Complexity-based model** - `simpleModel`, `mediumModel`, or `complexModel` from settings
3. **Default model** - `defaultModel` from settings
4. **Plugin default** - Plugin's internal default (undefined = let plugin decide)

### Settings Hierarchy

Settings are resolved with this priority:

```
Directory Settings > User Settings > Admin Settings > Plugin Defaults
```

This allows:

- **Admins** to set organization-wide defaults
- **Users** to choose their preferred models
- **Directory owners** to optimize per-directory (e.g., use cheaper models for high-volume directories)

### Consumer Usage

Pipeline steps specify complexity when calling the AI Facade:

```typescript
// In a pipeline step
const { result, usage, cost } = await execContext.aiFacade.askJson('Extract keywords from: {text}', KeywordsSchema, {
	temperature: 0.1,
	variables: { text: inputText },
	routing: {
		complexity: 'simple', // Use economy model
		taskId: 'keyword-extraction'
	}
});
```

---

## Settings Schema

AI provider plugins should define settings for API credentials and model routing:

```typescript
readonly settingsSchema: JsonSchema = {
    type: 'object',
    properties: {
        // API Credentials (admin level)
        apiKey: {
            type: 'string',
            title: 'API Key',
            description: 'Your API key from the provider',
            'x-secret': true,       // Encrypted at rest
            'x-masked': true,       // Shows as ******** in UI
            'x-writeOnly': true,    // Never returned via API
            'x-envVar': 'OPENAI_API_KEY',  // Fallback to env var
        },

        // Base URL (optional, for proxies/self-hosted)
        baseUrl: {
            type: 'string',
            title: 'API Base URL',
            description: 'Custom API endpoint (leave empty for default)',
            format: 'uri',
        },

        // Model Routing (user/directory level)
        defaultModel: {
            type: 'string',
            title: 'Default Model',
            description: 'Model to use when no complexity is specified',
            default: 'gpt-4',
            'x-scope': 'user',      // Configurable at user level
        },
        simpleModel: {
            type: 'string',
            title: 'Simple Task Model',
            description: 'Fast, economical model for simple tasks (keyword extraction, basic filtering)',
            default: 'gpt-3.5-turbo',
            'x-scope': 'directory',  // Can override per directory
        },
        mediumModel: {
            type: 'string',
            title: 'Medium Task Model',
            description: 'Balanced model for standard analysis',
            default: 'gpt-4',
            'x-scope': 'directory',
        },
        complexModel: {
            type: 'string',
            title: 'Complex Task Model',
            description: 'High-quality model for complex analysis and synthesis',
            default: 'gpt-4-turbo',
            'x-scope': 'directory',
        },

        // Rate Limiting
        maxRequestsPerMinute: {
            type: 'number',
            title: 'Rate Limit',
            description: 'Maximum requests per minute',
            default: 60,
            minimum: 1,
            maximum: 1000,
        },

        // Provider as default
        isDefault: {
            type: 'boolean',
            title: 'Set as Default Provider',
            description: 'Use this provider when no other is specified',
            default: false,
        },
    },
    required: ['apiKey'],
};
```

### Settings Schema Markers

| Marker        | Purpose                                                      |
| ------------- | ------------------------------------------------------------ |
| `x-secret`    | Encrypt value at rest                                        |
| `x-masked`    | Show as `********` in UI                                     |
| `x-writeOnly` | Never return via API                                         |
| `x-envVar`    | Environment variable fallback                                |
| `x-scope`     | Suggested configuration scope (`admin`, `user`, `directory`) |

---

## Implementation Guide

### Step 1: Create Plugin Structure

```
packages/plugins/my-ai-provider/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts
    ├── my-ai-provider.plugin.ts
    └── __tests__/
        └── my-ai-provider.plugin.spec.ts
```

### Step 2: Package Configuration

**package.json:**

```json
{
	"name": "@ever-works/my-ai-provider-plugin",
	"version": "1.0.0",
	"type": "module",
	"main": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js"
		}
	},
	"peerDependencies": {
		"@ever-works/plugin": "workspace:*"
	},
	"devDependencies": {
		"@ever-works/plugin": "workspace:*"
	}
}
```

**tsup.config.ts:**

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
	external: ['@ever-works/plugin']
});
```

### Step 3: Implement Plugin

```typescript
// src/my-ai-provider.plugin.ts
import type {
	IPlugin,
	IAiProviderPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	ValidationResult,
	PluginSettings,
	AiProviderType,
	AiModel,
	AiModelCapabilities,
	ChatCompletionOptions,
	ChatCompletionResponse,
	ChatCompletionChunk,
	EmbeddingOptions,
	EmbeddingResponse
} from '@ever-works/plugin';

export class MyAiProviderPlugin implements IPlugin, IAiProviderPlugin {
	// ============================================================================
	// IPlugin Properties
	// ============================================================================

	readonly id = 'my-ai-provider';
	readonly name = 'My AI Provider';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'ai-provider';
	readonly capabilities: readonly string[] = ['ai-provider'];

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiKey: {
				type: 'string',
				title: 'API Key',
				'x-secret': true,
				'x-masked': true,
				'x-writeOnly': true,
				'x-envVar': 'MY_AI_API_KEY'
			},
			defaultModel: {
				type: 'string',
				title: 'Default Model',
				default: 'my-model-standard'
			},
			simpleModel: {
				type: 'string',
				title: 'Simple Task Model',
				default: 'my-model-fast'
			},
			mediumModel: {
				type: 'string',
				title: 'Medium Task Model',
				default: 'my-model-standard'
			},
			complexModel: {
				type: 'string',
				title: 'Complex Task Model',
				default: 'my-model-pro'
			}
		},
		required: ['apiKey']
	};

	// ============================================================================
	// IAiProviderPlugin Properties
	// ============================================================================

	readonly providerType: AiProviderType = 'custom';
	readonly providerName = 'My AI Provider';

	private context?: PluginContext;
	private models: AiModel[] = [];

	// ============================================================================
	// IPlugin Lifecycle
	// ============================================================================

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		this.models = this.initializeModels();
		context.logger.log('My AI Provider plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('My AI Provider plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('My AI Provider plugin disabled');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		const apiKey = settings.apiKey as string | undefined;

		if (!apiKey) {
			return {
				valid: false,
				errors: [{ path: 'apiKey', message: 'API key is required' }]
			};
		}

		// Validate API key format
		if (!apiKey.startsWith('myai-')) {
			return {
				valid: false,
				errors: [{ path: 'apiKey', message: 'Invalid API key format' }]
			};
		}

		return { valid: true };
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		try {
			const isAvailable = await this.isAvailable();
			return {
				status: isAvailable ? 'healthy' : 'unhealthy',
				message: isAvailable ? 'API connection successful' : 'API not available',
				checkedAt: Date.now()
			};
		} catch (error) {
			return {
				status: 'unhealthy',
				message: error instanceof Error ? error.message : 'Health check failed',
				checkedAt: Date.now()
			};
		}
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'My AI Provider for content generation',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Your Name' },
			license: 'MIT',
			builtIn: false,
			systemPlugin: false
		};
	}

	// ============================================================================
	// IAiProviderPlugin Methods
	// ============================================================================

	async createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
		const apiKey = this.getApiKey(options.settings);
		const model = options.model || 'my-model-standard';

		// Make API call to your AI provider
		const response = await fetch('https://api.myai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`
			},
			body: JSON.stringify({
				model,
				messages: options.messages.map((m) => ({
					role: m.role,
					content: m.content
				})),
				temperature: options.temperature ?? 0.7,
				max_tokens: options.maxTokens,
				response_format: options.responseFormat
			})
		});

		if (!response.ok) {
			throw new Error(`API error: ${response.status} ${response.statusText}`);
		}

		const data = await response.json();

		return {
			id: data.id,
			model: data.model,
			choices: data.choices.map((choice: any, index: number) => ({
				index,
				message: {
					role: choice.message.role,
					content: choice.message.content
				},
				finishReason: choice.finish_reason
			})),
			usage: data.usage
				? {
						promptTokens: data.usage.prompt_tokens,
						completionTokens: data.usage.completion_tokens,
						totalTokens: data.usage.total_tokens
					}
				: undefined,
			created: data.created
		};
	}

	async *createStreamingChatCompletion(options: ChatCompletionOptions): AsyncIterable<ChatCompletionChunk> {
		const apiKey = this.getApiKey(options.settings);
		const model = options.model || 'my-model-standard';

		const response = await fetch('https://api.myai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`
			},
			body: JSON.stringify({
				model,
				messages: options.messages.map((m) => ({
					role: m.role,
					content: m.content
				})),
				temperature: options.temperature ?? 0.7,
				stream: true
			})
		});

		if (!response.ok || !response.body) {
			throw new Error(`API error: ${response.status}`);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			const text = decoder.decode(value);
			const lines = text.split('\n').filter((line) => line.startsWith('data: '));

			for (const line of lines) {
				const data = line.slice(6);
				if (data === '[DONE]') return;

				const chunk = JSON.parse(data);
				yield {
					id: chunk.id,
					model: chunk.model,
					choices: chunk.choices.map((choice: any, index: number) => ({
						index,
						delta: {
							role: choice.delta.role,
							content: choice.delta.content
						},
						finishReason: choice.finish_reason
					})),
					created: chunk.created
				};
			}
		}
	}

	async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
		const apiKey = this.getApiKey();
		const model = options.model || 'my-embedding-model';
		const input = Array.isArray(options.input) ? options.input : [options.input];

		const response = await fetch('https://api.myai.com/v1/embeddings', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`
			},
			body: JSON.stringify({ model, input })
		});

		if (!response.ok) {
			throw new Error(`API error: ${response.status}`);
		}

		const data = await response.json();

		return {
			model: data.model,
			embeddings: data.data.map((item: any) => item.embedding),
			usage: data.usage
				? {
						promptTokens: data.usage.prompt_tokens,
						completionTokens: 0,
						totalTokens: data.usage.total_tokens
					}
				: undefined
		};
	}

	async listModels(): Promise<readonly AiModel[]> {
		return this.models;
	}

	async getModel(modelId: string): Promise<AiModel | null> {
		return this.models.find((m) => m.id === modelId) || null;
	}

	async isAvailable(): Promise<boolean> {
		try {
			const apiKey = this.getApiKey();
			if (!apiKey) return false;

			// Simple health check call
			const response = await fetch('https://api.myai.com/v1/models', {
				headers: { Authorization: `Bearer ${apiKey}` }
			});

			return response.ok;
		} catch {
			return false;
		}
	}

	async validateApiKey(): Promise<boolean> {
		return this.isAvailable();
	}

	getCapabilities(): AiModelCapabilities {
		return {
			supportsStructuredOutput: true,
			supportsStreaming: true,
			supportsToolCalling: true,
			supportsVision: false,
			maxContextLength: 128000,
			maxOutputTokens: 4096
		};
	}

	// ============================================================================
	// Private Helpers
	// ============================================================================

	private initializeModels(): AiModel[] {
		return [
			{
				id: 'my-model-fast',
				name: 'My Model Fast',
				description: 'Fast, economical model for simple tasks',
				capabilities: {
					supportsStructuredOutput: true,
					supportsStreaming: true,
					supportsToolCalling: false,
					supportsVision: false,
					maxContextLength: 16000,
					maxOutputTokens: 2048
				},
				inputCostPer1k: 0.0005,
				outputCostPer1k: 0.0015
			},
			{
				id: 'my-model-standard',
				name: 'My Model Standard',
				description: 'Balanced model for general tasks',
				capabilities: {
					supportsStructuredOutput: true,
					supportsStreaming: true,
					supportsToolCalling: true,
					supportsVision: false,
					maxContextLength: 128000,
					maxOutputTokens: 4096
				},
				inputCostPer1k: 0.005,
				outputCostPer1k: 0.015
			},
			{
				id: 'my-model-pro',
				name: 'My Model Pro',
				description: 'High-quality model for complex tasks',
				capabilities: {
					supportsStructuredOutput: true,
					supportsStreaming: true,
					supportsToolCalling: true,
					supportsVision: true,
					maxContextLength: 200000,
					maxOutputTokens: 8192
				},
				inputCostPer1k: 0.01,
				outputCostPer1k: 0.03
			}
		];
	}

	private getApiKey(settings?: PluginSettings): string {
		// Prefer settings passed from facade (includes user/directory resolution)
		if (settings?.apiKey) {
			return settings.apiKey as string;
		}

		// Fallback to environment variable
		return process.env.MY_AI_API_KEY || '';
	}
}

export default MyAiProviderPlugin;
```

### Step 4: Export from Index

```typescript
// src/index.ts
export { MyAiProviderPlugin, MyAiProviderPlugin as default } from './my-ai-provider.plugin.js';
```

---

## AI Facade Integration

### How the Facade Calls Plugins

The AI Facade (`AiFacadeService`) is the bridge between pipeline steps and AI plugins:

```
Pipeline Step → AI Facade → Plugin Registry → AI Provider Plugin
     ↓              ↓              ↓                  ↓
  askJson()    resolves model   finds plugin    createChatCompletion()
              resolves settings
```

### Key Facade Operations

1. **Provider Resolution**
    - Check for explicit provider override
    - Check directory default provider
    - Check user default provider
    - Fall back to first enabled AI provider

2. **Model Resolution**
    - Check for explicit model override
    - Check complexity-based model from settings
    - Check default model from settings
    - Let plugin use its default

3. **Settings Resolution**
    - Get plugin settings with directory/user hierarchy
    - Pass resolved settings to plugin

4. **Cost Calculation**
    - Get model info from plugin (`getModel()`)
    - Calculate cost using `inputCostPer1k` and `outputCostPer1k`

### Interface for Consumers

Pipeline steps use `IAiFacade.askJson()`:

```typescript
interface IAiFacade {
	askJson<T>(promptTemplate: string, schema: SchemaType<T>, options?: AskJsonOptions): Promise<AskJsonResponse<T>>;

	isConfigured(): boolean;

	testConnection(): Promise<{
		success: boolean;
		provider: string;
		model: string;
		responseTime: number;
		error?: string;
	}>;

	getAvailableModels(): Promise<readonly AiModel[]>;
}
```

---

## Testing

### Unit Test Structure

```typescript
// src/__tests__/my-ai-provider.plugin.spec.ts
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { MyAiProviderPlugin } from '../my-ai-provider.plugin.js';
import { createMockPluginContext } from '@ever-works/plugin/testing';

describe('MyAiProviderPlugin', () => {
	let plugin: MyAiProviderPlugin;
	let context: ReturnType<typeof createMockPluginContext>;

	beforeEach(() => {
		plugin = new MyAiProviderPlugin();
		context = createMockPluginContext({
			pluginId: 'my-ai-provider',
			settings: {
				apiKey: 'myai-test-key-12345',
				defaultModel: 'my-model-standard'
			}
		});
	});

	describe('IPlugin implementation', () => {
		it('should have correct plugin metadata', () => {
			expect(plugin.id).toBe('my-ai-provider');
			expect(plugin.category).toBe('ai-provider');
			expect(plugin.capabilities).toContain('ai-provider');
		});

		it('should load successfully', async () => {
			await expect(plugin.onLoad(context)).resolves.not.toThrow();
		});

		it('should validate valid settings', async () => {
			const result = await plugin.validateSettings({
				apiKey: 'myai-test-key-12345'
			});
			expect(result.valid).toBe(true);
		});

		it('should reject missing API key', async () => {
			const result = await plugin.validateSettings({});
			expect(result.valid).toBe(false);
			expect(result.errors).toContainEqual(expect.objectContaining({ path: 'apiKey' }));
		});

		it('should reject invalid API key format', async () => {
			const result = await plugin.validateSettings({
				apiKey: 'invalid-key'
			});
			expect(result.valid).toBe(false);
		});
	});

	describe('IAiProviderPlugin implementation', () => {
		beforeEach(async () => {
			await plugin.onLoad(context);
		});

		describe('listModels', () => {
			it('should return available models', async () => {
				const models = await plugin.listModels();
				expect(models.length).toBeGreaterThan(0);
				expect(models[0]).toHaveProperty('id');
				expect(models[0]).toHaveProperty('name');
				expect(models[0]).toHaveProperty('capabilities');
			});

			it('should include cost information', async () => {
				const models = await plugin.listModels();
				const model = models.find((m) => m.id === 'my-model-standard');
				expect(model?.inputCostPer1k).toBeDefined();
				expect(model?.outputCostPer1k).toBeDefined();
			});
		});

		describe('getModel', () => {
			it('should return model by ID', async () => {
				const model = await plugin.getModel('my-model-standard');
				expect(model).not.toBeNull();
				expect(model?.id).toBe('my-model-standard');
			});

			it('should return null for unknown model', async () => {
				const model = await plugin.getModel('unknown-model');
				expect(model).toBeNull();
			});
		});

		describe('getCapabilities', () => {
			it('should return provider capabilities', () => {
				const capabilities = plugin.getCapabilities();
				expect(capabilities).toHaveProperty('supportsStructuredOutput');
				expect(capabilities).toHaveProperty('supportsStreaming');
				expect(capabilities).toHaveProperty('maxContextLength');
			});
		});

		describe('createChatCompletion', () => {
			it('should call API with correct parameters', async () => {
				// Mock fetch
				const mockFetch = jest.spyOn(global, 'fetch').mockResolvedValue({
					ok: true,
					json: async () => ({
						id: 'chatcmpl-123',
						model: 'my-model-standard',
						choices: [
							{
								message: { role: 'assistant', content: '{"result": "test"}' },
								finish_reason: 'stop'
							}
						],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 5,
							total_tokens: 15
						},
						created: Date.now()
					})
				} as Response);

				const response = await plugin.createChatCompletion({
					messages: [{ role: 'user', content: 'Hello' }],
					model: 'my-model-standard',
					settings: { apiKey: 'myai-test-key' }
				});

				expect(response.choices[0].message.content).toBe('{"result": "test"}');
				expect(response.usage?.totalTokens).toBe(15);

				mockFetch.mockRestore();
			});
		});
	});

	describe('health check', () => {
		it('should return healthy when API is available', async () => {
			await plugin.onLoad(context);

			jest.spyOn(global, 'fetch').mockResolvedValue({
				ok: true
			} as Response);

			const health = await plugin.healthCheck();
			expect(health.status).toBe('healthy');
		});
	});
});
```

### Integration with AI Facade Tests

The AI Facade has its own test suite that validates integration with plugins:

```typescript
// packages/agent/src/facades/__tests__/ai.facade.spec.ts

describe('model routing', () => {
	it('should use complexity-based model from settings', async () => {
		settingsService.getSettings.mockResolvedValue({
			simpleModel: 'my-model-fast',
			mediumModel: 'my-model-standard',
			complexModel: 'my-model-pro'
		});

		await service.askJson('Test', testSchema, {
			routing: { complexity: 'simple' }
		});

		expect(aiPlugin.createChatCompletion).toHaveBeenCalledWith(expect.objectContaining({ model: 'my-model-fast' }));
	});
});
```

---

## Best Practices

### 1. Model Cost Information

Always provide accurate cost information for models:

```typescript
{
    id: 'my-model',
    inputCostPer1k: 0.005,   // $0.005 per 1K input tokens
    outputCostPer1k: 0.015,  // $0.015 per 1K output tokens
}
```

This enables the facade to calculate costs and helps users optimize spending.

### 2. Settings from Options

Always prefer settings passed via `options.settings` over environment variables:

```typescript
private getApiKey(settings?: PluginSettings): string {
    // Settings include resolved user/directory overrides
    if (settings?.apiKey) {
        return settings.apiKey as string;
    }
    // Fallback only if not passed
    return process.env.MY_AI_API_KEY || '';
}
```

### 3. Error Handling

Provide clear error messages:

```typescript
async createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
    const apiKey = this.getApiKey(options.settings);

    if (!apiKey) {
        throw new Error('API key not configured. Set it in plugin settings or MY_AI_API_KEY env var.');
    }

    const response = await fetch(url, { ... });

    if (response.status === 401) {
        throw new Error('Invalid API key. Please check your credentials.');
    }

    if (response.status === 429) {
        throw new Error('Rate limit exceeded. Please try again later.');
    }

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`API error ${response.status}: ${error.message || response.statusText}`);
    }

    // ...
}
```

### 4. Model Capabilities

Accurately report model capabilities:

```typescript
{
    supportsStructuredOutput: true,   // Only if JSON mode works reliably
    supportsStreaming: true,
    supportsToolCalling: true,        // Only if function calling works
    supportsVision: false,            // Only if model accepts images
    maxContextLength: 128000,         // Actual context window
    maxOutputTokens: 4096,            // Actual output limit
}
```

### 5. Logging

Use context logger for debugging:

```typescript
async createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
    this.context?.logger.debug(`Creating completion with model: ${options.model}`);

    try {
        const response = await this.callApi(options);
        this.context?.logger.debug(`Completion successful, tokens used: ${response.usage?.totalTokens}`);
        return response;
    } catch (error) {
        this.context?.logger.error(`Completion failed: ${(error as Error).message}`);
        throw error;
    }
}
```

---

## Examples

### OpenAI-Compatible Provider

For providers that use OpenAI-compatible APIs (Groq, Together, Fireworks, etc.):

```typescript
export class OpenAICompatiblePlugin implements IAiProviderPlugin {
	readonly providerType: AiProviderType = 'custom';
	readonly providerName = 'OpenAI Compatible';

	private baseUrl: string;

	async onLoad(context: PluginContext): Promise<void> {
		const settings = await context.getSettings();
		this.baseUrl = (settings.baseUrl as string) || 'https://api.openai.com/v1';
	}

	async createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
		// Use standard OpenAI format
		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.getApiKey(options.settings)}`
			},
			body: JSON.stringify({
				model: options.model,
				messages: options.messages,
				temperature: options.temperature,
				max_tokens: options.maxTokens,
				response_format: options.responseFormat
			})
		});

		// Response format is identical to OpenAI
		return this.parseOpenAIResponse(await response.json());
	}
}
```

### Provider with Custom Auth

```typescript
export class CustomAuthPlugin implements IAiProviderPlugin {
	async createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
		const settings = options.settings || {};

		// Custom authentication
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'X-API-Key': settings.apiKey as string,
			'X-Org-ID': settings.organizationId as string
		};

		// Add optional auth header
		if (settings.accessToken) {
			headers['Authorization'] = `Bearer ${settings.accessToken}`;
		}

		// ...
	}
}
```

---

## Further Reading

- [Plugin Package Guide](./PLUGIN_PACKAGE_GUIDE.md) - Complete plugin interface reference
- [Plugin Architecture Guide](./PLUGIN_ARCHITECTURE_GUIDE.md) - System architecture overview
- [AI Facade Design](./designs/ai-facade-design.md) - Facade implementation details
- [Multi-Provider Selection](./designs/multi-provider-selection.md) - Provider selection logic

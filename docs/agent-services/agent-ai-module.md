---
id: agent-ai-module
title: AI/LLM Module
sidebar_label: AI/LLM
sidebar_position: 27
---

# AI/LLM Module

## Overview

The AI/LLM module in `@ever-works/agent` provides the abstraction layer for all AI-powered operations across the platform. Through the `AiFacadeService`, it delivers a unified interface over multiple AI providers (OpenAI, Anthropic, Google, Groq, Ollama, OpenRouter) with features including structured JSON output with Zod validation, streaming responses, complexity-based model routing, automatic model escalation on failure, and cost estimation.

The facade extends the `BaseFacadeService` pattern, resolving AI providers dynamically from the plugin registry based on capability, user preferences, and directory-level configuration.

## Module Structure

```
packages/agent/src/
  facades/
    ai.facade.ts                     # AiFacadeService (~400+ lines)
    base.facade.ts                   # Abstract base class with provider resolution
    facades.module.ts                # Module registration
  facades/__tests__/
    ai.facade.spec.ts                # Unit tests
    openrouter-model-lookup.spec.ts  # Model lookup tests
  facades/
    openrouter-model-lookup.ts       # OpenRouter model resolution with caching
```

Plugin implementations (in `packages/plugins/`):

```
packages/plugins/
  openai/          # OpenAI provider (GPT-4, GPT-4o, etc.)
  anthropic/       # Anthropic provider (Claude 3, Claude 4, etc.)
  google/          # Google AI provider (Gemini)
  groq/            # Groq provider (fast inference)
  ollama/          # Ollama provider (local models)
  openrouter/      # OpenRouter provider (multi-model gateway)
```

## Key Classes and Services

### `AiFacadeService`

Extends `BaseFacadeService` and implements `IAiFacade`. This is the primary interface for all AI operations in the platform.

**Structured JSON output:**

The `askJson` method is the most commonly used operation. It sends a prompt to an AI model and validates the response against a Zod schema:

```typescript
askJson<T>(
    prompt: string,
    schema: z.ZodSchema<T>,
    options?: AiRequestOptions,
    facadeOptions?: FacadeOptions
): Promise<AiJsonResult<T>>
```

Features:

- Renders prompt templates with variable substitution
- Sends to the resolved AI provider with JSON output mode
- Parses and validates the response against the provided Zod schema
- On validation failure, retries with a more capable model (auto-escalation)
- Returns `{ result: T, model: string, usage: TokenUsage }`

**Chat completion:**

```typescript
createChatCompletion(
    messages: ChatMessage[],
    options?: AiRequestOptions,
    facadeOptions?: FacadeOptions
): Promise<AiChatResult>
```

Standard chat completion for free-form AI responses.

**Streaming:**

```typescript
createStreamingChatCompletion(
    messages: ChatMessage[],
    options?: AiRequestOptions,
    facadeOptions?: FacadeOptions
): AsyncGenerator<AiStreamChunk>
```

Returns an `AsyncGenerator` that yields response chunks as they arrive from the AI provider.

### Model Routing

The facade implements intelligent model routing based on task complexity:

**Resolution priority:**

1. `modelOverride` in request options (explicit model selection)
2. Complexity-based routing from `options.complexity`:
    - `simple` -- uses the provider's cheapest/fastest model
    - `medium` -- uses the provider's default model
    - `complex` -- uses the provider's most capable model
3. Provider's `defaultModel` setting
4. Plugin's built-in default model

### Auto-Escalation

When an `askJson` call fails validation (the AI returns malformed JSON or the response does not match the Zod schema), the facade automatically retries with a more capable model. The escalation chain is defined per provider and typically moves from a faster model to a more capable one (e.g., GPT-4o-mini to GPT-4o, or Claude 3.5 Haiku to Claude 3.5 Sonnet).

### OpenRouter Model Lookup

For the OpenRouter provider, a dedicated `OpenRouterModelLookup` service resolves model metadata (context length, pricing) with a 1-hour in-memory cache. This is used for:

- Determining maximum context length for prompt truncation
- Cost estimation based on input/output token pricing

### Cost Calculation

The facade provides cost estimation based on model pricing information:

```typescript
estimateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    facadeOptions?: FacadeOptions
): Promise<{ cost: number; currency: string }>
```

## API Reference

### AiFacadeService

```typescript
// Structured JSON output with schema validation
askJson<T>(
    prompt: string,
    schema: z.ZodSchema<T>,
    options?: {
        temperature?: number;
        maxTokens?: number;
        complexity?: 'simple' | 'medium' | 'complex';
        modelOverride?: string;
    },
    facadeOptions?: FacadeOptions
): Promise<{ result: T; model: string; usage: TokenUsage }>

// Standard chat completion
createChatCompletion(
    messages: ChatMessage[],
    options?: AiRequestOptions,
    facadeOptions?: FacadeOptions
): Promise<{ content: string; model: string; usage: TokenUsage }>

// Streaming chat completion
createStreamingChatCompletion(
    messages: ChatMessage[],
    options?: AiRequestOptions,
    facadeOptions?: FacadeOptions
): AsyncGenerator<{ content: string; done: boolean }>

// Provider management
isConfigured(): boolean
getAvailableProviders(): Array<{ id: string; name: string; enabled: boolean }>
getActiveProviderName(facadeOptions: FacadeOptions): Promise<string | null>

// Cost estimation
estimateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    facadeOptions?: FacadeOptions
): Promise<{ cost: number; currency: string }>
```

### FacadeOptions

```typescript
interface FacadeOptions {
	userId?: string;
	directoryId?: string;
	providerId?: string; // Explicit provider override
}
```

### TokenUsage

```typescript
interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}
```

## Configuration

### AI Provider Plugin Settings

Each AI provider plugin defines its settings via JSON Schema in `package.json`:

```json
{
	"everworks.plugin": {
		"settings": {
			"apiKey": {
				"type": "string",
				"x-secret": true,
				"x-envVar": "OPENAI_API_KEY",
				"description": "API key for the provider"
			},
			"defaultModel": {
				"type": "string",
				"default": "gpt-4o",
				"description": "Default model for completions"
			},
			"simpleModel": {
				"type": "string",
				"default": "gpt-4o-mini"
			},
			"complexModel": {
				"type": "string",
				"default": "gpt-4o"
			}
		}
	}
}
```

### Settings Hierarchy

Settings are resolved using the 4-level hierarchy (highest priority first):

1. **Directory settings** -- per-directory AI configuration
2. **User settings** -- user's personal AI preferences
3. **Admin settings** -- platform-wide defaults set by administrators
4. **Plugin defaults** -- built-in defaults from the plugin package

### Supported Providers

| Provider   | Plugin ID    | Models                                   |
| ---------- | ------------ | ---------------------------------------- |
| OpenAI     | `openai`     | GPT-4o, GPT-4o-mini, GPT-4-turbo, o1, o3 |
| Anthropic  | `anthropic`  | Claude Opus, Claude Sonnet, Claude Haiku |
| Google     | `google`     | Gemini Pro, Gemini Flash                 |
| Groq       | `groq`       | Llama, Mixtral (fast inference)          |
| Ollama     | `ollama`     | Any locally hosted model                 |
| OpenRouter | `openrouter` | Multi-provider gateway (200+ models)     |

## Dependencies

| Dependency                  | Purpose                                          |
| --------------------------- | ------------------------------------------------ |
| `@ever-works/plugin`        | `IAiProvider`, `PLUGIN_CAPABILITIES.AI_PROVIDER` |
| `@ever-works/plugin/ai`     | `AiOperations` wrapper around LangChain          |
| `@langchain/core`           | Chat models, messages, streaming                 |
| `@langchain/openai`         | OpenAI-compatible provider integration           |
| `zod`                       | Schema validation for structured AI output       |
| `@ever-works/agent/plugins` | `PluginRegistryService`, `PluginSettingsService` |

## Usage Examples

### Structured JSON Output

```typescript
import { AiFacadeService } from '@ever-works/agent/facades';
import { z } from 'zod';

const schema = z.object({
	name: z.string(),
	description: z.string(),
	category: z.string(),
	tags: z.array(z.string())
});

const { result, model } = await aiFacade.askJson(
	'Extract information about this tool: VS Code is a code editor by Microsoft...',
	schema,
	{ temperature: 0.3, complexity: 'simple' },
	{ userId: user.id, directoryId: directory.id }
);

console.log(result.name); // 'VS Code'
console.log(result.category); // 'Developer Tools'
console.log(`Used model: ${model}`);
```

### Streaming Responses

```typescript
const stream = aiFacade.createStreamingChatCompletion(
	[{ role: 'user', content: 'Write a detailed review of this tool...' }],
	{ complexity: 'medium' },
	{ userId: user.id }
);

for await (const chunk of stream) {
	process.stdout.write(chunk.content);
	if (chunk.done) break;
}
```

### Provider-Specific Request

```typescript
// Force a specific provider
const result = await aiFacade.askJson(
	prompt,
	schema,
	{ modelOverride: 'claude-sonnet-4-20250514' },
	{ userId: user.id, providerId: 'anthropic' }
);
```

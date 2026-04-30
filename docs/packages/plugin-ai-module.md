---
id: plugin-ai-module
title: Plugin AI Module
sidebar_label: Plugin AI Module
sidebar_position: 5
---

# Plugin AI Module

The Plugin AI Module (`@ever-works/plugin/ai`) provides the core AI operations layer used by all AI provider plugins. Rather than each plugin interacting with LangChain directly, they delegate to the `AiOperations` class which wraps LangChain's `ChatOpenAI` and `OpenAIEmbeddings` with provider-agnostic error handling, token tracking, reasoning configuration, and automatic parameter retry logic.

## Package Overview

| Property         | Value                                                                         |
| ---------------- | ----------------------------------------------------------------------------- |
| **Import path**  | `@ever-works/plugin/ai`                                                       |
| **Location**     | `platform/packages/plugin/src/ai/`                                            |
| **Dependencies** | `@langchain/openai`, `@langchain/core`, `jsonrepair`, `zod`                   |
| **Used by**      | All AI provider plugins (OpenAI, Anthropic, Google, Groq, Ollama, OpenRouter) |

## Module Exports

```typescript
export { AiOperations, type AiOperationsConfig } from './ai-operations.js';
export { TokenUsageTracker, type TokenUsage } from './token-usage.tracker.js';
export {
	getReasoningConfig,
	getOpenAIReasoningConfig,
	getOpenRouterReasoningConfig,
	getGoogleReasoningConfig,
	getGroqReasoningConfig,
	extractModelName
} from './reasoning.utils.js';
export { jsonrepair } from 'jsonrepair';
```

## AiOperations Class

The central class that all AI provider plugins use for LLM interactions.

### Configuration

```typescript
interface AiOperationsConfig {
	apiKey: string;
	model: string;
	baseURL?: string;
	temperature?: number;
	maxTokens?: number;
	providerType: string; // 'openai' | 'anthropic' | 'google' | 'groq' | 'openrouter' | etc.
	embeddingModel?: string;
}
```

### Core Methods

| Method                                                     | Description                                  |
| ---------------------------------------------------------- | -------------------------------------------- |
| `createChatCompletion(options, configOverrides?)`          | Plain text chat completion                   |
| `askJson(prompt, schema, configOverrides?, options?)`      | Structured JSON output with Zod validation   |
| `createStreamingChatCompletion(options, configOverrides?)` | Async iterable streaming completion          |
| `createEmbedding(options, configOverrides?)`               | Document/text embeddings                     |
| `listModels(configOverrides?)`                             | List available models from provider API      |
| `testConnection(configOverrides?)`                         | Verify API connectivity with a simple prompt |
| `updateConfig(newConfig)`                                  | Update default configuration                 |

### Chat Completion

```typescript
const ops = new AiOperations({
	apiKey: 'sk-...',
	model: 'gpt-4',
	providerType: 'openai'
});

const response = await ops.createChatCompletion({
	messages: [
		{ role: 'system', content: 'You are a helpful assistant.' },
		{ role: 'user', content: 'What is TypeScript?' }
	],
	temperature: 0.7
});

// response.choices[0].message.content => "TypeScript is..."
// response.usage => { promptTokens: 25, completionTokens: 100, totalTokens: 125 }
```

### Structured JSON Output

The `askJson` method provides structured output with automatic fallback. It first attempts LangChain's `withStructuredOutput()` for native JSON mode, then falls back to raw text + `jsonrepair` + Zod parsing.

```typescript
import { z } from 'zod';

const ItemSchema = z.object({
	name: z.string(),
	description: z.string(),
	tags: z.array(z.string())
});

const { result, model, usage } = await ops.askJson('Generate an item about TypeScript', ItemSchema);
// result is typed according to the Zod schema
```

### Streaming

```typescript
for await (const chunk of ops.createStreamingChatCompletion({
	messages: [{ role: 'user', content: 'Tell me a story' }]
})) {
	process.stdout.write(chunk.choices[0].delta.content ?? '');
}
```

### Embeddings

```typescript
const { model, embeddings } = await ops.createEmbedding({
	input: ['document text here'],
	model: 'text-embedding-3-small'
});
// embeddings => [[0.123, -0.456, ...]]
```

## Automatic Parameter Retry

The `AiOperations` class maintains a per-model cache of rejected parameters. When a provider rejects an unsupported parameter (like `temperature` for reasoning models), the class automatically:

1. Parses the error message to identify the rejected parameter
2. Adds it to the per-model rejection cache
3. Retries the request without that parameter
4. Future requests for the same model skip the rejected parameter

**Detected parameter rejections:**

| Error Pattern                                         | Parameter Skipped   |
| ----------------------------------------------------- | ------------------- |
| `'temperature'`                                       | `temperature`       |
| `'reasoning'` or `'reasoning_effort'`                 | `reasoning`         |
| `json_schema`, `response_format`, `structured output` | `structured_output` |

## Token Usage Tracker

A LangChain `BaseCallbackHandler` that captures token usage in a provider-agnostic way. It inspects multiple field name conventions across providers.

```typescript
interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}
```

**Supported field mappings:**

| Standard Field | Alternative Names                                        |
| -------------- | -------------------------------------------------------- |
| `inputTokens`  | `promptTokens`, `prompt_tokens`, `input_tokens`          |
| `outputTokens` | `completionTokens`, `completion_tokens`, `output_tokens` |
| `totalTokens`  | `total_tokens`, computed as `input + output`             |

The tracker checks both `llmOutput.tokenUsage`, `llmOutput.estimatedTokenUsage`, and `generationInfo` paths.

## Reasoning Configuration

The `reasoning.utils.ts` module configures reasoning effort settings for models that support extended thinking, preventing unnecessary compute costs.

### Supported Reasoning Models

| Model Pattern                     | Provider Configs                                                 |
| --------------------------------- | ---------------------------------------------------------------- |
| `gpt-5.1+`                        | OpenAI: `effort: 'none'`, OpenRouter: `effort: 'none'`           |
| `gpt-5` (base)                    | OpenAI: `effort: 'minimal'`, OpenRouter: `effort: 'minimal'`     |
| `o1`, `o3`, `o4`                  | OpenAI: `effort: 'minimal'`, OpenRouter: `effort: 'minimal'`     |
| `gemini-2`, `gemini-3`            | Google: `reasoning_effort: 'none'`, OpenRouter: `effort: 'none'` |
| `claude-sonnet/opus-4+`           | OpenRouter: `effort: 'none'`                                     |
| `deepseek-r`, `deepseek-reasoner` | OpenRouter: `effort: 'low'`                                      |
| `gpt-oss`                         | Groq: `effort: 'low'`, `reasoning_format: 'hidden'`              |
| `qwen3`                           | Groq: `reasoning_effort: 'none'`                                 |

### Usage

```typescript
import { getReasoningConfig, extractModelName } from '@ever-works/plugin/ai';

const config = getReasoningConfig('openai', 'gpt-5');
// => { reasoning: { effort: 'minimal' } }

const name = extractModelName('openai/gpt-5.2');
// => 'gpt-5.2'
```

### Provider-Specific Getters

For backward compatibility, individual provider getters are available:

```typescript
getOpenAIReasoningConfig('o3'); // { reasoning: { effort: 'minimal' } }
getOpenRouterReasoningConfig('o3'); // { reasoning: { effort: 'minimal' } }
getGoogleReasoningConfig('gemini-2'); // { reasoning_effort: 'none' }
getGroqReasoningConfig('qwen3'); // { reasoning_effort: 'none' }
```

## Model Listing

The `listModels` method fetches available models from the provider's `/v1/models` endpoint:

```typescript
const models = await ops.listModels();
// Returns AiModel[] with id, name, capabilities, and pricing info
```

Each model includes capability flags:

| Capability                 | Default               |
| -------------------------- | --------------------- |
| `supportsStructuredOutput` | true                  |
| `supportsStreaming`        | true                  |
| `supportsToolCalling`      | true                  |
| `supportsVision`           | false                 |
| `maxContextLength`         | 128,000 (or from API) |
| `maxOutputTokens`          | from API              |

## Connection Testing

```typescript
const result = await ops.testConnection();
// { success: true, responseTime: 450 }
// or: { success: false, responseTime: 5000, error: 'Invalid API key' }
```

## File Structure

```
plugin/src/ai/
  index.ts                  # Public exports
  ai-operations.ts          # Core AiOperations class
  token-usage.tracker.ts    # LangChain callback for token tracking
  reasoning.utils.ts        # Reasoning effort configuration per model/provider
```

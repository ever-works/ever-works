---
id: testing-plugins
title: Testing Plugins
sidebar_label: Testing
sidebar_position: 14
---

# Testing Plugins

The `@ever-works/plugin` package provides a comprehensive testing toolkit in `@ever-works/plugin/testing`. It includes mock implementations of all platform services, a test harness for lifecycle testing, and contract test suites that verify plugins conform to their capability interfaces.

## Test Infrastructure

All plugins use **Vitest** as their test runner. Each plugin package has:

```
packages/plugins/my-plugin/
  src/
    __tests__/
      my-plugin.spec.ts
    my-plugin.plugin.ts
    index.ts
  package.json
  tsconfig.json
  tsup.config.ts
  vitest.config.ts
```

Run tests for a single plugin:

```bash
cd packages/plugins/my-plugin
pnpm test                    # Run all tests
pnpm test:watch              # Watch mode
pnpm test:coverage           # With coverage report
npx vitest run src/__tests__/my-plugin.spec.ts  # Single file
```

## Mock Plugin Context

The `createMockPluginContext()` function creates a fully functional mock of the `PluginContext` that plugins receive during `onLoad()`. Every service is mocked with working implementations:

```typescript
import { createMockPluginContext } from '@ever-works/plugin/testing';

const context = createMockPluginContext({
	pluginId: 'my-plugin',
	settings: {
		apiKey: 'test-key-123',
		defaultModel: 'test-model'
	},
	envVars: {
		NODE_ENV: 'test',
		PLUGIN_MY_API_KEY: 'env-key-456'
	}
});

// Use in tests
await myPlugin.onLoad(context);
```

### Mock Context Options

```typescript
interface MockPluginContextOptions {
	pluginId?: string; // Plugin ID (default: 'test-plugin')
	settings?: PluginSettings; // Pre-configured settings
	env?: MockPluginEnvironmentOptions; // Environment overrides
	envVars?: Record<string, string>; // Environment variables
	works?: Map<string, WorkInfo>; // Mock work data
	users?: Map<string, UserInfo>; // Mock user data
	currentUser?: UserInfo; // Current user for the session
	httpResponses?: Map<string, HttpResponse>; // Pre-configured HTTP responses
}
```

### What Gets Mocked

The mock context includes functional implementations of every platform service:

| Service                   | Mock Behavior                                                         |
| ------------------------- | --------------------------------------------------------------------- |
| **Logger**                | Records all log calls; accessible via `context.logger.log.mock.calls` |
| **Cache**                 | In-memory `Map` with TTL support                                      |
| **HTTP Client**           | Returns pre-configured responses by method + URL key                  |
| **Environment**           | Configurable platform version, environment flags, paths               |
| **Environment Variables** | In-memory variable store                                              |
| **Work Service**     | Lookup by ID or slug from provided `Map`                              |
| **User Service**          | Lookup by ID; returns configurable current user                       |
| **Events**                | Working event subscription and emission                               |
| **Custom Capabilities**   | Full registration and retrieval                                       |
| **Settings**              | Returns configured settings for any scope                             |

### Testing Event Handlers

The mock context exposes internal helpers for testing event-driven behavior:

```typescript
const context = createMockPluginContext();
await myPlugin.onLoad(context);

// Simulate an event from outside the plugin
context._triggerEvent('work.created', {
	workId: 'dir-123',
	timestamp: new Date().toISOString()
});

// Inspect registered handlers
const handlers = context._eventHandlers.get('work.created');
expect(handlers?.size).toBe(1);
```

### Testing HTTP Interactions

Pre-configure HTTP responses for specific endpoints:

```typescript
const httpResponses = new Map([
	[
		'GET:https://api.example.com/models',
		{
			status: 200,
			statusText: 'OK',
			headers: {},
			data: { models: [{ id: 'model-1', name: 'Test Model' }] }
		}
	],
	[
		'POST:https://api.example.com/chat',
		{
			status: 200,
			statusText: 'OK',
			headers: {},
			data: { id: 'resp-1', choices: [{ message: { content: 'Hello' } }] }
		}
	]
]);

const context = createMockPluginContext({ httpResponses });
```

## Mock Plugin Environment

Create environment configurations for different testing scenarios:

```typescript
import {
	createMockPluginEnvironment,
	createProductionEnvironment,
	createDevelopmentEnvironment
} from '@ever-works/plugin/testing';

// Default test environment
const testEnv = createMockPluginEnvironment();
// testEnv.isTest === true, testEnv.isDevelopment === true

// Production-like environment
const prodEnv = createProductionEnvironment();
// prodEnv.isProduction === true, prodEnv.baseUrl === 'https://example.com'

// Development environment
const devEnv = createDevelopmentEnvironment();
// devEnv.isDevelopment === true, devEnv.isTest === false

// Custom environment
const customEnv = createMockPluginEnvironment({
	platform: 'ever-works',
	platformVersion: '2.0.0',
	isProduction: false,
	features: new Set(['feature-flag-a', 'feature-flag-b']),
	baseUrl: 'http://localhost:3000',
	tempDir: '/tmp/test'
});
```

## Plugin Test Harness

The `PluginTestHarness` wraps a plugin with lifecycle management and assertion utilities:

```typescript
import { createTestHarness } from '@ever-works/plugin/testing';
import { MyPlugin } from '../my-plugin.plugin';

const plugin = new MyPlugin();
const harness = createTestHarness(plugin, {
	settings: { apiKey: 'test-key' }
});

// Lifecycle
await harness.load(); // Calls plugin.onLoad(mockContext)
await harness.unload(); // Calls plugin.onUnload()
harness.isLoaded; // Check load state

// Health check
const health = await harness.healthCheck();

// Run a named test
const result = await harness.test('should process items', async (h) => {
	h.assert(h.isLoaded, 'Plugin must be loaded');
	// ... test logic ...
});

// Built-in lifecycle tests
const lifecycleResults = await harness.testLifecycle();

// Get all test results
const suite = harness.getResults();
// { plugin: 'my-plugin', passed: 5, failed: 0, total: 5, ... }
```

### Assertion Methods

The harness provides assertion methods that work without a test framework:

```typescript
harness.assert(condition, 'message'); // Boolean assertion
harness.assertEqual(actual, expected, 'msg'); // Strict equality
harness.assertDeepEqual(actual, expected); // JSON deep equality
await harness.assertRejects(asyncFn, 'msg'); // Assert promise rejects
```

## Contract Tests

Contract test suites verify that a plugin correctly implements its capability interface. They check property types, method signatures, and basic behavior:

```typescript
import {
	testBasePluginContract,
	testAiProviderContract,
	testSearchContract,
	testGitProviderContract,
	testDeploymentContract,
	testScreenshotContract,
	testPipelineContract,
	testPipelineModifierContract,
	runContractTests // Auto-detects capabilities and runs all applicable suites
} from '@ever-works/plugin/testing';
```

### Base Plugin Contract Tests

Every plugin is tested for:

- Has a valid `id` (non-empty string)
- Has a valid `name` (non-empty string)
- Has a valid `version` (semver format)
- Has a valid `category` (one of `PLUGIN_CATEGORIES`)
- Has a `capabilities` array
- Has a `settingsSchema` object
- Implements `onLoad()` and `onUnload()` functions
- Successfully completes load/unload lifecycle

### Capability-Specific Contract Tests

Each capability adds additional checks:

**AI Provider** (`testAiProviderContract`):

- Has `ai-provider` capability
- Has `providerType` and `providerName` properties
- Implements `createChatCompletion()`, `listModels()`, `getCapabilities()`

**Search** (`testSearchContract`):

- Has `search` capability
- Has `providerName` property
- Implements `search()`, `isAvailable()`

**Pipeline** (`testPipelineContract`):

- Has `pipeline` capability
- Implements `getStepDefinitions()` returning a non-empty array
- Implements `execute()`
- Step definitions have valid `id`, `name`, and `position` fields

**Pipeline Modifier** (`testPipelineModifierContract`):

- Has `pipeline-modifier` capability
- Has non-empty `targetPipelines` array
- Implements `execute()`
- `getStepDefinition()` returns a valid definition

### Auto-Running Contract Tests

The `runContractTests()` function automatically detects a plugin's capabilities and runs all applicable test suites:

```typescript
import { runContractTests } from '@ever-works/plugin/testing';
import { MyPlugin } from '../my-plugin.plugin';

describe('MyPlugin contracts', () => {
	it('should pass all contract tests', async () => {
		const plugin = new MyPlugin();
		const results = await runContractTests(plugin);
		const failures = results.filter((r) => !r.passed);
		expect(failures).toEqual([]);
	});
});
```

## Writing Plugin Unit Tests

A typical plugin test file:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMockPluginContext } from '@ever-works/plugin/testing';
import { MySearchPlugin } from '../my-search.plugin';

describe('MySearchPlugin', () => {
	let plugin: MySearchPlugin;

	beforeEach(async () => {
		plugin = new MySearchPlugin();
		const context = createMockPluginContext({
			settings: { apiKey: 'test-key' }
		});
		await plugin.onLoad(context);
	});

	afterEach(async () => {
		await plugin.onUnload();
	});

	it('should have correct metadata', () => {
		expect(plugin.id).toBe('my-search');
		expect(plugin.category).toBe('search');
		expect(plugin.capabilities).toContain('search');
	});

	it('should return search results', async () => {
		const response = await plugin.search({
			query: 'test query',
			limit: 5,
			settings: { apiKey: 'test-key' }
		});

		expect(response.results).toBeDefined();
		expect(response.query).toBe('test query');
		expect(response.hasMore).toBeDefined();
	});

	it('should report availability', async () => {
		const available = await plugin.isAvailable();
		expect(typeof available).toBe('boolean');
	});

	it('should pass contract tests', async () => {
		const { runContractTests } = await import('@ever-works/plugin/testing');
		const results = await runContractTests(plugin);
		for (const result of results) {
			expect(result.passed).toBe(true);
		}
	});
});
```

## Integration Testing with Pipeline

To test a plugin's integration with the pipeline, create a minimal pipeline context:

```typescript
import { createMockPluginContext } from '@ever-works/plugin/testing';

// Test a pipeline modifier step
const modifier = new MyPipelineModifier();
await modifier.onLoad(createMockPluginContext());

const mockContext = {
	prompt: 'Test prompt',
	subject: 'test-subject',
	searchResults: [{ title: 'Result 1', url: 'https://example.com' }],
	shouldStop: false
};

const result = await modifier.execute(mockContext as any);
expect(result.customData).toBeDefined();
```

## Mock Function Utilities

The testing package includes a lightweight mock function implementation compatible with both Vitest and Jest:

```typescript
import { createMockFn } from '@ever-works/plugin/testing';

const mockFn = createMockFn<(x: number) => string>();
mockFn.mockReturnValue('hello');
mockFn.mockResolvedValue('async-hello');
mockFn.mockImplementation((x) => `value: ${x}`);

// Inspect calls
console.log(mockFn.mock.calls); // [[1], [2], [3]]
```

This is used internally by `createMockLogger()` and other mock factories, and can be used directly in plugin tests without importing from the test framework.

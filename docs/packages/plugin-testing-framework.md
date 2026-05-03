---
id: plugin-testing-framework
title: Plugin Testing Framework
sidebar_label: Plugin Testing Framework
sidebar_position: 9
---

# Plugin Testing Framework

The Plugin Testing Framework (`@ever-works/plugin/testing`) provides a complete test infrastructure for plugin development. It includes a test harness for loading and exercising plugins, mock implementations of all plugin runtime services, environment simulation utilities, and contract test suites that validate plugin implementations against the platform's capability interfaces.

## Package Overview

| Property         | Value                                    |
| ---------------- | ---------------------------------------- |
| **Import path**  | `@ever-works/plugin/testing`             |
| **Location**     | `platform/packages/plugin/src/testing/`  |
| **Dependencies** | Plugin contracts, plugin lifecycle types |
| **Used by**      | All plugin test suites                   |

## Module Exports

```typescript
export { PluginTestHarness } from './plugin-test-harness.js';
export {
	createMockPluginContext,
	createMockLogger,
	createMockCache,
	createMockHttpClient,
	createMockServices,
	createMockFn
} from './mock-plugin-context.js';
export {
	createMockPluginEnvironment,
	createMockEnvVars,
	createProductionEnvironment,
	createDevelopmentEnvironment
} from './mock-plugin-environment.js';
export {
	testBasePluginContract,
	testGitProviderContract,
	testDeploymentContract,
	testScreenshotContract,
	testSearchContract,
	testAiProviderContract,
	testPipelineContract,
	testPipelineModifierContract,
	runContractTests
} from './contract-tests.js';
```

## PluginTestHarness

The `PluginTestHarness` class provides a controlled environment for testing plugin lifecycle and behavior. It manages plugin loading, activation, deactivation, and provides built-in assertions.

### Creating a Harness

```typescript
import { PluginTestHarness } from '@ever-works/plugin/testing';
import { MyPlugin } from '../src/my-plugin';

const harness = new PluginTestHarness(MyPlugin);
```

### Lifecycle Methods

| Method           | Description                                     |
| ---------------- | ----------------------------------------------- |
| `load(context?)` | Instantiate the plugin and call `onLoad`        |
| `unload()`       | Call `onDeactivate` and clean up                |
| `healthCheck()`  | Run the plugin's health check and return result |

```typescript
// Full lifecycle test
const harness = new PluginTestHarness(MyPlugin);

await harness.load(mockContext);
const health = await harness.healthCheck();
// health => { healthy: true }

await harness.unload();
```

### Test Runner

The harness includes a built-in test runner that executes named test cases and collects results.

```typescript
const results = await harness.runTests([
	{
		name: 'should activate successfully',
		fn: async (plugin) => {
			await plugin.onActivate(mockContext);
			harness.assert(plugin.isActive(), 'Plugin should be active');
		}
	},
	{
		name: 'should handle missing settings',
		fn: async (plugin) => {
			const ctx = createMockPluginContext({ settings: {} });
			await harness.assertRejects(() => plugin.onActivate(ctx), 'Should throw on missing settings');
		}
	}
]);

// results => [
//   { name: 'should activate successfully', passed: true },
//   { name: 'should handle missing settings', passed: true },
// ]
```

### Built-in Assertions

| Assertion                                     | Description                                  |
| --------------------------------------------- | -------------------------------------------- |
| `assert(condition, message?)`                 | Assert a boolean condition is truthy         |
| `assertEqual(actual, expected, message?)`     | Assert strict equality (`===`)               |
| `assertDeepEqual(actual, expected, message?)` | Assert structural equality (deep comparison) |
| `assertRejects(fn, message?)`                 | Assert an async function throws an error     |

```typescript
harness.assert(result !== null, 'Result should not be null');
harness.assertEqual(result.status, 'success', 'Status should be success');
harness.assertDeepEqual(result.data, { id: '1', name: 'test' });
await harness.assertRejects(() => plugin.doInvalidThing());
```

### Lifecycle Tests

The harness provides a `runLifecycleTests` method that automatically tests the standard plugin lifecycle sequence:

```typescript
const lifecycleResults = await harness.runLifecycleTests(mockContext);
// Tests: load, activate, health check, deactivate, unload
```

## Mock Plugin Context

The `mock-plugin-context.ts` module provides factory functions for creating mock implementations of all plugin runtime services.

### createMockPluginContext

Creates a complete mock `PluginContext` with all services pre-configured.

```typescript
import { createMockPluginContext } from '@ever-works/plugin/testing';

const context = createMockPluginContext({
	settings: {
		apiKey: 'test-key',
		model: 'gpt-4'
	},
	workSettings: {
		model: 'gpt-3.5-turbo'
	},
	envVars: {
		NODE_ENV: 'test'
	}
});

// context.logger => mock logger
// context.cache => mock cache (Map-based)
// context.httpClient => mock HTTP client
// context.settings => { apiKey: 'test-key', model: 'gpt-4' }
```

### createMockLogger

Creates a mock logger that captures all log calls for assertion.

```typescript
import { createMockLogger } from '@ever-works/plugin/testing';

const logger = createMockLogger();
logger.info('Test message');
logger.error('Error occurred', { code: 500 });

// All methods available: trace, debug, info, warn, error, fatal
// Each captures calls for later inspection
```

### createMockCache

Creates an in-memory cache backed by a `Map` with TTL support.

```typescript
import { createMockCache } from '@ever-works/plugin/testing';

const cache = createMockCache();

await cache.set('key', 'value', 60); // TTL: 60 seconds
const value = await cache.get('key');
// value => 'value'

await cache.delete('key');
const deleted = await cache.get('key');
// deleted => undefined
```

**Cache Features:**

| Feature      | Behavior                                        |
| ------------ | ----------------------------------------------- |
| Storage      | In-memory `Map<string, { value, expiry }>`      |
| TTL          | Stored as `Date.now() + ttlSeconds * 1000`      |
| Expiry check | `get()` returns `undefined` for expired entries |
| `has()`      | Checks existence and expiry                     |
| `delete()`   | Removes entry from map                          |
| `clear()`    | Clears entire map                               |

### createMockHttpClient

Creates a mock HTTP client that returns configurable responses.

```typescript
import { createMockHttpClient } from '@ever-works/plugin/testing';

const httpClient = createMockHttpClient();

// Default: returns { status: 200, data: {} }
const response = await httpClient.get('https://api.example.com/data');
```

### createMockServices

Creates a complete set of mock platform services.

```typescript
import { createMockServices } from '@ever-works/plugin/testing';

const services = createMockServices();
// services.logger, services.cache, services.httpClient, etc.
```

### createMockFn

Creates a mock function compatible with both Jest and Vitest patterns.

```typescript
import { createMockFn } from '@ever-works/plugin/testing';

const fn = createMockFn();
fn('arg1', 'arg2');

// fn.calls => [['arg1', 'arg2']]
// fn.callCount => 1
```

## Mock Plugin Environment

The `mock-plugin-environment.ts` module provides utilities for simulating different runtime environments.

### createMockPluginEnvironment

Creates a complete mock environment with configurable properties.

```typescript
import { createMockPluginEnvironment } from '@ever-works/plugin/testing';

const env = createMockPluginEnvironment({
	nodeEnv: 'production',
	platform: 'linux',
	version: '1.5.0'
});
```

### createMockEnvVars

Creates a mock environment variables object with common defaults.

```typescript
import { createMockEnvVars } from '@ever-works/plugin/testing';

const envVars = createMockEnvVars({
	OPENAI_API_KEY: 'sk-test-key',
	DATABASE_URL: 'postgres://localhost/test'
});
// Also includes NODE_ENV: 'test' by default
```

### Preset Environments

| Function                         | NODE_ENV      | Debug   | Description                     |
| -------------------------------- | ------------- | ------- | ------------------------------- |
| `createProductionEnvironment()`  | `production`  | `false` | Simulates production deployment |
| `createDevelopmentEnvironment()` | `development` | `true`  | Simulates local development     |

## Contract Tests

The `contract-tests.ts` module provides reusable test suites that validate plugin implementations against the platform's capability interfaces. Each contract test suite ensures that a plugin correctly implements the methods, return types, and error handling required by its declared capabilities.

### Available Contract Test Suites

| Function                               | Tests                                            | Description                  |
| -------------------------------------- | ------------------------------------------------ | ---------------------------- |
| `testBasePluginContract(plugin)`       | `onLoad`, `onActivate`, `onDeactivate`, manifest | Core plugin lifecycle        |
| `testGitProviderContract(plugin)`      | clone, push, pull, branch, PR operations         | Git provider capability      |
| `testDeploymentContract(plugin)`       | deploy, status, rollback                         | Deployment capability        |
| `testScreenshotContract(plugin)`       | capture, format options                          | Screenshot capability        |
| `testSearchContract(plugin)`           | search, results format, pagination               | Search capability            |
| `testAiProviderContract(plugin)`       | chat, streaming, embeddings, models              | AI provider capability       |
| `testPipelineContract(plugin)`         | execute, step handling, status reporting         | Pipeline capability          |
| `testPipelineModifierContract(plugin)` | modify, transform, validate                      | Pipeline modifier capability |

### Running Contract Tests

```typescript
import { testBasePluginContract, testAiProviderContract } from '@ever-works/plugin/testing';

describe('MyAiPlugin', () => {
	const plugin = new MyAiPlugin();
	const context = createMockPluginContext({ settings: testSettings });

	testBasePluginContract(plugin);
	testAiProviderContract(plugin);
});
```

### runContractTests

A convenience function that automatically detects a plugin's declared capabilities and runs all applicable contract test suites.

```typescript
import { runContractTests } from '@ever-works/plugin/testing';

const results = await runContractTests(plugin, mockContext);
// Automatically runs base + capability-specific contract tests
// results => { passed: 15, failed: 0, skipped: 2, details: [...] }
```

## Testing Patterns

### Full Plugin Integration Test

```typescript
import { PluginTestHarness, createMockPluginContext, testBasePluginContract } from '@ever-works/plugin/testing';

describe('GitHubPlugin', () => {
	let harness: PluginTestHarness;
	let context: PluginContext;

	beforeEach(() => {
		harness = new PluginTestHarness(GitHubPlugin);
		context = createMockPluginContext({
			settings: { token: 'ghp_test', defaultOrg: 'test-org' }
		});
	});

	afterEach(async () => {
		await harness.unload();
	});

	testBasePluginContract(new GitHubPlugin());

	it('should clone a repository', async () => {
		await harness.load(context);
		const plugin = harness.getPlugin();
		const dir = await plugin.cloneRepository('owner', 'repo');
		harness.assert(dir !== null, 'Should return work path');
	});
});
```

## File Structure

```
plugin/src/testing/
  index.ts                      # Public exports
  plugin-test-harness.ts        # PluginTestHarness class
  mock-plugin-context.ts        # Mock context, logger, cache, HTTP, services
  mock-plugin-environment.ts    # Mock environments and env vars
  contract-tests.ts             # Capability contract test suites
```

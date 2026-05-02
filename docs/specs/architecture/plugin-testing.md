# Architecture: Plugin Testing Framework

**Status**: `Active`
**Last updated**: 2026-05-02
**Audience**: AI agents and engineers writing tests for new plugins,
debugging plugin-test failures, or extending the contract-test suite.

---

## 1. Purpose

Every plugin in `packages/plugins/` is a standalone npm package with
its own Vitest suite. Without shared infrastructure, every plugin
would re-invent how to mock `PluginContext`, how to test capability
contracts, and how to set up a test harness — and the platform would
end up with 39 incompatible test styles. The
**`@ever-works/plugin/testing`** sub-export solves that with a small,
deliberately-tight set of helpers every plugin uses.

This spec covers the **testing exports**, the **`PluginTestHarness`
runner**, the **`createMockPluginContext` factory**, the
**`createMockPluginEnvironment` factory**, and the **capability
contract tests** every plugin runs to prove it implements its
declared capabilities correctly.

## 2. Module Layout

```
packages/plugin/src/testing/
├── index.ts                      # Public surface
├── plugin-test-harness.ts        # Test runner that drives lifecycle
├── mock-plugin-context.ts        # Fake PluginContext factory
├── mock-plugin-environment.ts    # Fake PluginEnvironment factory
└── contract-tests.ts             # Per-capability contract suites
```

The package's `package.json` exposes the subpath:

```json
{
	"exports": {
		"./testing": {
			"types": "./dist/testing/index.d.ts",
			"import": "./dist/testing/index.js",
			"require": "./dist/testing/index.cjs"
		}
	}
}
```

Plugins import:

```ts
import { PluginTestHarness, createMockPluginContext, runAiProviderContractTests } from '@ever-works/plugin/testing';
```

## 3. The `PluginTestHarness`

The harness drives a plugin through its lifecycle in test code without
booting the platform. Per
[plugin-sdk §10](./plugin-sdk.md):

```ts
export class PluginTestHarness {
	constructor(plugin: IPlugin, options?: PluginTestHarnessOptions);

	// Lifecycle
	init(): Promise<void>; // calls plugin.onInit(ctx)
	enable(): Promise<void>; // calls plugin.onEnable(ctx)
	disable(): Promise<void>; // calls plugin.onDisable(ctx)
	settingsUpdate(s: PluginSettings): Promise<void>; // calls plugin.onSettingsUpdated
	healthCheck(): Promise<PluginHealthCheck>;

	// Inspection
	context(): PluginContext; // returns the in-memory mock context
	settings(): PluginSettings; // returns current settings
	cache(): MockCache; // returns the in-memory cache
	events(): MockEventEmitter; // returns the captured events
	httpClient(): MockHttpClient; // returns the recorded HTTP calls

	// Capability invocation
	asAiProvider(): IAiProviderPlugin;
	asSearchProvider(): ISearchPlugin;
	asContentExtractor(): IContentExtractorPlugin;
	asScreenshotProvider(): IScreenshotPlugin;
	asGitProvider(): IGitProviderPlugin;
	asDeployProvider(): IDeploymentPlugin;
	asPipelineStep(): IPipelinePlugin;
	asPipelineModifier(): IPipelineModifierPlugin;
	asFormSchemaProvider(): IFormSchemaProviderPlugin;
	asPromptProvider(): IPromptProviderPlugin;
	asOauthProvider(): IOAuthPlugin;
	asDeviceAuthProvider(): IDeviceAuthProviderPlugin;
	asDataSourceProvider(): IDataSourcePlugin;
}
```

Every plugin test starts the same way:

```ts
import { describe, it, beforeEach, expect } from 'vitest';
import { PluginTestHarness } from '@ever-works/plugin/testing';
import { OpenAiPlugin } from '../src/openai.plugin';

describe('OpenAi plugin', () => {
	let harness: PluginTestHarness;

	beforeEach(async () => {
		harness = new PluginTestHarness(new OpenAiPlugin(), {
			settings: {
				apiKey: 'sk-test-1234',
				defaultModel: 'gpt-5.1'
			}
		});
		await harness.init();
		await harness.enable();
	});

	it('returns a valid health check', async () => {
		const health = await harness.healthCheck();
		expect(health.status).toBe('healthy');
	});
});
```

## 4. `createMockPluginContext`

The harness uses `createMockPluginContext(options?)` under the hood.
Plugins can also call it directly when they want finer control over
the context they pass into specific methods:

```ts
const ctx = createMockPluginContext({
    settings: { apiKey: 'sk-test' },
    env: {
        PLUGIN_OPENAI_API_KEY: 'sk-env',
    },
    httpResponses: [
        { url: /api\.openai\.com/, status: 200, body: { choices: [...] } },
    ],
});
```

The mock context provides:

| Capability    | Mock implementation                                          |
| ------------- | ------------------------------------------------------------ |
| `logger`      | `console`-shaped, captures lines for assertion               |
| `cache`       | In-memory `Map` with TTL emulation                           |
| `http`        | Fetch shim returning canned responses; records every request |
| `events`      | In-memory emitter with `.captured()` for assertions          |
| `settings`    | `ISettingsAccessor` reading from the seeded `settings` map   |
| `env`         | `PluginEnvironment` reading from the seeded `env` map        |
| `directoryId` | Configurable                                                 |
| `userId`      | Configurable                                                 |

This means plugin tests **don't need a database, don't need an
HTTP server, don't need a NestJS application context** — just Vitest +
the harness.

## 5. `createMockPluginEnvironment`

Some plugin paths take a `PluginEnvironment` directly (e.g. when
checking `x-envVar` fallbacks). The factory:

```ts
const env = createMockPluginEnvironment({
	PLUGIN_OPENAI_API_KEY: 'sk-test',
	PLUGIN_OPENAI_BASE_URL: 'https://api.example.com/v1'
});

env.get('PLUGIN_OPENAI_API_KEY'); // 'sk-test'
env.get('UNRELATED_ENV'); // undefined — read denylist enforced
```

The mock enforces the same allowlist real `PluginEnvironment` does:
only env vars matching `PLUGIN_<plugin-id>_*` plus the small infra
allowlist. Tests that ask for `process.env` directly fail — keeping
plugins honest about which env vars they touch.

## 6. The Contract Test Suites

`contract-tests.ts` exports per-capability suites every plugin
implementing that capability runs. The pattern:

```ts
import { runAiProviderContractTests } from '@ever-works/plugin/testing';
import { describe } from 'vitest';
import { OpenAiPlugin } from '../src/openai.plugin';

describe('OpenAi plugin (contract)', () => {
	runAiProviderContractTests(() => new OpenAiPlugin(), {
		validApiKey: 'sk-test'
	});
});
```

Each contract suite asserts the plugin satisfies the capability's
behavioural contract:

| Capability             | Contract suite                       | What it asserts                                                                                                    |
| ---------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `ai-provider`          | `runAiProviderContractTests`         | `chatCompletion` shape, `askJson` round-trips, `embeddings` returns Float32, `validateConnection` per-tier results |
| `search`               | `runSearchProviderContractTests`     | `search(query)` returns `SearchResult[]`, pagination respected, error mapping                                      |
| `content-extractor`    | `runContentExtractorContractTests`   | `extract(url)` returns `{title, content, ...}`, handles 404s, respects timeouts                                    |
| `screenshot`           | `runScreenshotProviderContractTests` | `capture(url)` returns image buffer + metadata                                                                     |
| `git-provider`         | `runGitProviderContractTests`        | Repository CRUD, file content roundtrip, PR ops, branch listing                                                    |
| `deployment`           | `runDeploymentContractTests`         | Deploy returns site URL; domains add/remove/verify cycle                                                           |
| `pipeline`             | `runPipelinePluginContractTests`     | `run(input, ctx)` returns expected step output                                                                     |
| `pipeline-modifier`    | `runPipelineModifierContractTests`   | `before`/`after`/`replace` hooks fire correctly                                                                    |
| `form-schema-provider` | `runFormSchemaProviderContractTests` | Schema validates with Ajv; `x-*` extensions present                                                                |
| `prompt-provider`      | `runPromptProviderContractTests`     | `getPrompt(name, label)` resolves to non-empty string                                                              |
| `oauth`                | `runOAuthProviderContractTests`      | Authorisation URL contains state, code exchange returns tokens                                                     |
| `device-auth-provider` | `runDeviceAuthProviderContractTests` | `start` returns code, `poll` eventually returns tokens                                                             |
| `data-source`          | `runDataSourceContractTests`         | Query returns paginated data; schema is stable                                                                     |

The contract tests aren't integration tests — they call the plugin
through its declared interface against the mock context and assert
the response shape. Real upstream calls happen in **plugin-specific
integration tests** the plugin owner writes alongside the contract
tests.

## 7. Capability-Specific Mocks

Beyond the generic context, the testing module provides
capability-specific helpers:

| Helper                              | Used by                                                |
| ----------------------------------- | ------------------------------------------------------ |
| `mockHttpResponse(url, body)`       | Search / extractor / screenshot / data-source plugins  |
| `mockOAuthFlow({ token, profile })` | OAuth plugins — short-circuits the full redirect dance |
| `mockGitRepository({ files })`      | Git provider plugins — emulates a remote repo          |
| `mockAiResponse(prompt → answer)`   | Chains + agents that use AI internally                 |
| `mockStripeWebhook(event)`          | Used by the `subscriptions` test suite specifically    |

These keep plugin tests at the **unit** level — no flaky external API
calls, no rate limits, no network. Integration tests that hit real
upstreams live in `<plugin>/test/integration/` and run only on
demand (`pnpm test:integration`) so CI stays fast.

## 8. Settings Schema Validation

Every plugin runs the schema validator at test time:

```ts
import { validateSettingsSchema } from '@ever-works/plugin/testing';
import { OpenAiPlugin } from '../src/openai.plugin';

describe('OpenAi plugin settings', () => {
	it('has a valid JSON Schema', () => {
		const plugin = new OpenAiPlugin();
		const result = validateSettingsSchema(plugin.settingsSchema);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});
});
```

`validateSettingsSchema` uses Ajv with the `x-*` extensions
registered. It catches:

- Missing `type` on properties.
- Invalid `x-secret` / `x-envVar` / `x-showIf` shapes.
- Missing `required` referencing non-existent fields.
- Conflicting `x-requiredGroups`.

Bad schemas fail fast at test time rather than rendering an unusable
form in the dashboard.

## 9. Testing Lifecycle Hooks

The harness exposes hook calls so tests can verify cleanup:

```ts
it('disables cleanly', async () => {
	await harness.init();
	await harness.enable();
	expect(harness.cache().size).toBeGreaterThan(0); // Plugin warmed cache
	await harness.disable();
	expect(harness.cache().size).toBe(0); // Plugin cleaned up
});
```

Plugins that hold onto resources (HTTP agents, timers, file handles)
must release them in `onDisable`. The harness exposes the cache /
events / http mocks so tests can assert this.

## 10. Settings Update Tests

The harness's `settingsUpdate(...)` hook lets tests verify a plugin
re-reads settings correctly:

```ts
it('refreshes its API key on settings change', async () => {
    await harness.enable();
    await harness.settingsUpdate({ apiKey: 'sk-new-1234' });
    const calls = harness.httpClient().recorded();
    // Next chatCompletion uses the new key
    await harness.asAiProvider().chatCompletion({...});
    expect(harness.httpClient().lastCall().headers.Authorization).toContain('sk-new-1234');
});
```

This is the canonical way to test the
[`settings-system §10`](./settings-system.md) `onSettingsUpdated`
contract.

## 11. CI Integration

Every plugin's CI step runs:

1. `tsc -p tsconfig.json --noEmit` — type check.
2. `vitest run` — unit + contract tests against mocks.
3. `validateSettingsSchema(plugin.settingsSchema)` — schema sanity check.
4. (optional, gated) `vitest run --config vitest.integration.config.ts`
   — integration tests against real upstreams. Requires upstream
   credentials in CI secrets; runs nightly or on demand only.

A plugin that fails any of 1–3 fails CI. Step 4 is informational —
upstream API drift shouldn't block a unit-test-passing PR.

## 12. Adding a New Plugin

The minimum file set:

```
packages/plugins/<my-plugin>/
├── package.json                   # everworks.plugin block + Vitest
├── tsconfig.json
├── tsup.config.ts
├── src/
│   ├── index.ts                   # The plugin export
│   ├── <my>.plugin.ts             # The IPlugin implementation
│   └── settings.schema.ts         # JSON Schema (or inline in the plugin)
└── test/
    ├── plugin.spec.ts             # Smoke + lifecycle
    ├── contract.spec.ts           # runXContractTests(...)
    └── settings.spec.ts           # validateSettingsSchema(...)
```

`pnpm --filter @ever-works/<my-plugin> test` runs the suite. If it
passes, the plugin is ready for review.

## 13. Constitution Reconciliation

| Principle                   | How plugin testing respects it                                                         |
| --------------------------- | -------------------------------------------------------------------------------------- |
| I — Plugin-first            | The testing module is part of the SDK that every plugin builds against.                |
| II — Capability-driven      | Contract suites are per-capability — proves every plugin satisfies the same contract.  |
| III — Source-of-truth repos | Tests don't touch user repos; mock git provider emulates them.                         |
| IV — Trigger.dev            | Tests run synchronously in Vitest; no Trigger.dev involvement.                         |
| V — Forward-only migrations | N/A.                                                                                   |
| VI — Tests                  | This spec is the canonical implementation site for Principle VI for plugins.           |
| VII — Secret hygiene        | Mock env enforces the `PLUGIN_<id>_*` allowlist; secrets stay scoped.                  |
| VIII — Plugin counts        | Every plugin has a test suite — so a count of plugins-with-tests equals total plugins. |
| IX — Behaviour-first        | Contract tests assert observable behaviour, not implementation.                        |
| X — Backwards-compat        | Adding a new capability adds a new contract suite without touching existing ones.      |

## 14. References

- Source:
    - `packages/plugin/src/testing/`
    - `packages/plugin/src/testing/plugin-test-harness.ts`
    - `packages/plugin/src/testing/contract-tests.ts`
    - Example plugin tests under `packages/plugins/openai/test/` etc.
- Related specs:
    - [`plugin-sdk`](./plugin-sdk.md)
    - [`settings-system`](./settings-system.md)
- User docs: [`docs/plugin-system/testing-plugins.md`](../../plugin-system/testing-plugins.md)

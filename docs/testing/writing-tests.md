---
id: writing-tests
title: Writing Tests
sidebar_label: Writing Tests
sidebar_position: 2
---

# Writing Tests

This guide covers patterns and conventions for writing tests in the Ever Works platform, with examples from the actual codebase.

## Testing NestJS Services

Most agent package services are tested using NestJS's `Test.createTestingModule`. The pattern is:

1. Create mock implementations of dependencies.
2. Build a testing module with the service under test and mock providers.
3. Get the service instance from the compiled module.
4. Assert behavior.

### Example: Testing PluginRegistryService

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginRegistryService } from '../services/plugin-registry.service';
import { WorkPluginRepository } from '../repositories/work-plugin.repository';
import { UserPluginRepository } from '../repositories/user-plugin.repository';

describe('PluginRegistryService', () => {
	let service: PluginRegistryService;
	let eventEmitter: EventEmitter2;
	let workPluginRepository: jest.Mocked<WorkPluginRepository>;

	beforeEach(async () => {
		workPluginRepository = {
			findByWorkAndPlugin: jest.fn()
		} as unknown as jest.Mocked<WorkPluginRepository>;

		const module: TestingModule = await Test.createTestingModule({
			providers: [
				PluginRegistryService,
				{
					provide: EventEmitter2,
					useValue: { emit: jest.fn(), on: jest.fn(), off: jest.fn() }
				},
				{
					provide: WorkPluginRepository,
					useValue: workPluginRepository
				},
				{
					provide: UserPluginRepository,
					useValue: { findByUserAndPlugin: jest.fn() }
				}
			]
		}).compile();

		service = module.get<PluginRegistryService>(PluginRegistryService);
		eventEmitter = module.get<EventEmitter2>(EventEmitter2);
	});

	afterEach(() => {
		service.clear();
	});

	it('should register a plugin', () => {
		const plugin = createMockPlugin('test-plugin');
		service.register(plugin, createMockManifest('test-plugin'));
		expect(service.get('test-plugin')).toBe(plugin);
	});
});
```

### Key Patterns

- **`jest.Mocked<T>`** types mock objects so TypeScript understands mocked methods.
- **`as unknown as jest.Mocked<T>`** casts partial mocks (only the methods your tests need).
- **`afterEach` cleanup** ensures test isolation by resetting service state.
- **`Test.createTestingModule`** wires up the NestJS DI container for the service under test.

## Testing Pure Functions

Functions without NestJS dependencies are tested directly without the testing module. This is faster and simpler.

### Example: Testing Pair Selection

```typescript
import { selectNextPair, buildPairKey, countRemainingPairs } from '../pair-selector';
import type { ItemData } from '@ever-works/contracts';

function makeItem(slug: string, category: string): ItemData {
	return {
		name: slug.charAt(0).toUpperCase() + slug.slice(1),
		description: `Description of ${slug}`,
		source_url: `https://${slug}.example.com`,
		category,
		slug,
		tags: []
	};
}

describe('buildPairKey', () => {
	it('should produce consistent order-independent keys', () => {
		expect(buildPairKey('vercel', 'netlify')).toBe('netlify--vercel');
		expect(buildPairKey('netlify', 'vercel')).toBe('netlify--vercel');
	});
});

describe('selectNextPair', () => {
	const items = [makeItem('vercel', 'hosting'), makeItem('netlify', 'hosting'), makeItem('cloudflare', 'hosting')];

	it('should return the first available pair when none generated', () => {
		const result = selectNextPair({
			items,
			generatedPairs: [],
			minItemsForComparison: 3,
			maxComparisons: 50
		});
		expect(result).not.toBeNull();
		expect(result!.itemA.slug).toBeDefined();
	});

	it('should skip already-generated pairs', () => {
		const first = selectNextPair({
			items,
			generatedPairs: ['cloudflare--vercel'],
			minItemsForComparison: 3,
			maxComparisons: 50
		});
		const key = buildPairKey(first!.itemA.slug, first!.itemB.slug);
		expect(key).not.toBe('cloudflare--vercel');
	});
});
```

## Creating Mock Helpers

Define reusable factory functions for test entities:

```typescript
const createMockPlugin = (id: string, category = 'utility'): IPlugin =>
	({
		id,
		name: `Plugin ${id}`,
		version: '1.0.0',
		category,
		capabilities: ['test-capability'],
		settingsSchema: { type: 'object', properties: {} },
		configurationMode: 'hybrid',
		onLoad: jest.fn(),
		onUnload: jest.fn()
	}) as unknown as IPlugin;

const createMockManifest = (id: string, category = 'utility'): PluginManifest => ({
	id,
	name: `Plugin ${id}`,
	version: '1.0.0',
	description: 'Test plugin',
	category,
	capabilities: ['test-capability']
});
```

Place these at the top of the test file or in a shared `__tests__/helpers/` work if used across multiple test suites.

## Mocking Facades and Repositories

The agent package uses the facade pattern to abstract external services. Tests mock at the facade boundary:

```typescript
// Mock GitFacadeService
const mockGitFacade = {
	cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
	add: jest.fn().mockResolvedValue(undefined),
	commit: jest.fn().mockResolvedValue(undefined),
	push: jest.fn().mockResolvedValue(undefined)
};

// Mock AiFacadeService
const mockAiFacade = {
	askJson: jest.fn().mockResolvedValue({
		result: { items: [] },
		usage: { totalTokens: 100 },
		cost: 0.001
	}),
	createChatCompletion: jest.fn().mockResolvedValue({
		choices: [{ message: { content: 'AI response' } }]
	})
};

// Mock Repository
const mockWorkRepository = {
	findById: jest.fn().mockResolvedValue(mockWork),
	update: jest.fn().mockResolvedValue(undefined),
	increment: jest.fn().mockResolvedValue(undefined)
};
```

## Test File Location

Test files are co-located with their source code in `__tests__/` works:

```
packages/agent/src/
  plugins/
    services/
      plugin-registry.service.ts
    __tests__/
      plugin-registry.service.spec.ts
      plugin-settings.service.spec.ts
  comparison-generator/
    comparison/
      pair-selector.ts
      __tests__/
        pair-selector.spec.ts
  facades/
    git.facade.ts
    __tests__/
      git.facade.spec.ts
```

## Testing Plugin Packages (Vitest)

Plugin tests use Vitest with the `globals: true` option, so `describe`, `it`, and `expect` are available without imports:

```typescript
// packages/plugins/openai/src/openai.spec.ts
describe('OpenAI Plugin', () => {
	it('should have correct metadata', () => {
		expect(plugin.id).toBe('openai');
		expect(plugin.category).toBe('ai-provider');
	});
});
```

Run a single plugin's tests:

```bash
cd packages/plugins/openai
npx vitest run src/openai.spec.ts
```

## Common Gotchas

1. **Import resolution errors** -- If tests fail with module-not-found errors, ensure workspace packages are built: `pnpm build` from root.
2. **Async service initialization** -- Some services implement `OnModuleInit`. Use `module.init()` in tests if you need lifecycle hooks to run.
3. **Mocking TypeORM repositories** -- Only mock the repository methods your test actually calls. Use `as unknown as jest.Mocked<T>` for partial mocks.
4. **ESM `.js` imports** -- The Jest `moduleNameMapper` handles `.js` to `.ts` resolution. If a new pattern fails, check the mapper config.

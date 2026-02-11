import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { BaseAiProvider } from '../base-ai-provider.js';
import { AiOperations } from '../../ai/ai-operations.js';
import type { PluginContext } from '../../contracts/plugin-context.interface.js';
import type {
	ChatCompletionOptions,
	ChatCompletionResponse,
	AiModel
} from '../../contracts/capabilities/ai-provider.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';

vi.mock('../../ai/ai-operations.js', () => {
	const MockAiOperations = vi.fn().mockImplementation(() => ({
		createChatCompletion: vi.fn(),
		askJson: vi.fn().mockResolvedValue({ result: { name: 'test' }, model: 'test-model', usage: undefined }),
		listModels: vi.fn().mockResolvedValue([]),
		testConnection: vi.fn().mockResolvedValue({ success: true })
	}));
	return { AiOperations: MockAiOperations };
});

// Concrete implementation for testing
class TestAiProvider extends BaseAiProvider {
	readonly id = 'test-provider';
	readonly name = 'Test Provider';
	readonly version = '1.0.0';
	readonly providerType = 'openai';
	readonly providerName = 'Test';
	readonly settingsSchema = { type: 'object' as const, properties: {} };

	protected getDefaultModelId(): string {
		return 'test-model';
	}

	async onLoad(context: PluginContext): Promise<void> {
		await super.onLoad(context);
		this.aiOps = new AiOperations({
			apiKey: '',
			model: 'test-model',
			temperature: 0.7,
			providerType: 'openai'
		});
		context.logger.log('Test Provider loaded');
	}

	async onUnload(): Promise<void> {
		this.aiOps = null;
		await super.onUnload();
	}

	async createChatCompletion(_options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
		return { id: 'test', model: 'test-model', choices: [], created: 0 };
	}

	async listModels(_settings?: PluginSettings): Promise<readonly AiModel[]> {
		return [];
	}
}

describe('BaseAiProvider.askJson', () => {
	let provider: TestAiProvider;

	const createMockContext = (): PluginContext =>
		({
			pluginId: 'test-provider',
			logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
			getSettings: vi.fn().mockResolvedValue({})
		}) as unknown as PluginContext;

	beforeEach(() => {
		vi.clearAllMocks();
		provider = new TestAiProvider();
	});

	it('should pass Zod schema directly to AiOperations.askJson', async () => {
		await provider.onLoad(createMockContext());
		const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

		const schema = z.object({ name: z.string() });
		await provider.askJson('Generate JSON', { schema, settings: { apiKey: 'test-key' } });

		expect(aiOpsInstance.askJson).toHaveBeenCalledWith(
			'Generate JSON',
			schema,
			expect.objectContaining({ apiKey: 'test-key' }),
			expect.any(Object)
		);
	});

	it('should use z.object({}) as default when no schema provided', async () => {
		await provider.onLoad(createMockContext());
		const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

		await provider.askJson('Generate JSON');

		const passedSchema = aiOpsInstance.askJson.mock.calls[0][1];
		// Default should be a Zod object schema that accepts empty objects
		expect(passedSchema).toBeDefined();
		expect(passedSchema._def).toBeDefined();
		const parsed = passedSchema.safeParse({});
		expect(parsed.success).toBe(true);
	});

	it('should throw when plugin not loaded', async () => {
		await expect(provider.askJson('test')).rejects.toThrow('Plugin not loaded');
	});

	it('should pass model override to config', async () => {
		await provider.onLoad(createMockContext());
		const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

		await provider.askJson('Generate JSON', { model: 'custom-model' });

		expect(aiOpsInstance.askJson).toHaveBeenCalledWith(
			'Generate JSON',
			expect.any(Object),
			expect.objectContaining({ model: 'custom-model' }),
			expect.any(Object)
		);
	});

	it('should pass temperature and maxTokens as options', async () => {
		await provider.onLoad(createMockContext());
		const aiOpsInstance = (AiOperations as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;

		await provider.askJson('Generate JSON', { temperature: 0.5, maxTokens: 1000 });

		expect(aiOpsInstance.askJson).toHaveBeenCalledWith('Generate JSON', expect.any(Object), expect.any(Object), {
			temperature: 0.5,
			maxTokens: 1000
		});
	});
});

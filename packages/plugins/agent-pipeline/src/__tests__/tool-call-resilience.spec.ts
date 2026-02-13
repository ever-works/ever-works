import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isToolCallingError, withToolCallingRetry } from '../utils/tool-call-resilience';
import { NoSuchToolError, InvalidToolInputError, APICallError } from 'ai';

describe('isToolCallingError', () => {
	it('recognizes NoSuchToolError', () => {
		const error = new NoSuchToolError({
			toolName: 'commentary',
			availableTools: ['bash', 'search']
		});
		expect(isToolCallingError(error)).toBe(true);
	});

	it('recognizes InvalidToolInputError', () => {
		const error = new InvalidToolInputError({
			toolName: 'bash',
			toolInput: '{bad json',
			cause: new Error('parse error')
		});
		expect(isToolCallingError(error)).toBe(true);
	});

	it('recognizes APICallError with "parsing failed" message', () => {
		const error = new APICallError({
			message: 'Tool call validation failed: Parsing failed',
			url: 'https://api.example.com',
			requestBodyValues: {}
		});
		expect(isToolCallingError(error)).toBe(true);
	});

	it('recognizes APICallError with "tool call validation" message', () => {
		const error = new APICallError({
			message: 'Tool call validation failed for tool xyz',
			url: 'https://api.example.com',
			requestBodyValues: {}
		});
		expect(isToolCallingError(error)).toBe(true);
	});

	it('recognizes APICallError with "not in request.tools" message', () => {
		const error = new APICallError({
			message: 'Tool "commentary" not in request.tools',
			url: 'https://api.example.com',
			requestBodyValues: {}
		});
		expect(isToolCallingError(error)).toBe(true);
	});

	it('recognizes APICallError with "failed to call a function" message (Groq)', () => {
		const error = new APICallError({
			message: "Failed to call a function. Please adjust your prompt. See 'failed_generation' for more details.",
			url: 'https://api.groq.com/openai/v1/chat/completions',
			requestBodyValues: {}
		});
		expect(isToolCallingError(error)).toBe(true);
	});

	it('recognizes generic Error with tool error pattern in message', () => {
		const error = new Error('Tool call validation error occurred');
		expect(isToolCallingError(error)).toBe(true);
	});

	it('rejects generic Error without tool error pattern', () => {
		const error = new Error('Network timeout');
		expect(isToolCallingError(error)).toBe(false);
	});

	it('rejects APICallError with unrelated message', () => {
		const error = new APICallError({
			message: 'Rate limit exceeded',
			url: 'https://api.example.com',
			requestBodyValues: {},
			statusCode: 429
		});
		expect(isToolCallingError(error)).toBe(false);
	});

	it('rejects non-Error values', () => {
		expect(isToolCallingError('some string')).toBe(false);
		expect(isToolCallingError(null)).toBe(false);
		expect(isToolCallingError(undefined)).toBe(false);
		expect(isToolCallingError(42)).toBe(false);
	});
});

describe('withToolCallingRetry', () => {
	const mockLogger = {
		log: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn()
	};

	const baseOptions = {
		providerName: 'test-provider',
		modelName: 'test-model',
		logger: mockLogger
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('succeeds on first attempt', async () => {
		const fn = vi.fn().mockResolvedValue('result');

		const result = await withToolCallingRetry(fn, baseOptions);

		expect(result).toBe('result');
		expect(fn).toHaveBeenCalledTimes(1);
		expect(mockLogger.warn).not.toHaveBeenCalled();
	});

	it('retries on tool-calling error and succeeds', async () => {
		const toolError = new NoSuchToolError({
			toolName: 'commentary',
			availableTools: ['bash']
		});

		const fn = vi.fn().mockRejectedValueOnce(toolError).mockResolvedValueOnce('recovered');

		const result = await withToolCallingRetry(fn, {
			...baseOptions,
			maxRetries: 2
		});

		expect(result).toBe('recovered');
		expect(fn).toHaveBeenCalledTimes(2);
		expect(mockLogger.warn).toHaveBeenCalledTimes(1);
	});

	it('exhausts retries and throws enhanced error', async () => {
		const toolError = new NoSuchToolError({
			toolName: 'commentary',
			availableTools: ['bash']
		});

		const fn = vi.fn().mockRejectedValue(toolError);

		await expect(
			withToolCallingRetry(fn, {
				...baseOptions,
				maxRetries: 1
			})
		).rejects.toThrow(/failed after 2 attempts/);

		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('includes provider and model name in enhanced error', async () => {
		const toolError = new NoSuchToolError({
			toolName: 'foo',
			availableTools: ['bar']
		});

		const fn = vi.fn().mockRejectedValue(toolError);

		await expect(
			withToolCallingRetry(fn, {
				...baseOptions,
				providerName: 'groq',
				modelName: 'openai/gpt-oss-120b',
				maxRetries: 0
			})
		).rejects.toThrow(/openai\/gpt-oss-120b.*groq/);
	});

	it('does not retry non-tool-calling errors', async () => {
		const networkError = new Error('Network timeout');
		const fn = vi.fn().mockRejectedValue(networkError);

		await expect(withToolCallingRetry(fn, baseOptions)).rejects.toThrow('Network timeout');

		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('does not retry when signal is aborted', async () => {
		const toolError = new NoSuchToolError({
			toolName: 'foo',
			availableTools: ['bar']
		});

		const controller = new AbortController();
		controller.abort();

		const fn = vi.fn().mockRejectedValue(toolError);

		await expect(
			withToolCallingRetry(fn, {
				...baseOptions,
				signal: controller.signal
			})
		).rejects.toThrow();

		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('preserves original error in enhanced error', async () => {
		const toolError = new NoSuchToolError({
			toolName: 'commentary',
			availableTools: ['bash']
		});

		const fn = vi.fn().mockRejectedValue(toolError);

		try {
			await withToolCallingRetry(fn, {
				...baseOptions,
				maxRetries: 0
			});
		} catch (error) {
			expect((error as { originalError: unknown }).originalError).toBe(toolError);
		}
	});

	it('suggests switching models in enhanced error message', async () => {
		const toolError = new NoSuchToolError({
			toolName: 'commentary',
			availableTools: ['bash']
		});

		const fn = vi.fn().mockRejectedValue(toolError);

		await expect(
			withToolCallingRetry(fn, {
				...baseOptions,
				maxRetries: 0
			})
		).rejects.toThrow(/Try switching to a different model/);
	});
});

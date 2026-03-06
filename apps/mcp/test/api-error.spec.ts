import { describe, it, expect } from 'vitest';
import { ApiError, toMcpError } from '../src/api-client/api-error.js';

describe('toMcpError', () => {
	it('formats ApiError with body', () => {
		const error = new ApiError(400, 'Bad Request', { field: 'name', message: 'required' });
		const result = toMcpError(error);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('API Error (400): Bad Request');
		expect(result.content[0].text).toContain('"field": "name"');
	});

	it('formats ApiError without body', () => {
		const error = new ApiError(404, 'Not Found');
		const result = toMcpError(error);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe('API Error (404): Not Found');
	});

	it('formats generic Error', () => {
		const error = new Error('Something went wrong');
		const result = toMcpError(error);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe('Something went wrong');
	});

	it('formats unknown error', () => {
		const result = toMcpError('string error');
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe('string error');
	});

	it('formats TimeoutError with clear message', () => {
		const error = new Error('The operation was aborted');
		error.name = 'TimeoutError';
		const result = toMcpError(error);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Request timed out');
	});
});

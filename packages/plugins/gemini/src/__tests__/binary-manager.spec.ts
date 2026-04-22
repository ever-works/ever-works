import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureBinary } from '../utils/binary-manager';

describe('binary-manager', () => {
	const mockLogger = {
		debug: vi.fn()
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('ensureBinary', () => {
		it('should resolve the latest Gemini CLI through npx', async () => {
			const result = await ensureBinary('1.2.3', mockLogger);

			expect(result).toEqual({
				command: 'npx',
				args: ['--yes', '@google/gemini-cli@1.2.3']
			});
			expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Using Gemini CLI via npx'));
		});

		it('should resolve the latest package spec without version suffix', async () => {
			const result = await ensureBinary('latest', mockLogger);

			expect(result).toEqual({
				command: 'npx',
				args: ['--yes', '@google/gemini-cli']
			});
		});
	});
});

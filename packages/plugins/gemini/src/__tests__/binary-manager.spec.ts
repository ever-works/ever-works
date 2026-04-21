import { describe, it, expect, vi, beforeEach } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
	spawnMock: vi.fn()
}));

vi.mock('fs/promises', async () => {
	const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
	return {
		...actual,
		access: vi.fn(),
		mkdir: vi.fn(),
		writeFile: vi.fn()
	};
});

vi.mock('child_process', () => ({
	spawn: spawnMock
}));

import * as fs from 'fs/promises';
import { ensureBinary, getBinaryPath } from '../utils/binary-manager';

describe('binary-manager', () => {
	const mockLogger = {
		log: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn()
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('ensureBinary', () => {
		it('should return cached binary path if already executable', async () => {
			vi.mocked(fs.access).mockResolvedValueOnce(undefined);

			const result = await ensureBinary('1.2.3', mockLogger);

			expect(result).toBe(getBinaryPath('1.2.3'));
			expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('already cached'));
		});

		it('should install the Gemini CLI when the cached binary is missing', async () => {
			vi.mocked(fs.access).mockRejectedValueOnce(new Error('missing')).mockResolvedValueOnce(undefined);
			vi.mocked(fs.mkdir).mockResolvedValueOnce(undefined);
			vi.mocked(fs.writeFile).mockResolvedValueOnce(undefined);

			const child = {
				stderr: {
					on: vi.fn()
				},
				on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
					if (event === 'exit') {
						callback(0);
					}
					return child;
				})
			};
			spawnMock.mockReturnValue(child);

			const result = await ensureBinary('latest', mockLogger);

			expect(result).toBe(getBinaryPath('latest'));
			expect(spawnMock).toHaveBeenCalledWith(
				'npm',
				['install', '--no-package-lock', '--silent', '@google/gemini-cli'],
				expect.objectContaining({
					stdio: ['ignore', 'ignore', 'pipe']
				})
			);
			expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('Installing Gemini CLI'));
		});
	});
});

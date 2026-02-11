import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

// Mock fs, crypto, and platform before importing
vi.mock('fs/promises');
vi.mock('crypto');

vi.mock('../utils/platform', () => ({
	detectPlatform: vi.fn().mockResolvedValue({
		os: 'linux',
		arch: 'x64',
		platformString: 'linux-x64',
		isMusl: false
	}),
	getBinaryPath: vi.fn().mockReturnValue('/tmp/claude-code-generator/bin/claude-2.1.37-linux-x64')
}));

// Mock https module for downloads
const mockHttpsGet = vi.fn();
vi.mock('https', () => ({
	get: mockHttpsGet
}));

import { ensureBinary } from '../utils/binary-manager';
import { detectPlatform, getBinaryPath } from '../utils/platform';

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

			const result = await ensureBinary('2.1.37', mockLogger);

			expect(result).toBe('/tmp/claude-code-generator/bin/claude-2.1.37-linux-x64');
			expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('already cached'));
		});

		it('should call detectPlatform', async () => {
			vi.mocked(fs.access).mockResolvedValueOnce(undefined);

			await ensureBinary('2.1.37', mockLogger);

			expect(detectPlatform).toHaveBeenCalled();
		});

		it('should use getBinaryPath with version and platform', async () => {
			vi.mocked(fs.access).mockResolvedValueOnce(undefined);

			await ensureBinary('2.1.37', mockLogger);

			expect(getBinaryPath).toHaveBeenCalledWith('2.1.37', 'linux-x64');
		});

		it('should use default version when none specified', async () => {
			vi.mocked(fs.access).mockResolvedValueOnce(undefined);

			await ensureBinary(undefined as unknown as string, mockLogger);

			expect(detectPlatform).toHaveBeenCalled();
		});
	});
});

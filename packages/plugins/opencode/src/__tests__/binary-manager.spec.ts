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
	getBinaryPath: vi.fn().mockReturnValue('/tmp/opencode-generator/bin/opencode-v1.19.5-linux-x64')
}));

// Mock https module for downloads
const { mockHttpsGet } = vi.hoisted(() => ({
	mockHttpsGet: vi.fn()
}));

vi.mock('https', () => ({
	get: mockHttpsGet
}));

import { ensureBinary } from '../utils/binary-manager';
import { detectPlatform, getBinaryPath } from '../utils/platform';
import { DEFAULT_CLI_VERSION, OPENCODE_GITHUB_REPO } from '../types';

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

			expect(result).toBe('/tmp/opencode-generator/bin/opencode-v1.19.5-linux-x64');
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

		// Models refresh 2026-11-05: sst/opencode moved to anomalyco/opencode (the old paths
		// only answer with 301 redirects). Resolve releases from the new home, pinned to the
		// GitHub "Latest" v1 release.
		it('resolves the pinned release from anomalyco/opencode', async () => {
			expect(OPENCODE_GITHUB_REPO).toBe('anomalyco/opencode');
			expect(DEFAULT_CLI_VERSION).toBe('v1.19.5');

			vi.mocked(fs.access).mockRejectedValueOnce(new Error('not cached'));
			mockHttpsGet.mockImplementationOnce(
				(_url: string, _options: unknown, onResponse: (res: unknown) => void) => {
					onResponse({ statusCode: 404, headers: {}, resume: vi.fn() });
					return { setTimeout: vi.fn(), on: vi.fn(), destroy: vi.fn() };
				}
			);

			await expect(ensureBinary(DEFAULT_CLI_VERSION, mockLogger)).rejects.toThrow(/HTTP 404/);

			expect(mockHttpsGet.mock.calls[0][0]).toBe(
				'https://api.github.com/repos/anomalyco/opencode/releases/tags/v1.19.5'
			);
		});
	});
});

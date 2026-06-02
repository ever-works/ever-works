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

		it('should accept a semver tag with a leading v and pre-release suffix', async () => {
			const result = await ensureBinary('v1.2.3-rc.1', mockLogger);

			expect(result).toEqual({
				command: 'npx',
				args: ['--yes', '@google/gemini-cli@v1.2.3-rc.1']
			});
		});

		// Security: a tenant-supplied version that is not a strict semver could turn the npx
		// package spec into an arbitrary install source (git/URL/file/alias/dist-tag) that
		// npx would fetch and execute. Such values must be rejected, not interpolated.
		it.each(['github:evil/pkg', 'file:../evil', '../../etc/passwd', '1.2.3 @evil/pkg', 'next', ''])(
			'should reject a non-semver / malicious version (%j)',
			(version) => {
				expect(() => ensureBinary(version, mockLogger)).toThrow(/Invalid Gemini CLI version/);
				expect(mockLogger.debug).not.toHaveBeenCalled();
			}
		);
	});
});

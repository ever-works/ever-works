import { describe, expect, it, vi } from 'vitest';

import type { ModelProcessContainment } from './model-process.internal';
import { createProductionModelExecutionIoInternal } from './model-process-factory.internal';

const commands = {
	'claude-code': { executable: String.raw`C:\managed\claude.exe` },
	codex: { executable: String.raw`C:\managed\codex.exe` }
} as const;

const trust = {
	helperPath: String.raw`C:\Program Files\Ever Works\windows-job-launcher.exe`,
	expectedSha256: 'A'.repeat(64),
	publisherSubject: 'CN=Ever Co, O=Ever Co, C=US',
	publisherCertificateSha256: 'B'.repeat(64)
} as const;

const containment = (): ModelProcessContainment => ({
	spawn: vi.fn(),
	close: vi.fn(async () => ({ verified: true }))
});

describe('production model process factory selection', () => {
	it('selects a fresh trusted native Job containment for every Windows probe and model run', async () => {
		const first = containment();
		const second = containment();
		const createWindowsContainment = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
		const io = createProductionModelExecutionIoInternal(
			{ commands, windowsJobLauncher: trust },
			{ platform: 'win32', createWindowsContainment }
		);

		expect(io.createModelProcessContainment).toBeTypeOf('function');
		await expect(io.createModelProcessContainment!(vi.fn() as never)).resolves.toBe(first);
		await expect(io.createModelProcessContainment!(vi.fn() as never)).resolves.toBe(second);
		expect(createWindowsContainment).toHaveBeenNthCalledWith(1, trust);
		expect(createWindowsContainment).toHaveBeenNthCalledWith(2, trust);
	});

	it.each([
		['Windows without policy', 'win32' as const, undefined],
		['Linux with policy', 'linux' as const, trust],
		['macOS with policy', 'darwin' as const, trust]
	])('keeps containment unavailable for %s', (_name, platform, windowsJobLauncher) => {
		const createWindowsContainment = vi.fn();
		const io = createProductionModelExecutionIoInternal(
			{ commands, windowsJobLauncher },
			{ platform, createWindowsContainment }
		);

		expect(io.createModelProcessContainment).toBeUndefined();
		expect(createWindowsContainment).not.toHaveBeenCalled();
	});

	it('copies and freezes operator configuration so later mutation cannot redirect executable or trust paths', async () => {
		const mutableCommands = {
			'claude-code': { executable: String.raw`C:\managed\claude.exe` },
			codex: { executable: String.raw`C:\managed\codex.exe` }
		};
		const mutableTrust = { ...trust };
		const createWindowsContainment = vi.fn(() => containment());
		const io = createProductionModelExecutionIoInternal(
			{ commands: mutableCommands, windowsJobLauncher: mutableTrust },
			{ platform: 'win32', createWindowsContainment }
		);

		mutableCommands.codex.executable = String.raw`C:\attacker\codex.exe`;
		mutableTrust.helperPath = String.raw`C:\attacker\helper.exe`;
		await io.createModelProcessContainment!(vi.fn() as never);

		expect(io.commands!.codex!.executable).toBe(String.raw`C:\managed\codex.exe`);
		expect(createWindowsContainment).toHaveBeenCalledWith(trust);
		expect(Object.isFrozen(io.commands)).toBe(true);
		expect(Object.isFrozen(io.commands!.codex)).toBe(true);
	});

	it('propagates trust verifier unavailability without installing a child_process fallback', async () => {
		const createWindowsContainment = vi.fn(() => {
			throw new Error('signature tooling unavailable');
		});
		const io = createProductionModelExecutionIoInternal(
			{ commands, windowsJobLauncher: trust },
			{ platform: 'win32', createWindowsContainment }
		);

		await expect(io.createModelProcessContainment!(vi.fn() as never)).rejects.toThrow(
			'signature tooling unavailable'
		);
		expect(io.spawnFn).toBeUndefined();
	});
});

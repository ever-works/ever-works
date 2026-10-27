import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLEET_AGENT_TASK_CONTAINMENT_MAX_REASON_CHARS } from '@ever-works/contracts';
import {
	auditCodexRepositoryLayers,
	CODEX_REPOSITORY_CONFIG_CONTROL,
	CODEX_WINDOWS_SANDBOX_CONTROL,
	codexWindowsSandboxDowngrade,
	defaultRepositoryLayerFs,
	withCodexDisclosures,
	type RepositoryLayerFs
} from './codex-repository-layers';

/**
 * works-security finding 5 (node 0.2.7): the Codex items control 16 cannot
 * promise are disclosed on the run. Disclosures only — nothing here may
 * fail a run, open a repository file or write into the checkout.
 */
describe('auditCodexRepositoryLayers', () => {
	function checkout(files: readonly string[]): string {
		const root = mkdtempSync(join(tmpdir(), 'ew-codex-layers-'));
		for (const file of files) {
			const full = join(root, ...file.split('/'));
			mkdirSync(join(full, '..'), { recursive: true });
			writeFileSync(full, '# planted\n');
		}
		return root;
	}

	it('reports nothing for a checkout without a .codex/ layer', async () => {
		const root = checkout(['README.md', '.codex-not/config.toml']);
		await expect(auditCodexRepositoryLayers({ workspacePath: root, fs: defaultRepositoryLayerFs })).resolves.toBe(
			null
		);
	});

	it('names every repository-local layer the checkout carries', async () => {
		const root = checkout(['.codex/config.toml', '.codex/hooks.json']);
		const downgrade = await auditCodexRepositoryLayers({ workspacePath: root, fs: defaultRepositoryLayerFs });
		expect(downgrade?.control).toBe(CODEX_REPOSITORY_CONFIG_CONTROL);
		expect(downgrade?.reason).toContain('.codex/config.toml, .codex/hooks.json');
		expect(downgrade?.reason).toContain('--ignore-user-config');
		// The record survives the contracts' normaliser uncut.
		expect(downgrade?.reason.length).toBeLessThanOrEqual(FLEET_AGENT_TASK_CONTAINMENT_MAX_REASON_CHARS);
	});

	it('names only the layer that is there', async () => {
		const root = checkout(['.codex/hooks.json']);
		const downgrade = await auditCodexRepositoryLayers({ workspacePath: root, fs: defaultRepositoryLayerFs });
		expect(downgrade?.reason).toContain('(.codex/hooks.json)');
		expect(downgrade?.reason).not.toContain('config.toml');
	});

	it('treats "could not look" as a report, never as absent', async () => {
		const blind: RepositoryLayerFs = { presence: async () => 'unknown' };
		const downgrade = await auditCodexRepositoryLayers({ workspacePath: '/w', fs: blind });
		expect(downgrade?.control).toBe(CODEX_REPOSITORY_CONFIG_CONTROL);
		expect(downgrade?.reason).toContain('could not check');
	});

	it('treats a throwing seam as "could not look"', async () => {
		const broken: RepositoryLayerFs = {
			presence: async () => {
				throw new Error('EPERM');
			}
		};
		const downgrade = await auditCodexRepositoryLayers({ workspacePath: '/w', fs: broken });
		expect(downgrade?.reason).toContain('could not check');
	});

	it('prefers the "present" sentence when one layer is there and another unreadable', async () => {
		const mixed: RepositoryLayerFs = {
			presence: async (path) => (path.endsWith('config.toml') ? 'present' : 'unknown')
		};
		const downgrade = await auditCodexRepositoryLayers({ workspacePath: '/w', fs: mixed });
		expect(downgrade?.reason).toContain('carries a repository-local Codex layer (.codex/config.toml)');
	});

	it('looks at the worktree root only, never opening a file', async () => {
		const seen: string[] = [];
		const recording: RepositoryLayerFs = {
			presence: async (path) => {
				seen.push(path);
				return 'absent';
			}
		};
		await auditCodexRepositoryLayers({ workspacePath: join('/fleet', 'wt'), fs: recording });
		expect(seen).toEqual([
			join('/fleet', 'wt', '.codex', 'config.toml'),
			join('/fleet', 'wt', '.codex', 'hooks.json')
		]);
	});

	it('is skipped when no seam is wired (a hand-built io reads no disk)', async () => {
		await expect(auditCodexRepositoryLayers({ workspacePath: '/w', fs: undefined })).resolves.toBe(null);
	});
});

describe('codexWindowsSandboxDowngrade', () => {
	it('says nothing off Windows', () => {
		expect(codexWindowsSandboxDowngrade({ platform: 'linux', settings: {}, skipPermissions: false })).toBe(null);
		expect(codexWindowsSandboxDowngrade({ platform: 'darwin', settings: undefined, skipPermissions: true })).toBe(
			null
		);
	});

	it('reports native Windows without the owner [windows] sandbox setting', () => {
		const downgrade = codexWindowsSandboxDowngrade({ platform: 'win32', settings: {}, skipPermissions: false });
		expect(downgrade?.control).toBe(CODEX_WINDOWS_SANDBOX_CONTROL);
		expect(downgrade?.reason).toContain('[windows] sandbox');
		expect(downgrade?.reason.length).toBeLessThanOrEqual(FLEET_AGENT_TASK_CONTAINMENT_MAX_REASON_CHARS);
	});

	it('says nothing when the owner sandbox mode was kept', () => {
		expect(
			codexWindowsSandboxDowngrade({
				platform: 'win32',
				settings: { windowsSandbox: 'elevated' },
				skipPermissions: false
			})
		).toBe(null);
	});

	it('reports a skip-permissions run whatever the setting says', () => {
		const downgrade = codexWindowsSandboxDowngrade({
			platform: 'win32',
			settings: { windowsSandbox: 'elevated' },
			skipPermissions: true
		});
		expect(downgrade?.reason).toContain('--dangerously-bypass-approvals-and-sandbox');
	});
});

describe('withCodexDisclosures', () => {
	const record = {
		executionPath: 'ordinary',
		downgrades: [{ control: 'network-egress', reason: 'r' }]
	};

	it('returns the same record when there is nothing to add', () => {
		expect(withCodexDisclosures(record, [null, null])).toBe(record);
		expect(withCodexDisclosures(record, [])).toBe(record);
	});

	it('appends the disclosures after the standing downgrades, without mutating the input', () => {
		const next = withCodexDisclosures(record, [{ control: CODEX_WINDOWS_SANDBOX_CONTROL, reason: 'w' }, null]);
		expect(next.downgrades.map((entry) => entry.control)).toEqual([
			'network-egress',
			CODEX_WINDOWS_SANDBOX_CONTROL
		]);
		expect(record.downgrades).toHaveLength(1);
		expect(next.executionPath).toBe('ordinary');
	});
});

import { describe, expect, it } from 'vitest';
import { resolveHookPaths, type HookFs } from '../hook-client';
import {
	claudeHookEventsFor,
	claudeSettingsOverlay,
	codexNotifyOverride,
	hookCommandLine,
	SessionHookOverlay
} from '../hook-overlay';

/**
 * The per-session hook overlay (FL-05 spec FR-7 … FR-11, U10, U11; CONTRACTS
 * R-6; ACC-FL05-04, ACC-FL05-05). The person's global CLI configuration is
 * never written: every write lands under the node's own state folder.
 */

const SESSION = 'f3c1a0de-1111-4222-8333-444455556666';
const STATE = '/home/dana/.config/ever-works-node/sessions';

function memoryFs() {
	const files = new Map<string, string>();
	const fs: HookFs = {
		mkdir: async () => undefined,
		writeFile: async (target, data) => {
			files.set(target, data);
		},
		readFile: async (target) => {
			const value = files.get(target);
			if (value === undefined) throw new Error('ENOENT');
			return value;
		},
		rename: async (from, to) => {
			const value = files.get(from);
			if (value !== undefined) files.set(to, value);
			files.delete(from);
		},
		unlink: async (target) => {
			files.delete(target);
		},
		readdir: async () => [],
		stat: async () => ({ mtimeMs: 0, size: 0 }),
		chmod: async () => undefined
	};
	return { fs, files };
}

function overlay(version: string | null = '2.1.0', codexConfig = '') {
	const { fs, files } = memoryFs();
	const removed: string[] = [];
	const instance = new SessionHookOverlay({
		paths: resolveHookPaths(STATE, 'linux'),
		nodePath: '/usr/bin/node',
		platform: 'linux',
		homedir: '/home/dana',
		env: {},
		cliVersion: () => version,
		fs,
		readFile: async () => codexConfig,
		removeDir: async (target) => {
			removed.push(target);
		}
	});
	return { instance, files, removed };
}

describe('SessionHookOverlay', () => {
	it('Claude owner session: a settings file passed with --settings, under the state folder only', async () => {
		const { instance, files } = overlay();
		const result = await instance.hookOverlayFor('owner', 'claude-code', SESSION);
		expect(result?.args[0]).toBe('--settings');
		const file = result?.args[1] ?? '';
		expect(file.startsWith(`${STATE}/overlays/${SESSION}/`)).toBe(true);
		for (const written of files.keys()) {
			expect(written.startsWith(STATE)).toBe(true);
			expect(written).not.toContain('/.claude/');
			expect(written).not.toContain('/.codex/');
		}
		const settings = JSON.parse(files.get(file) ?? '{}') as { hooks: Record<string, unknown[]> };
		expect(Object.keys(settings.hooks)).toEqual(
			expect.arrayContaining(['Stop', 'PermissionRequest', 'UserPromptSubmit'])
		);
		expect(result?.hooks).toMatchObject({ provider: 'claude-code', injected: true });
		expect(result?.env.EVER_WORKS_SESSION_ID).toBe(SESSION);
	});

	it('omits hooks an older Claude Code lacks (U10)', () => {
		expect(claudeHookEventsFor('1.0.40')).not.toContain('PermissionRequest');
		expect(claudeHookEventsFor('1.0.40')).not.toContain('SessionEnd');
		expect(claudeHookEventsFor(null)).toContain('PermissionRequest');
		expect(claudeHookEventsFor('2.1.3')).toContain('PermissionRequest');
	});

	it('Claude Agent session: no overlay (the Task-run isolation disables hooks)', async () => {
		const { instance, files } = overlay();
		const result = await instance.hookOverlayFor('agent', 'claude-code', SESSION);
		expect(result?.args).toEqual([]);
		expect(result?.hooks).toMatchObject({ injected: false });
		expect(files.size).toBe(0);
	});

	it('Codex: a notify override on the command line, and says when it replaces the person’s own (U11)', async () => {
		const { instance, files } = overlay('2.1.0', 'model = "x"\nnotify = ["/usr/local/bin/notify"]\n');
		const result = await instance.hookOverlayFor('owner', 'codex', SESSION);
		expect(result?.args[0]).toBe('-c');
		expect(result?.args[1]).toBe(
			codexNotifyOverride(['/usr/bin/node', `${STATE}/hooks/hook-client.cjs`, 'codex', SESSION])
		);
		expect(result?.hooks?.notifyReplaced).toBe(true);
		expect(files.size).toBe(0);
	});

	it('removes the overlay folder when the session ends (FR-9)', async () => {
		const { instance, removed } = overlay();
		await instance.hookOverlayFor('owner', 'claude-code', SESSION);
		await instance.release(SESSION);
		expect(removed).toEqual([`${STATE}/overlays/${SESSION}`]);
		expect(instance.hooksFor(SESSION)).toBeNull();
	});
});

describe('hook command line', () => {
	it('quotes POSIX paths with single quotes', () => {
		expect(hookCommandLine('/opt/my node/node', '/x/hook-client.cjs', 'claude', SESSION, 'linux')).toBe(
			`'/opt/my node/node' '/x/hook-client.cjs' claude ${SESSION}`
		);
	});

	it('uses forward slashes in double quotes on Windows and refuses unsafe paths', () => {
		expect(
			hookCommandLine('C:\\Program Files\\nodejs\\node.exe', 'C:\\s\\hook-client.cjs', 'claude', SESSION, 'win32')
		).toBe(`"C:/Program Files/nodejs/node.exe" "C:/s/hook-client.cjs" claude ${SESSION}`);
		expect(hookCommandLine('C:\\%TEMP%\\node.exe', 'C:\\c.cjs', 'claude', SESSION, 'win32')).toBeNull();
	});

	it('registers the question tool only for PreToolUse', () => {
		const settings = claudeSettingsOverlay('cmd', ['PreToolUse', 'Stop']);
		expect(settings.hooks.PreToolUse).toEqual([
			{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'cmd', timeout: 5 }] }
		]);
		expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'cmd', timeout: 5 }] }]);
	});
});

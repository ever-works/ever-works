import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, scratchDir, tryMakeSymlink } from './fixtures';
import { discoverSkills } from '../skills';
import { checkServerContainment, loadMcpConfig, type McpServerEntry } from '../mcp';
import {
	isPluginRelative,
	isWithinResolved,
	packageRelative,
	pathExists,
	pathPresent,
	resolveRealPath,
	resolveWithinRoot
} from '../paths';

describe('paths — plugin-relative form (spec 4.1(4))', () => {
	it.each(['./x', './a/b', './'])('treats %j as plugin-relative', (value) => {
		expect(isPluginRelative(value)).toBe(true);
	});

	it.each(['x', '/x', '../x', '.x', '.\\x', '${PLUGIN_ROOT}/x', ''])('treats %j as not plugin-relative', (value) => {
		expect(isPluginRelative(value)).toBe(false);
	});
});

describe('paths — containment on resolved paths (spec 4.1)', () => {
	it('accepts the root itself and anything beneath it', () => {
		const root = resolve('/pkg');
		expect(isWithinResolved(root, root)).toBe(true);
		expect(isWithinResolved(root, join(root, 'a'))).toBe(true);
		expect(isWithinResolved(root, join(root, 'a', 'b', 'c'))).toBe(true);
	});

	it('rejects the parent, a sibling and a look-alike sibling', () => {
		const root = resolve('/pkg');
		expect(isWithinResolved(root, resolve('/'))).toBe(false);
		expect(isWithinResolved(root, resolve('/other'))).toBe(false);
		// The classic prefix bug: "/pkg-evil" starts with "/pkg" as a
		// string but is not inside it.
		expect(isWithinResolved(root, resolve('/pkg-evil'))).toBe(false);
		expect(isWithinResolved(root, resolve('/pkg-evil/x'))).toBe(false);
	});

	it('resolves traversal before comparing', async () => {
		const root = await scratchDir();
		await mkdir(join(root, 'a'), { recursive: true });
		const inside = await resolveWithinRoot(root, join('a', '..', 'a'));
		expect(inside.ok).toBe(true);
		const outside = await resolveWithinRoot(root, join('..', 'elsewhere'));
		expect(outside.ok).toBe(false);
		expect(outside.ok === false && outside.reason).toBe('escapes-root');
	});

	it('enforces the plugin-relative requirement when asked', async () => {
		const root = await scratchDir();
		const bare = await resolveWithinRoot(root, 'data', { requirePluginRelative: true });
		expect(bare.ok).toBe(false);
		expect(bare.ok === false && bare.reason).toBe('not-plugin-relative');
		const relative = await resolveWithinRoot(root, './data', { requirePluginRelative: true });
		expect(relative.ok).toBe(true);
	});

	it('checks a path that does not exist yet', async () => {
		// Needed for a `cwd` under PLUGIN_DATA that the client creates
		// before launch: containment must be decidable in advance.
		const root = await scratchDir();
		const inside = await resolveWithinRoot(root, join('not', 'yet', 'created'));
		expect(inside.ok).toBe(true);
		expect(inside.resolved.startsWith(await resolveRealPath(root))).toBe(true);
		const outside = await resolveWithinRoot(root, join('..', 'not', 'yet'));
		expect(outside.ok).toBe(false);
	});

	it('resolves a real path through an existing ancestor when the tail is missing', async () => {
		const root = await scratchDir();
		const resolved = await resolveRealPath(join(root, 'a', 'b', 'c.txt'));
		expect(resolved.endsWith(`a${sep}b${sep}c.txt`)).toBe(true);
	});

	it('renders package-relative POSIX paths for findings', () => {
		const root = resolve('/pkg');
		expect(packageRelative(root, join(root, 'skills', 'a'))).toBe('skills/a');
		expect(packageRelative(root, root)).toBe('.');
	});
});

const SYMLINK_SKIP =
	'this platform refused to create a symlink (Windows needs developer mode or elevation), so the containment boundary was NOT exercised here';

describe('paths — symlink escapes (spec 4.1, failure boundaries)', () => {
	// Symlinks cannot be committed portably: a Windows checkout without
	// developer mode drops them. These build a real link at run time and
	// skip when the platform refuses, which is why the corpus on disk has no
	// containment fixtures.

	it('follows a symlink that stays inside the root', async (ctx) => {
		const root = await scratchDir();
		await mkdir(join(root, 'real'), { recursive: true });
		await writeFile(join(root, 'real', 'f.txt'), 'x', 'utf8');
		// Link inside the package pointing at a sibling inside the package.
		const inner = await tryMakeSymlink(join(root, 'real'), join(root, 'inner-link'), 'dir');
		if (!inner) {
			ctx.skip(SYMLINK_SKIP);
			return;
		}
		const result = await resolveWithinRoot(root, 'inner-link');
		expect(result.ok).toBe(true);
	});

	it('rejects a symlink whose target escapes the root', async (ctx) => {
		const outside = await scratchDir();
		await writeFile(join(outside, 'secret.txt'), 'top secret', 'utf8');
		const root = await scratchDir();
		const made = await tryMakeSymlink(outside, join(root, 'escape'), 'dir');
		if (!made) {
			ctx.skip(SYMLINK_SKIP);
			return;
		}
		const result = await resolveWithinRoot(root, 'escape');
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toBe('escapes-root');
	});

	it('skips a skill whose SKILL.md is a symlink out of the package (boundary 3)', async (ctx) => {
		const outside = await scratchDir();
		await writeFile(
			join(outside, 'SKILL.md'),
			'---\nname: hijack\ndescription: Lives outside the package root.\n---\n\nBody.\n',
			'utf8'
		);
		const root = await scratchDir();
		await mkdir(join(root, 'skills', 'hijack'), { recursive: true });
		await mkdir(join(root, 'skills', 'legit'), { recursive: true });
		await writeFile(
			join(root, 'skills', 'legit', 'SKILL.md'),
			'---\nname: legit\ndescription: A normal skill that must survive.\n---\n\nBody.\n',
			'utf8'
		);
		const made = await tryMakeSymlink(
			join(outside, 'SKILL.md'),
			join(root, 'skills', 'hijack', 'SKILL.md'),
			'file'
		);
		if (!made) {
			ctx.skip(SYMLINK_SKIP);
			return;
		}
		const result = await discoverSkills(root);
		expect(result.skills.map((s) => s.name)).toEqual(['legit']);
		expect(result.findings.some((f) => f.code === 'package.path-escapes-root')).toBe(true);
		expect(result.componentValid).toBe(true);
	});

	it('invalidates only the skills component when skills/ itself escapes (boundary 2)', async (ctx) => {
		const outside = await scratchDir();
		await mkdir(join(outside, 'evil'), { recursive: true });
		const root = await scratchDir();
		const made = await tryMakeSymlink(join(outside, 'evil'), join(root, 'skills'), 'dir');
		if (!made) {
			ctx.skip(SYMLINK_SKIP);
			return;
		}
		const result = await discoverSkills(root);
		expect(result.componentValid).toBe(false);
		expect(result.findings.some((f) => f.code === 'package.path-escapes-root')).toBe(true);
		expect(result.findings.every((f) => f.scope === 'skills-component')).toBe(true);
	});

	it('disables only MCP when mcp.json escapes (boundary 2)', async (ctx) => {
		const outside = await scratchDir();
		await writeFile(join(outside, 'mcp.json'), '{"mcpServers":{}}', 'utf8');
		const root = await scratchDir();
		const made = await tryMakeSymlink(join(outside, 'mcp.json'), join(root, 'mcp.json'), 'file');
		if (!made) {
			ctx.skip(SYMLINK_SKIP);
			return;
		}
		const result = await loadMcpConfig(root, { manifestSpecVersion: '1.0.0' });
		expect(result.componentValid).toBe(false);
		expect(result.findings.every((f) => f.scope === 'mcp-component')).toBe(true);
	});
});

describe('paths — MCP server containment (spec 4.1 boundary 4)', () => {
	const mcpDoc = (servers: Record<string, unknown>): string =>
		JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: servers });

	it('accepts a plugin-relative command and cwd that stay inside the root', async () => {
		const root = await scratchDir();
		await mkdir(join(root, 'bin'), { recursive: true });
		await writeFile(join(root, 'bin', 'server'), '#!/bin/sh', 'utf8');
		await mkdir(join(root, 'data'), { recursive: true });
		await writeFile(
			join(root, 'mcp.json'),
			mcpDoc({ ok: { type: 'stdio', command: './bin/server', cwd: './data' } }),
			'utf8'
		);
		const result = await loadMcpConfig(root, { manifestSpecVersion: '1.0.0' });
		expect(result.servers.map((s) => s.name)).toEqual(['ok']);
		expect(result.findings).toEqual([]);
	});

	it('accepts a command whose file does not exist yet', async () => {
		// A package may build its binary on first run. Containment must be
		// decidable without the file being there, and must not reject it.
		const root = await scratchDir();
		await writeFile(
			join(root, 'mcp.json'),
			mcpDoc({ later: { type: 'stdio', command: './bin/not-built-yet' } }),
			'utf8'
		);
		const result = await loadMcpConfig(root, { manifestSpecVersion: '1.0.0' });
		expect(result.servers.map((s) => s.name)).toEqual(['later']);
	});

	it('never containment-checks args or env values (spec 4.1(5))', async () => {
		// "Configuration values not defined as paths, including command
		// arguments and environment variable values, are opaque strings.
		// Clients MUST NOT interpret them as package paths." An argument that
		// merely looks like an escaping path must not sink the server.
		const root = await scratchDir();
		await writeFile(
			join(root, 'mcp.json'),
			mcpDoc({
				opaque: {
					type: 'stdio',
					command: 'node',
					args: ['../../../etc/passwd', '/absolute/elsewhere', '../..'],
					env: { SOME_PATH: '../../../etc/shadow' }
				}
			}),
			'utf8'
		);
		const result = await loadMcpConfig(root, { manifestSpecVersion: '1.0.0' });
		expect(result.servers.map((s) => s.name)).toEqual(['opaque']);
		expect(result.findings).toEqual([]);
	});

	it('does not containment-check a bare command, which the platform resolves', async () => {
		const root = await scratchDir();
		const entry: McpServerEntry = { name: 's', config: { type: 'stdio', command: 'node' }, transport: 'stdio' };
		expect(await checkServerContainment(root, entry)).toEqual([]);
	});

	it('returns no findings for a remote server, which has no package paths', async () => {
		const root = await scratchDir();
		const entry: McpServerEntry = {
			name: 's',
			config: { type: 'streamable-http', url: 'https://x.example.com/mcp' },
			transport: 'streamable-http'
		};
		expect(await checkServerContainment(root, entry)).toEqual([]);
	});

	it('drops a server whose plugin-relative command escapes via a symlink', async (ctx) => {
		const outside = await scratchDir();
		await writeFile(join(outside, 'evil'), '#!/bin/sh', 'utf8');
		const root = await scratchDir();
		await mkdir(join(root, 'bin'), { recursive: true });
		const made = await tryMakeSymlink(join(outside, 'evil'), join(root, 'bin', 'server'), 'file');
		if (!made) {
			ctx.skip(SYMLINK_SKIP);
			return;
		}
		await writeFile(
			join(root, 'mcp.json'),
			mcpDoc({
				escaping: { type: 'stdio', command: './bin/server' },
				fine: { type: 'streamable-http', url: 'https://x.example.com/mcp' }
			}),
			'utf8'
		);
		const result = await loadMcpConfig(root, { manifestSpecVersion: '1.0.0' });
		// Boundary 4 is per SERVER: the other entry and the component survive.
		expect(result.componentValid).toBe(true);
		expect(result.servers.map((s) => s.name)).toEqual(['fine']);
		expect(result.findings.map((f) => f.code)).toEqual(['mcp.server-command-invalid']);
		expect(result.findings[0]?.subject).toBe('escaping');
	});

	it('drops a server whose cwd escapes via a symlink', async (ctx) => {
		const outside = await scratchDir();
		await mkdir(join(outside, 'elsewhere'), { recursive: true });
		const root = await scratchDir();
		const made = await tryMakeSymlink(join(outside, 'elsewhere'), join(root, 'data'), 'dir');
		if (!made) {
			ctx.skip(SYMLINK_SKIP);
			return;
		}
		await writeFile(
			join(root, 'mcp.json'),
			mcpDoc({ escaping: { type: 'stdio', command: 'node', cwd: './data' } }),
			'utf8'
		);
		const result = await loadMcpConfig(root, { manifestSpecVersion: '1.0.0' });
		expect(result.servers).toEqual([]);
		expect(result.findings.map((f) => f.code)).toEqual(['mcp.server-cwd-invalid']);
	});

	it('checks a PLUGIN_DATA-rooted cwd only when the data directory is known', async (ctx) => {
		// The loader does not know PLUGIN_DATA — the launcher does — so the
		// check is deferred rather than guessed at.
		const outside = await scratchDir();
		await mkdir(join(outside, 'elsewhere'), { recursive: true });
		const root = await scratchDir();
		const data = await scratchDir();
		const made = await tryMakeSymlink(join(outside, 'elsewhere'), join(data, 'sub'), 'dir');
		if (!made) {
			ctx.skip(SYMLINK_SKIP);
			return;
		}
		const entry: McpServerEntry = {
			name: 's',
			config: { type: 'stdio', command: 'node', cwd: '${PLUGIN_DATA}/sub' },
			transport: 'stdio',
			cwdAnchor: 'plugin-data'
		};
		expect(await checkServerContainment(root, entry)).toEqual([]);
		const withData = await checkServerContainment(root, entry, { pluginData: data });
		expect(withData.map((f) => f.code)).toEqual(['mcp.server-cwd-invalid']);
	});
});

describe('paths — present-but-broken versus absent (spec 6.2)', () => {
	it('treats a dangling skills symlink as an invalid component, not an absent one', async (ctx) => {
		const root = await scratchDir();
		const made = await tryMakeSymlink(join(root, 'no-such-target'), join(root, 'skills'), 'dir');
		if (!made) {
			ctx.skip(SYMLINK_SKIP);
			return;
		}
		const result = await discoverSkills(root);
		// Absent would silently load the package as though the author never
		// shipped skills at all, hiding a broken package.
		expect(result.componentAbsent).toBe(false);
		expect(result.componentValid).toBe(false);
		expect(result.findings.map((f) => f.code)).toEqual(['skills.location-not-a-directory']);
	});

	it('treats a dangling mcp.json symlink as disabling MCP, not as absent', async (ctx) => {
		const root = await scratchDir();
		const made = await tryMakeSymlink(join(root, 'no-such-target.json'), join(root, 'mcp.json'), 'file');
		if (!made) {
			ctx.skip(SYMLINK_SKIP);
			return;
		}
		const result = await loadMcpConfig(root, { manifestSpecVersion: '1.0.0' });
		expect(result.componentAbsent).toBe(false);
		expect(result.componentValid).toBe(false);
		expect(result.findings.map((f) => f.code)).toEqual(['mcp.location-not-a-file']);
	});

	it('still reports a genuinely missing location as absent, with no finding', async () => {
		const root = await scratchDir();
		const skills = await discoverSkills(root);
		expect(skills.componentAbsent).toBe(true);
		expect(skills.componentValid).toBe(true);
		expect(skills.findings).toEqual([]);
		const mcp = await loadMcpConfig(root, { manifestSpecVersion: '1.0.0' });
		expect(mcp.componentAbsent).toBe(true);
		expect(mcp.componentValid).toBe(true);
		expect(mcp.findings).toEqual([]);
	});

	it('distinguishes the two questions directly', async (ctx) => {
		const root = await scratchDir();
		const made = await tryMakeSymlink(join(root, 'nope'), join(root, 'dangling'), 'file');
		if (!made) {
			ctx.skip(SYMLINK_SKIP);
			return;
		}
		expect(await pathExists(join(root, 'dangling'))).toBe(false);
		expect(await pathPresent(join(root, 'dangling'))).toBe(true);
		expect(await pathPresent(join(root, 'truly-missing'))).toBe(false);
	});
});

describe('paths — the fixture corpus is reachable', () => {
	it('resolves a known fixture', async () => {
		const result = await resolveWithinRoot(fixture('valid-full'), 'plugin.json');
		expect(result.ok).toBe(true);
	});
});

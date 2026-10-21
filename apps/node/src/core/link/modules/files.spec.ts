import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	FLEET_FILES_RECORD_TAGS,
	FLEET_LINK_FRAME_KINDS,
	decodeFleetFilesRecords,
	encodeFleetFilesBytesRecord,
	encodeFleetFilesHeaderRecord,
	type FleetConsents,
	type FleetFileRootsResult,
	type FleetLinkFrameKind
} from '@ever-works/contracts';
import { resolveCanonicalAllowedRoots } from '../allowed-roots';
import { createFilesLinkModule } from './files';
import { createNodeFilesIo } from './files/files-io';
import type { NodeChannelContext, NodeChannelHandler, NodeLinkControlState } from './registry';

/**
 * Files on computers (FL-11, T-02…T-07) — the `files` module against real
 * temporary folders: roots and the tag, the open refusals (unknown root,
 * escape, kill switch), list flags, pack (the stream, the credential gate,
 * credit), unpack (partial folder, policy, cancel leaves nothing) and delete
 * (a link goes, its target stays). Written, not run (fast-build rule): the
 * cascade runs them.
 */

const MANAGE: FleetConsents = { work: false, attend: false, manage: true, usageScan: false };
const canLink = process.platform !== 'win32';

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
	base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'ew-files-')));
	root = join(base, 'root');
	outside = join(base, 'outside');
	await fs.mkdir(join(root, 'src', 'server'), { recursive: true });
	await fs.mkdir(outside, { recursive: true });
	await fs.writeFile(join(root, 'src', 'app.ts'), 'export {};\n');
	await fs.writeFile(join(root, 'src', '.env'), 'TOKEN=x\n');
	await fs.writeFile(join(root, 'src', 'server', 'server.log'), 'line\n'.repeat(1000));
	await fs.writeFile(join(outside, 'secret.txt'), 'nope');
});

afterEach(async () => {
	await fs.rm(base, { recursive: true, force: true });
});

function moduleFor(extraRoots: string[] = [root]) {
	const io = createNodeFilesIo({ platform: process.platform, homedir: join(base, 'home') });
	return createFilesLinkModule({
		io,
		nodeName: 'build-01',
		refreshMs: 0,
		roots: () =>
			resolveCanonicalAllowedRoots(
				{ platform: process.platform, homedir: join(base, 'home'), purpose: 'files', extraRoots },
				io
			)
	});
}

function harness(params: Record<string, unknown>) {
	const json: Array<Record<string, unknown>> = [];
	const frames: Array<{ kind: FleetLinkFrameKind; payload: Uint8Array }> = [];
	const state = { credit: Number.POSITIVE_INFINITY };
	const closed: Array<{ reason: string; hint?: string }> = [];
	const listeners = new Set<(s: { paused: boolean; drain: null }) => void>();
	const control: NodeLinkControlState & { pause(): void } = {
		paused: false,
		drain: null,
		onChange: (listener) => {
			listeners.add(listener as never);
			return () => listeners.delete(listener as never);
		},
		pause() {
			(this as { paused: boolean }).paused = true;
			for (const listener of listeners) listener({ paused: true, drain: null });
		}
	};
	const done: Array<{ id: string; outcome: unknown }> = [];
	let handler: NodeChannelHandler | null = null;
	const context: NodeChannelContext = {
		channel: 9,
		family: 'files',
		params,
		consents: MANAGE,
		control,
		nodeVersion: '1.0.0',
		nodeName: 'build-01',
		sendJson: (message) => {
			json.push(message);
			return true;
		},
		sendBinary: (kind, payload) => {
			if (kind === FLEET_LINK_FRAME_KINDS.DATA) {
				if (payload.byteLength > state.credit) return false;
				state.credit -= payload.byteLength;
			}
			frames.push({ kind, payload: new Uint8Array(payload) });
			return true;
		},
		sendControl: () => true,
		close: (reason, hint) => {
			closed.push({ reason, ...(hint ? { hint } : {}) });
			handler?.onClose?.(reason);
		},
		operations: {
			start: () => 'op-1',
			progress: () => undefined,
			done: (id, outcome) => {
				done.push({ id, outcome });
			}
		}
	};
	return {
		context,
		control,
		json,
		frames,
		state,
		closed,
		done,
		bind(next: NodeChannelHandler) {
			handler = next;
			return next;
		}
	};
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error('timed out');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function rootId(): Promise<string> {
	const roots = (await moduleFor().machineVerbs![`files.roots`].run({} as never)) as FleetFileRootsResult;
	return roots.roots[0].id;
}

async function open(params: Record<string, unknown>) {
	const h = harness(params);
	const result = await moduleFor().families![0].open(h.context);
	return { h, result };
}

function reply(h: ReturnType<typeof harness>, requestId: string) {
	return h.json.find((message) => message.requestId === requestId);
}

describe('files module — roots and the tag (FR-1, FR-2, FR-4)', () => {
	it('lists the listed folder as a root and advertises files under --manage', async () => {
		const module = moduleFor();
		const roots = (await module.machineVerbs!['files.roots'].run({} as never)) as FleetFileRootsResult;
		expect(roots.roots).toHaveLength(1);
		expect(roots.roots[0]).toMatchObject({ kind: 'listed', path: root });
		await module.refreshRoots();
		expect(module.tags!({ consents: MANAGE, platform: process.platform, nodeVersion: '1' })).toEqual(['files']);
		expect(
			module.tags!({ consents: { ...MANAGE, manage: false }, platform: process.platform, nodeVersion: '1' })
		).toEqual([]);
	});

	it('advertises nothing without a root, and never offers the home directory', async () => {
		const module = moduleFor([join(base, 'home')]);
		await fs.mkdir(join(base, 'home'), { recursive: true });
		await module.refreshRoots();
		expect(module.tags!({ consents: MANAGE, platform: process.platform, nodeVersion: '1' })).toEqual([]);
		const roots = (await module.machineVerbs!['files.roots'].run({} as never)) as FleetFileRootsResult;
		expect(roots.roots).toEqual([]);
		expect(roots.refused).toBe(1);
	});
});

describe('files module — opening a channel (FR-3, U4, U6)', () => {
	it('refuses an unknown root, an escape and the kill switch', async () => {
		expect((await open({ root: 'nope', path: '' })).result).toMatchObject({
			ok: false,
			error: { code: 'not_found' }
		});
		const id = await rootId();
		expect((await open({ root: id, path: '../outside' })).result).toMatchObject({
			ok: false,
			error: { code: 'invalid' }
		});
		const h = harness({ root: id, path: '' });
		h.control.pause();
		expect(await moduleFor().families![0].open(h.context)).toMatchObject({
			ok: false,
			error: { code: 'kill_switch' }
		});
	});

	it.runIf(canLink)('refuses a folder link that leaves the root, opens one that stays', async () => {
		await fs.symlink(outside, join(root, 'escape'));
		await fs.symlink(join(root, 'src'), join(root, 'current'));
		const id = await rootId();
		expect((await open({ root: id, path: 'escape' })).result).toMatchObject({
			ok: false,
			error: { code: 'invalid', hint: 'That path leaves its root' }
		});
		expect((await open({ root: id, path: 'current' })).result).toMatchObject({ ok: true });
	});
});

describe('files module — list (FR-5…FR-8)', () => {
	it('hides dot-files by default and flags credential-shaped names when shown', async () => {
		const { h, result } = await open({ root: await rootId(), path: 'src' });
		const handler = h.bind((result as { handler: NodeChannelHandler }).handler);
		handler.onJson!({ requestId: 'r1', type: 'files.list', params: {} });
		await until(() => Boolean(reply(h, 'r1')));
		const hidden = (reply(h, 'r1')!.result as { entries: Array<{ name: string }> }).entries.map((e) => e.name);
		expect(hidden).toEqual(['app.ts', 'server']);
		handler.onJson!({ requestId: 'r2', type: 'files.list', params: { hidden: true } });
		await until(() => Boolean(reply(h, 'r2')));
		const entries = (reply(h, 'r2')!.result as { entries: Array<Record<string, unknown>> }).entries;
		expect(entries.find((e) => e.name === '.env')).toMatchObject({ hidden: true, credentialShaped: true });
		expect(entries.find((e) => e.name === 'server')).toMatchObject({ kind: 'folder' });
	});

	it.runIf(canLink)('says whether a link stays inside the root', async () => {
		await fs.symlink(join(outside, 'secret.txt'), join(root, 'src', 'out.txt'));
		await fs.symlink(join(root, 'src', 'server'), join(root, 'src', 'logs'));
		const { h, result } = await open({ root: await rootId(), path: 'src' });
		const handler = h.bind((result as { handler: NodeChannelHandler }).handler);
		handler.onJson!({ requestId: 'r1', type: 'files.list', params: {} });
		await until(() => Boolean(reply(h, 'r1')));
		const entries = (reply(h, 'r1')!.result as { entries: Array<Record<string, unknown>> }).entries;
		expect(entries.find((e) => e.name === 'out.txt')).toMatchObject({ kind: 'link', linkInsideRoot: false });
		expect(entries.find((e) => e.name === 'logs')).toMatchObject({
			kind: 'link',
			linkInsideRoot: true,
			linkKind: 'folder'
		});
	});

	it('truncates past 5 000 entries and says so (FR-6)', async () => {
		await fs.mkdir(join(root, 'many'));
		await Promise.all(Array.from({ length: 5001 }, (_, i) => fs.writeFile(join(root, 'many', `f${i}`), '')));
		const { h, result } = await open({ root: await rootId(), path: 'many' });
		const handler = h.bind((result as { handler: NodeChannelHandler }).handler);
		handler.onJson!({ requestId: 'r1', type: 'files.list', params: {} });
		await until(() => Boolean(reply(h, 'r1')), 30_000);
		expect(reply(h, 'r1')!.result).toMatchObject({ truncated: true, total: 5001 });
	}, 60_000);
});

describe('files module — pack (FR-10, FR-11, FR-16, FR-17)', () => {
	it('streams one file as a header and its bytes, then packed and END', async () => {
		const { h, result } = await open({ root: await rootId(), path: 'src/server' });
		const handler = h.bind((result as { handler: NodeChannelHandler }).handler);
		handler.onJson!({ requestId: 'p1', type: 'files.pack', params: { entries: ['server.log'] } });
		await until(() => h.frames.some((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.END));
		expect(reply(h, 'p1')!.result).toMatchObject({
			operationId: 'op-1',
			accepted: { entries: 1, bytes: 5000, single: true, name: 'server.log' }
		});
		const records = h.frames
			.filter((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.DATA)
			.flatMap((frame) => decodeFleetFilesRecords(frame.payload)!);
		expect(records[0]).toMatchObject({
			tag: FLEET_FILES_RECORD_TAGS.header,
			header: { path: 'server.log', size: 5000 }
		});
		const bytes = records
			.filter((record) => record.tag === FLEET_FILES_RECORD_TAGS.bytes)
			.reduce((sum, record) => sum + (record as { bytes: Uint8Array }).bytes.byteLength, 0);
		expect(bytes).toBe(5000);
		expect(h.json.find((message) => message.type === 'files.packed')).toMatchObject({ entries: 1, bytes: 5000 });
		expect(h.done[0]).toMatchObject({ id: 'op-1' });
	});

	it('asks for confirmation before a credential-shaped file moves (FR-17)', async () => {
		const { h, result } = await open({ root: await rootId(), path: 'src' });
		const handler = h.bind((result as { handler: NodeChannelHandler }).handler);
		handler.onJson!({ requestId: 'p1', type: 'files.pack', params: { entries: ['.env'] } });
		await until(() => Boolean(reply(h, 'p1')));
		expect(reply(h, 'p1')!.error).toMatchObject({ code: 'confirmation_required', details: { class: 'confirm' } });
		expect(h.frames.filter((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.DATA)).toHaveLength(0);
		handler.onJson!({
			requestId: 'p2',
			type: 'files.pack',
			params: { entries: ['.env'], allowCredentialShaped: true }
		});
		await until(() => h.frames.some((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.END));
	});

	it('flags a credential-shaped file inside a selected folder too', async () => {
		const { h, result } = await open({ root: await rootId(), path: '' });
		const handler = h.bind((result as { handler: NodeChannelHandler }).handler);
		handler.onJson!({ requestId: 'p1', type: 'files.pack', params: { entries: ['src'] } });
		await until(() => Boolean(reply(h, 'p1')));
		expect(reply(h, 'p1')!.error).toMatchObject({ code: 'confirmation_required', details: { count: 1 } });
	});

	it('waits for credit: a stalled receiver pauses the sender (FR-10)', async () => {
		const { h, result } = await open({ root: await rootId(), path: 'src/server' });
		h.state.credit = 100; // room for the header only
		const handler = h.bind((result as { handler: NodeChannelHandler }).handler);
		handler.onJson!({ requestId: 'p1', type: 'files.pack', params: { entries: ['server.log'] } });
		await until(() => Boolean(reply(h, 'p1')));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(h.frames.some((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.END)).toBe(false);
		h.state.credit = Number.POSITIVE_INFINITY;
		handler.onDrain!();
		await until(() => h.frames.some((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.END));
	});
});

function streamOf(files: Record<string, string>): Uint8Array[] {
	const out: Uint8Array[] = [];
	for (const [path, text] of Object.entries(files)) {
		const bytes = new TextEncoder().encode(text);
		out.push(
			encodeFleetFilesHeaderRecord({ path, kind: 'file', size: bytes.byteLength, mode: 0o644, mtimeMs: 0 })!
		);
		if (bytes.byteLength > 0) out.push(encodeFleetFilesBytesRecord(bytes)!);
	}
	return out;
}

describe('files module — unpack (FR-12, FR-13, FR-15)', () => {
	async function upload(files: Record<string, string>, policy: Record<string, unknown>, end = true) {
		const { h, result } = await open({ root: await rootId(), path: 'src' });
		const handler = h.bind((result as { handler: NodeChannelHandler }).handler);
		handler.onJson!({ requestId: 'u1', type: 'files.unpack', params: { policy } });
		await until(() => Boolean(reply(h, 'u1')));
		for (const record of streamOf(files)) handler.onBinary!(FLEET_LINK_FRAME_KINDS.DATA, record);
		if (end) {
			handler.onBinary!(FLEET_LINK_FRAME_KINDS.END, new Uint8Array(0));
			await until(() => h.json.some((message) => message.type === 'files.unpacked'));
		}
		return { h, handler };
	}

	it('writes new files and skips existing ones by default', async () => {
		const { h } = await upload({ 'app.ts': 'changed', 'README.md': '# hi' }, {});
		expect(await fs.readFile(join(root, 'src', 'app.ts'), 'utf8')).toBe('export {};\n');
		expect(await fs.readFile(join(root, 'src', 'README.md'), 'utf8')).toBe('# hi');
		expect(h.json.find((message) => message.type === 'files.unpacked')).toMatchObject({ skipped: 1, replaced: 0 });
		expect(h.frames.some((frame) => frame.kind === FLEET_LINK_FRAME_KINDS.ACK)).toBe(true);
		expect((await fs.readdir(join(root, 'src'))).some((name) => name.startsWith('.ever-works-partial-'))).toBe(
			false
		);
	});

	it('replaces what the policy names', async () => {
		await upload({ 'app.ts': 'changed' }, { replace: ['app.ts'] });
		expect(await fs.readFile(join(root, 'src', 'app.ts'), 'utf8')).toBe('changed');
	});

	it('leaves nothing partial when the channel closes before END (FR-15, U15)', async () => {
		const { h } = await upload({ 'new.txt': 'half' }, {}, false);
		await new Promise((resolve) => setTimeout(resolve, 20));
		h.context.close('normal', 'cancelled');
		await new Promise((resolve) => setTimeout(resolve, 100));
		const names = await fs.readdir(join(root, 'src'));
		expect(names).not.toContain('new.txt');
		expect(names.some((name) => name.startsWith('.ever-works-partial-'))).toBe(false);
	});

	it('refuses a stream path that leaves the destination', async () => {
		const { h, result } = await open({ root: await rootId(), path: 'src' });
		const handler = h.bind((result as { handler: NodeChannelHandler }).handler);
		handler.onJson!({ requestId: 'u1', type: 'files.unpack', params: {} });
		await until(() => Boolean(reply(h, 'u1')));
		// A hand-built header the contract decoder refuses: the stream is malformed, the unpack fails.
		const body = new TextEncoder().encode(JSON.stringify({ path: '../escape.txt', kind: 'file', size: 0 }));
		const record = new Uint8Array(5 + body.byteLength);
		new DataView(record.buffer).setUint8(0, FLEET_FILES_RECORD_TAGS.header);
		new DataView(record.buffer).setUint32(1, body.byteLength);
		record.set(body, 5);
		handler.onBinary!(FLEET_LINK_FRAME_KINDS.DATA, record);
		await until(() => h.json.some((message) => message.type === 'files.unpacked'));
		expect(h.json.find((message) => message.type === 'files.unpacked')).toMatchObject({
			error: { code: 'invalid' }
		});
		await expect(fs.stat(join(root, 'escape.txt'))).rejects.toThrow();
	});
});

describe('files module — delete (FR-18)', () => {
	it.runIf(canLink)('removes a link, never its target', async () => {
		await fs.symlink(join(outside, 'secret.txt'), join(root, 'src', 'out.txt'));
		const { h, result } = await open({ root: await rootId(), path: 'src' });
		const handler = h.bind((result as { handler: NodeChannelHandler }).handler);
		handler.onJson!({ requestId: 'd1', type: 'files.delete', params: { entries: ['out.txt'] } });
		await until(() => Boolean(reply(h, 'd1')));
		expect(reply(h, 'd1')!.result).toMatchObject({ removed: 1 });
		expect(await fs.readFile(join(outside, 'secret.txt'), 'utf8')).toBe('nope');
	});

	it('refuses a name with a separator before removing anything', async () => {
		const { h, result } = await open({ root: await rootId(), path: 'src' });
		const handler = h.bind((result as { handler: NodeChannelHandler }).handler);
		handler.onJson!({ requestId: 'd1', type: 'files.delete', params: { entries: ['app.ts', '../../outside'] } });
		await until(() => Boolean(reply(h, 'd1')));
		expect(reply(h, 'd1')!.error).toMatchObject({ code: 'invalid' });
		expect(await fs.readFile(join(root, 'src', 'app.ts'), 'utf8')).toBe('export {};\n');
	});
});

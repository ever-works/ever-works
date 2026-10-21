import { describe, expect, it } from 'vitest';
import { createFileReader, FILE_GONE_AFTER_MS, FILE_POLL_MS, scanBackward } from './file-source';
import type { LogFs, LogIo, RawLogLine } from './log-io';

/**
 * Logs on computers (FL-08, T-04) — a file tailed by the node: the backward
 * scan for the last lines (CRLF, a partial first chunk, the scan bound),
 * following through rotation and truncation, `gone`, and the older page.
 */

interface FakeFile {
	bytes: Buffer;
	ino: number;
	readable?: boolean;
}

function fakeIo(files: Map<string, FakeFile>) {
	let now = 0;
	let timers: Array<{ at: number; callback: () => void; id: number }> = [];
	let next = 1;
	const fs: LogFs = {
		realpath: async (path) => path,
		stat: async (path) => {
			const file = files.get(path);
			if (!file) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			return { size: file.bytes.byteLength, mtimeMs: 0, ino: file.ino, isFile: true, isDirectory: false };
		},
		readdir: async () => [],
		canRead: async (path) => files.get(path)?.readable !== false,
		read: async (path, position, length) => {
			const file = files.get(path);
			if (!file) throw new Error('ENOENT');
			return new Uint8Array(file.bytes.subarray(position, position + length));
		}
	};
	const io = {
		platform: 'linux',
		homedir: '/home/ops',
		user: 'ops',
		fs,
		runner: { run: async () => ({ code: 0, stdout: '', stderr: '' }) },
		spawn: () => {
			throw new Error('no children in file specs');
		},
		isElevated: async () => false,
		now: () => now,
		setTimer: (callback: () => void, ms: number) => {
			const id = next++;
			timers.push({ at: now + ms, callback, id });
			return id;
		},
		clearTimer: (handle: unknown) => {
			timers = timers.filter((timer) => timer.id !== handle);
		}
	} as unknown as LogIo;
	const advance = async (ms: number) => {
		const until = now + ms;
		for (;;) {
			const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			timers = timers.filter((timer) => timer !== due);
			now = due.at;
			due.callback();
			for (let i = 0; i < 25; i += 1) await Promise.resolve();
		}
		now = until;
	};
	return { io, advance };
}

function collect() {
	const lines: RawLogLine[] = [];
	const notices: string[] = [];
	let ended = false;
	return {
		lines,
		notices,
		get ended() {
			return ended;
		},
		sink: {
			line: (line: RawLogLine) => lines.push(line),
			notice: (kind: string) => notices.push(kind),
			ended: () => {
				ended = true;
			}
		}
	};
}

const numbered = (count: number, eol = '\n') =>
	Array.from({ length: count }, (_, i) => `line ${i + 1}`).join(eol) + eol;

describe('scanBackward', () => {
	it('finds the last lines, stripping a partial first piece', async () => {
		const files = new Map([['/var/log/app.log', { bytes: Buffer.from(numbered(2000)), ino: 1 }]]);
		const { io } = fakeIo(files);
		const scan = await scanBackward(io, '/var/log/app.log', files.get('/var/log/app.log')!.bytes.byteLength, 3);
		expect(scan.lines).toEqual(['line 1998', 'line 1999', 'line 2000']);
		expect(scan.scanLimited).toBe(false);
	});

	it('says when the scan bound cut the lines short', async () => {
		const files = new Map([['/f', { bytes: Buffer.from(numbered(100)), ino: 1 }]]);
		const { io } = fakeIo(files);
		const scan = await scanBackward(io, '/f', files.get('/f')!.bytes.byteLength, 500, 64);
		expect(scan.scanLimited).toBe(true);
		expect(scan.lines.length).toBeLessThan(500);
	});
});

describe('createFileReader', () => {
	it('tails the last lines with CRLF stripped and levels read from the text', async () => {
		const files = new Map([['/var/log/app.log', { bytes: Buffer.from('ok\r\n[error] boom\r\n'), ino: 1 }]]);
		const { io } = fakeIo(files);
		const batch = await createFileReader(io, '/var/log/app.log').tail(500);
		expect(batch.lines.map((l) => [l.text, l.level])).toEqual([
			['ok', 'info'],
			['[error] boom', 'error']
		]);
	});

	it('refuses a file this user cannot read', async () => {
		const files = new Map([['/var/log/auth.log', { bytes: Buffer.from('x\n'), ino: 1, readable: false }]]);
		const { io } = fakeIo(files);
		await expect(createFileReader(io, '/var/log/auth.log').tail(500)).rejects.toMatchObject({
			code: 'unsupported_on_node'
		});
	});

	it('follows appended lines, then through a rotation and a truncation (FR-20)', async () => {
		const path = '/var/log/app.log';
		const files = new Map([[path, { bytes: Buffer.from('a\n'), ino: 1 }]]);
		const { io, advance } = fakeIo(files);
		const reader = createFileReader(io, path);
		await reader.tail(500);
		const out = collect();
		reader.follow(out.sink);
		files.get(path)!.bytes = Buffer.from('a\nb\n');
		await advance(FILE_POLL_MS);
		files.set(path, { bytes: Buffer.from('rotated 1\n'), ino: 2 });
		await advance(FILE_POLL_MS);
		files.set(path, { bytes: Buffer.from('rotated 1\nrotated 2\n'), ino: 2 });
		await advance(FILE_POLL_MS);
		files.set(path, { bytes: Buffer.from('t\n'), ino: 2 });
		await advance(FILE_POLL_MS);
		expect(out.lines.map((l) => l.text)).toEqual(['b', 'rotated 1', 'rotated 2', 't']);
	});

	it('says the file is gone after it stays missing', async () => {
		const path = '/var/log/app.log';
		const files = new Map([[path, { bytes: Buffer.from('a\n'), ino: 1 }]]);
		const { io, advance } = fakeIo(files);
		const reader = createFileReader(io, path);
		await reader.tail(500);
		const out = collect();
		reader.follow(out.sink);
		files.delete(path);
		await advance(FILE_GONE_AFTER_MS + FILE_POLL_MS * 2);
		expect(out.notices).toContain('gone');
		expect(out.ended).toBe(true);
	});

	it('pages back from the oldest line it handed out', async () => {
		const path = '/f';
		const files = new Map([[path, { bytes: Buffer.from(numbered(10)), ino: 1 }]]);
		const { io } = fakeIo(files);
		const reader = createFileReader(io, path);
		const batch = await reader.tail(3);
		expect(batch.lines.map((l) => l.text)).toEqual(['line 8', 'line 9', 'line 10']);
		const page = await reader.earlier!(3);
		expect(page.lines.map((l) => l.text)).toEqual(['line 5', 'line 6', 'line 7']);
		expect(page.hasMore).toBe(true);
		const rest = await reader.earlier!(10);
		expect(rest.lines.map((l) => l.text)).toEqual(['line 1', 'line 2', 'line 3', 'line 4']);
		expect(rest.hasMore).toBe(false);
	});
});

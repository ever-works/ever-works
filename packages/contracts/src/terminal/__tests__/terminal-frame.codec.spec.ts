import { describe, expect, it } from 'vitest';
import {
	decodeTerminalFrame,
	encodeTerminalFrame,
	isAllowedTerminalWsUrl,
	isTerminalClientToServerFrame,
	isTerminalFrameWithinSizeCap,
	isTerminalServerToClientFrame,
	isValidTerminalRunId,
	makeTerminalErrorFrame,
	normalizeTerminalFrame
} from '../terminal-frame.codec.js';
import {
	TERMINAL_CLIENT_TO_SERVER_KINDS,
	TERMINAL_EXIT_REASONS,
	TERMINAL_MAX_AUTH_TOKEN_LENGTH,
	TERMINAL_MAX_DIMENSION,
	TERMINAL_MAX_ERROR_MESSAGE_LENGTH,
	TERMINAL_MAX_FRAME_BYTES,
	TERMINAL_SERVER_TO_CLIENT_KINDS,
	type TerminalFrame,
	type TerminalFrameKind
} from '../terminal-frame.types.js';

const RUN_ID = '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';
const B64 = 'aGVsbG8='; // "hello"

const VALID_FRAMES: TerminalFrame[] = [
	{ kind: 'stdout', seq: 0, data: B64 },
	{ kind: 'stdout', seq: Number.MAX_SAFE_INTEGER, data: '' },
	{ kind: 'stdin', data: B64 },
	{ kind: 'resize', cols: 1, rows: 1 },
	{ kind: 'resize', cols: TERMINAL_MAX_DIMENSION, rows: TERMINAL_MAX_DIMENSION },
	{ kind: 'exit', code: 0, reason: 'completed' },
	{ kind: 'exit', code: -1, reason: 'crashed' },
	{ kind: 'exit', code: 137, reason: 'closed' },
	{ kind: 'exit', code: 0, reason: 'parked' },
	{ kind: 'error', message: 'provider not configured' },
	{ kind: 'error', message: '' },
	{ kind: 'auth', token: 'eyJhbGciOiJIUzI1NiJ9.e30.sig' }
];

describe('decodeTerminalFrame — valid frames round-trip', () => {
	it.each(VALID_FRAMES.map((f) => [f.kind, f] as const))('round-trips a %s frame', (_kind, frame) => {
		const wire = encodeTerminalFrame(frame);
		expect(wire).not.toBeNull();
		expect(decodeTerminalFrame(wire as string)).toEqual(frame);
	});

	it('decodes from Uint8Array input', () => {
		const wire = new TextEncoder().encode(JSON.stringify({ kind: 'stdin', data: B64 }));
		expect(decodeTerminalFrame(wire)).toEqual({ kind: 'stdin', data: B64 });
	});

	it('strips unknown extra properties (normalized construction)', () => {
		const decoded = decodeTerminalFrame(
			JSON.stringify({ kind: 'stdin', data: B64, extra: 'smuggled', role: 'driver' })
		);
		expect(decoded).toEqual({ kind: 'stdin', data: B64 });
		expect(Object.keys(decoded as object)).toEqual(['kind', 'data']);
	});

	it('a __proto__ key stays inert and never survives decoding', () => {
		// JSON.parse creates "__proto__" as a plain own property (no setter
		// invoked); the normalizer must drop it like any unknown field and
		// must not pollute Object.prototype in the process.
		const decoded = decodeTerminalFrame('{"kind":"stdin","data":"aGk=","__proto__":{"admin":true}}');
		expect(decoded).toEqual({ kind: 'stdin', data: 'aGk=' });
		expect(Object.prototype.hasOwnProperty.call(decoded, '__proto__')).toBe(false);
		expect(({} as { admin?: boolean }).admin).toBeUndefined();
	});
});

describe('decodeTerminalFrame — null, never throw', () => {
	const GARBAGE: Array<[string, string]> = [
		['not JSON', 'nonsense{{{'],
		['empty string', ''],
		['JSON null', 'null'],
		['JSON number', '42'],
		['JSON string', '"stdout"'],
		['JSON array', '[{"kind":"stdin","data":""}]'],
		['no kind', '{"data":"aGk="}'],
		['unknown kind', '{"kind":"shutdown"}'],
		['kind from prototype chain', '{"data":"aGk=","toString":1}'],
		['kind constructor', '{"kind":"constructor"}'],
		['stdout missing seq', '{"kind":"stdout","data":"aGk="}'],
		['stdout negative seq', '{"kind":"stdout","seq":-1,"data":"aGk="}'],
		['stdout float seq', '{"kind":"stdout","seq":1.5,"data":"aGk="}'],
		['stdout NaN seq', '{"kind":"stdout","seq":null,"data":"aGk="}'],
		['stdout unsafe seq', '{"kind":"stdout","seq":9007199254740992,"data":"aGk="}'],
		['stdout numeric-string seq', '{"kind":"stdout","seq":"3","data":"aGk="}'],
		['stdin non-base64', '{"kind":"stdin","data":"not base64!!"}'],
		['stdin base64 with newline', '{"kind":"stdin","data":"aGVs\\nbG8="}'],
		['stdin bad padding', '{"kind":"stdin","data":"aGVsbG8"}'],
		['stdin data number', '{"kind":"stdin","data":7}'],
		['resize zero cols', '{"kind":"resize","cols":0,"rows":24}'],
		['resize over max rows', `{"kind":"resize","cols":80,"rows":${TERMINAL_MAX_DIMENSION + 1}}`],
		['resize float', '{"kind":"resize","cols":80.5,"rows":24}'],
		['resize string dims', '{"kind":"resize","cols":"80","rows":"24"}'],
		['resize missing rows', '{"kind":"resize","cols":80}'],
		['exit unknown reason', '{"kind":"exit","code":0,"reason":"finished"}'],
		['exit reason casing', '{"kind":"exit","code":0,"reason":"Completed"}'],
		['exit float code', '{"kind":"exit","code":0.5,"reason":"completed"}'],
		['exit code out of int32', '{"kind":"exit","code":2147483648,"reason":"completed"}'],
		['exit missing code', '{"kind":"exit","reason":"completed"}'],
		['error message number', '{"kind":"error","message":42}'],
		['auth empty token', '{"kind":"auth","token":""}'],
		['auth token with space', '{"kind":"auth","token":"two words"}'],
		['auth token with newline', '{"kind":"auth","token":"a\\nb"}'],
		['auth token number', '{"kind":"auth","token":123}']
	];

	it.each(GARBAGE)('rejects %s', (_label, wire) => {
		expect(decodeTerminalFrame(wire)).toBeNull();
	});

	it('rejects an error message over the cap', () => {
		const wire = JSON.stringify({
			kind: 'error',
			message: 'x'.repeat(TERMINAL_MAX_ERROR_MESSAGE_LENGTH + 1)
		});
		expect(decodeTerminalFrame(wire)).toBeNull();
	});

	it('rejects an auth token over the cap', () => {
		const wire = JSON.stringify({ kind: 'auth', token: 'a'.repeat(TERMINAL_MAX_AUTH_TOKEN_LENGTH + 1) });
		expect(decodeTerminalFrame(wire)).toBeNull();
	});

	it('rejects invalid UTF-8 bytes without throwing', () => {
		expect(decodeTerminalFrame(new Uint8Array([0xff, 0xfe, 0x7b, 0x7d]))).toBeNull();
	});

	it('rejects non-string/bytes input without throwing', () => {
		expect(decodeTerminalFrame(42 as unknown as string)).toBeNull();
		expect(decodeTerminalFrame(null as unknown as string)).toBeNull();
		expect(decodeTerminalFrame(undefined as unknown as string)).toBeNull();
		expect(decodeTerminalFrame({} as unknown as string)).toBeNull();
	});

	it('fuzz: random mutations of valid wire text never throw', () => {
		const base = VALID_FRAMES.map((f) => JSON.stringify(f));
		let seed = 0x2f6e2b1;
		const rand = () => {
			// Deterministic LCG so failures reproduce.
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		for (let i = 0; i < 2000; i++) {
			const src = base[Math.floor(rand() * base.length)];
			const pos = Math.floor(rand() * src.length);
			const ch = String.fromCharCode(Math.floor(rand() * 128));
			const mutated = src.slice(0, pos) + ch + src.slice(pos + 1);
			expect(() => decodeTerminalFrame(mutated)).not.toThrow();
		}
	});
});

describe('size cap — checked before parse', () => {
	it('accepts a frame at the boundary and rejects one past it', () => {
		// Build a stdout frame whose wire size lands exactly on the cap.
		const overhead = JSON.stringify({ kind: 'stdout', seq: 0, data: '' }).length;
		const padTo = TERMINAL_MAX_FRAME_BYTES - overhead;
		const data = 'A'.repeat(padTo - (padTo % 4));
		const atCap = JSON.stringify({ kind: 'stdout', seq: 0, data });
		expect(atCap.length).toBeLessThanOrEqual(TERMINAL_MAX_FRAME_BYTES);
		expect(decodeTerminalFrame(atCap)).not.toBeNull();

		const past = JSON.stringify({
			kind: 'stdout',
			seq: 0,
			data: 'A'.repeat(TERMINAL_MAX_FRAME_BYTES)
		});
		expect(past.length).toBeGreaterThan(TERMINAL_MAX_FRAME_BYTES);
		expect(decodeTerminalFrame(past)).toBeNull();
	});

	it('rejects oversized Uint8Array input by byteLength', () => {
		expect(isTerminalFrameWithinSizeCap(new Uint8Array(TERMINAL_MAX_FRAME_BYTES + 1))).toBe(false);
		expect(isTerminalFrameWithinSizeCap(new Uint8Array(TERMINAL_MAX_FRAME_BYTES))).toBe(true);
	});

	it('accounts for multi-byte characters in string input', () => {
		// Each '€' is 1 UTF-16 code unit but 3 UTF-8 bytes: a string whose
		// code-unit length is under the cap can still overflow it in bytes.
		const euros = '€'.repeat(Math.floor(TERMINAL_MAX_FRAME_BYTES / 3) + 10);
		expect(euros.length).toBeLessThan(TERMINAL_MAX_FRAME_BYTES);
		expect(isTerminalFrameWithinSizeCap(euros)).toBe(false);
	});
});

describe('encodeTerminalFrame', () => {
	it('refuses to encode an invalid frame', () => {
		expect(encodeTerminalFrame({ kind: 'resize', cols: 0, rows: 24 } as TerminalFrame)).toBeNull();
		expect(encodeTerminalFrame({ kind: 'exit', code: 0, reason: 'nope' } as unknown as TerminalFrame)).toBeNull();
		expect(encodeTerminalFrame({ kind: 'stdout', seq: 0, data: '!!' } as TerminalFrame)).toBeNull();
	});

	it('drops smuggled extra fields on encode', () => {
		const wire = encodeTerminalFrame({
			kind: 'stdin',
			data: B64,
			role: 'driver'
		} as unknown as TerminalFrame);
		expect(wire).not.toBeNull();
		expect(JSON.parse(wire as string)).toEqual({ kind: 'stdin', data: B64 });
	});
});

describe('makeTerminalErrorFrame', () => {
	it('passes short messages through', () => {
		expect(makeTerminalErrorFrame('boom')).toEqual({ kind: 'error', message: 'boom' });
	});

	it('truncates instead of rejecting (banner sites must always succeed)', () => {
		const frame = makeTerminalErrorFrame('y'.repeat(TERMINAL_MAX_ERROR_MESSAGE_LENGTH * 2));
		expect(frame.kind).toBe('error');
		const message = (frame as { message: string }).message;
		expect(message.length).toBeLessThanOrEqual(TERMINAL_MAX_ERROR_MESSAGE_LENGTH);
		expect(message.endsWith('…')).toBe(true);
		// The truncated frame is itself wire-valid.
		expect(encodeTerminalFrame(frame)).not.toBeNull();
	});
});

describe('direction map', () => {
	it('classifies every kind in exactly one direction', () => {
		const all: TerminalFrameKind[] = ['stdout', 'stdin', 'resize', 'exit', 'error', 'auth'];
		for (const kind of all) {
			const c2s = (TERMINAL_CLIENT_TO_SERVER_KINDS as readonly string[]).includes(kind);
			const s2c = (TERMINAL_SERVER_TO_CLIENT_KINDS as readonly string[]).includes(kind);
			expect(c2s !== s2c).toBe(true);
		}
	});

	it('replayed stdout can never re-enter as client input', () => {
		expect(isTerminalClientToServerFrame({ kind: 'stdout', seq: 1, data: B64 })).toBe(false);
		expect(isTerminalClientToServerFrame({ kind: 'exit', code: 0, reason: 'completed' })).toBe(false);
		expect(isTerminalClientToServerFrame({ kind: 'stdin', data: B64 })).toBe(true);
		expect(isTerminalClientToServerFrame({ kind: 'resize', cols: 80, rows: 24 })).toBe(true);
		expect(isTerminalClientToServerFrame({ kind: 'auth', token: 't' })).toBe(true);
	});

	it('a client can never inject fake terminal output server-side', () => {
		expect(isTerminalServerToClientFrame({ kind: 'stdout', seq: 1, data: B64 })).toBe(true);
		expect(isTerminalServerToClientFrame({ kind: 'exit', code: 0, reason: 'completed' })).toBe(true);
		expect(isTerminalServerToClientFrame({ kind: 'error', message: 'x' })).toBe(true);
		expect(isTerminalServerToClientFrame({ kind: 'stdin', data: B64 })).toBe(false);
		expect(isTerminalServerToClientFrame({ kind: 'auth', token: 't' })).toBe(false);
	});
});

describe('exit reasons', () => {
	it('every declared reason decodes', () => {
		for (const reason of TERMINAL_EXIT_REASONS) {
			expect(decodeTerminalFrame(JSON.stringify({ kind: 'exit', code: 0, reason }))).toEqual({
				kind: 'exit',
				code: 0,
				reason
			});
		}
	});
});

describe('isValidTerminalRunId', () => {
	it('accepts RFC 4122 UUIDs (case-insensitive)', () => {
		expect(isValidTerminalRunId(RUN_ID)).toBe(true);
		expect(isValidTerminalRunId(RUN_ID.toUpperCase())).toBe(true);
	});

	it.each([
		['empty', ''],
		['not a uuid', 'agent-run-1'],
		['path traversal', '../../../etc/passwd'],
		['uuid with suffix', `${RUN_ID}x`],
		['uuid with prefix', ` ${RUN_ID}`],
		['sql-ish', `${RUN_ID}' OR '1'='1`],
		['non-string', 42 as unknown as string],
		['null', null as unknown as string]
	])('rejects %s', (_label, value) => {
		expect(isValidTerminalRunId(value)).toBe(false);
	});
});

describe('isAllowedTerminalWsUrl', () => {
	it.each([
		'wss://api.ever.works/ws/terminal/run-1',
		'wss://localhost:3100/ws/terminal/run-1',
		'ws://localhost:3100/ws/terminal/run-1',
		'ws://127.0.0.1:3100/ws',
		'ws://[::1]:3100/ws'
	])('allows %s', (url) => {
		expect(isAllowedTerminalWsUrl(url)).toBe(true);
	});

	it.each([
		'ws://api.ever.works/ws/terminal/run-1',
		'ws://192.168.1.10:3100/ws',
		'ws://evil.example.com/ws',
		'http://localhost:3100/ws',
		'https://localhost:3100/ws',
		'ftp://localhost/x',
		'not a url',
		'',
		'//localhost:3100/ws'
	])('refuses %s', (url) => {
		expect(isAllowedTerminalWsUrl(url)).toBe(false);
	});

	it('never throws on non-string input', () => {
		expect(isAllowedTerminalWsUrl(null)).toBe(false);
		expect(isAllowedTerminalWsUrl(12)).toBe(false);
		expect(isAllowedTerminalWsUrl({})).toBe(false);
	});
});

describe('normalizeTerminalFrame (structured input path)', () => {
	it('validates a parsed publish-endpoint body element', () => {
		expect(normalizeTerminalFrame({ kind: 'stdout', seq: 3, data: B64 })).toEqual({
			kind: 'stdout',
			seq: 3,
			data: B64
		});
	});

	it('rejects arrays, functions, and class instances masquerading as frames', () => {
		expect(normalizeTerminalFrame([])).toBeNull();
		expect(normalizeTerminalFrame(() => undefined)).toBeNull();
		expect(normalizeTerminalFrame(new (class X {})())).toBeNull();
		expect(normalizeTerminalFrame(Object.create(null))).toBeNull();
	});

	it('ignores a kind supplied via the prototype chain', () => {
		const crafted = Object.create({ kind: 'stdin', data: B64 });
		expect(normalizeTerminalFrame(crafted)).toBeNull();
	});

	it('a throwing getter or hostile Proxy returns null, never throws', () => {
		const throwingGetter = {
			get kind(): string {
				throw new Error('trap');
			}
		};
		expect(normalizeTerminalFrame(throwingGetter)).toBeNull();

		const throwingField = {
			kind: 'stdin',
			get data(): string {
				throw new Error('trap');
			}
		};
		expect(normalizeTerminalFrame(throwingField)).toBeNull();

		const hostileProxy = new Proxy(
			{},
			{
				has() {
					throw new Error('trap');
				},
				get() {
					throw new Error('trap');
				},
				getOwnPropertyDescriptor() {
					throw new Error('trap');
				}
			}
		);
		expect(normalizeTerminalFrame(hostileProxy)).toBeNull();

		// encode routes through the same normalizer — equally protected.
		expect(encodeTerminalFrame(throwingGetter as unknown as TerminalFrame)).toBeNull();
	});
});

describe('canonical base64 (unused final-quantum bits must be zero)', () => {
	it('accepts the canonical representation', () => {
		// "A" = one byte 0x41 → canonical 'QQ=='; "AB" → 'QUI='.
		expect(decodeTerminalFrame('{"kind":"stdin","data":"QQ=="}')).not.toBeNull();
		expect(decodeTerminalFrame('{"kind":"stdin","data":"QUI="}')).not.toBeNull();
		expect(decodeTerminalFrame('{"kind":"stdin","data":"AA=="}')).not.toBeNull();
	});

	it('rejects non-canonical padding bits (one byte sequence, one wire form)', () => {
		// 'AB==' decodes to the same byte as 'AA==' but with dangling
		// nonzero bits — two wire forms for identical PTY data.
		expect(decodeTerminalFrame('{"kind":"stdin","data":"AB=="}')).toBeNull();
		expect(decodeTerminalFrame('{"kind":"stdin","data":"QR=="}')).toBeNull();
		expect(decodeTerminalFrame('{"kind":"stdin","data":"QUJ="}')).toBeNull();
		expect(decodeTerminalFrame('{"kind":"stdout","seq":0,"data":"AB=="}')).toBeNull();
	});
});

import { describe, expect, it } from 'vitest';
import type { RemoteConnection } from '../shared/ipc-contract';
import type { ProbeFetch } from './remote-connection';
import {
	allowedOriginsFor,
	deriveApiUrl,
	isInsecureRemote,
	normalizeBaseUrl,
	probeRemote,
	remoteHealthUrl,
	resolveRemoteConnection
} from './remote-connection';

describe('normalizeBaseUrl', () => {
	it('assumes https for a bare host and strips trailing slashes / query / hash', () => {
		expect(normalizeBaseUrl('app.example.com')).toBe('https://app.example.com');
		expect(normalizeBaseUrl(' https://app.example.com/// ')).toBe('https://app.example.com');
		expect(normalizeBaseUrl('https://app.example.com/base/?x=1#frag')).toBe('https://app.example.com/base');
	});

	it('keeps an explicit http scheme and a port', () => {
		expect(normalizeBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
	});

	it('rejects empty, unparseable, non-http and credential-bearing URLs', () => {
		expect(normalizeBaseUrl('')).toBeUndefined();
		expect(normalizeBaseUrl('   ')).toBeUndefined();
		expect(normalizeBaseUrl(undefined)).toBeUndefined();
		expect(normalizeBaseUrl('ftp://example.com')).toBeUndefined();
		expect(normalizeBaseUrl('file:///etc/passwd')).toBeUndefined();
		expect(normalizeBaseUrl('https://user:secret@example.com')).toBeUndefined();
	});
});

describe('deriveApiUrl', () => {
	it('maps app.<domain> to api.<domain>', () => {
		expect(deriveApiUrl('https://app.ever.works')).toBe('https://api.ever.works');
		expect(deriveApiUrl('app.example.co.uk')).toBe('https://api.example.co.uk');
	});

	it('falls back to the same origin for single-origin and local installs', () => {
		expect(deriveApiUrl('http://localhost:3000')).toBe('http://localhost:3000');
		expect(deriveApiUrl('https://works.internal')).toBe('https://works.internal');
	});

	it('returns undefined for an unusable URL', () => {
		expect(deriveApiUrl('not a url at all ///')).toBeUndefined();
	});
});

describe('isInsecureRemote', () => {
	it('flags plain http to a non-loopback host only', () => {
		expect(isInsecureRemote('http://example.com')).toBe(true);
		expect(isInsecureRemote('http://localhost:3000')).toBe(false);
		expect(isInsecureRemote('http://127.0.0.1:3000')).toBe(false);
		expect(isInsecureRemote('https://example.com')).toBe(false);
	});
});

describe('resolveRemoteConnection', () => {
	it('derives the API URL and reports no warnings for an https instance', () => {
		const result = resolveRemoteConnection({ webUrl: 'https://app.example.com/' });
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.connection).toEqual({ webUrl: 'https://app.example.com', apiUrl: 'https://api.example.com' });
		expect(result.warnings).toEqual([]);
	});

	it('prefers an explicitly entered API URL over the derived one', () => {
		const result = resolveRemoteConnection({
			webUrl: 'https://app.example.com',
			apiUrl: 'https://backend.example.com/api-root/',
			label: '  Staging  '
		});
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.connection.apiUrl).toBe('https://backend.example.com/api-root');
		expect(result.connection.label).toBe('Staging');
	});

	it('warns (but does not block) on plain HTTP to a remote host', () => {
		const result = resolveRemoteConnection({ webUrl: 'http://works.internal' });
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain('not encrypted');
	});

	it('rejects a missing or malformed instance URL', () => {
		expect(resolveRemoteConnection(undefined).ok).toBe(false);
		expect(resolveRemoteConnection({ webUrl: '' }).ok).toBe(false);
		const bad = resolveRemoteConnection({ webUrl: 'ftp://example.com' });
		expect(bad.ok).toBe(false);
		if (bad.ok) {
			return;
		}
		expect(bad.errors[0]).toContain('instance URL');
	});

	it('rejects a malformed explicit API URL', () => {
		const result = resolveRemoteConnection({ webUrl: 'https://app.example.com', apiUrl: 'ftp://nope' });
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.errors).toContain('The API URL is not a valid http/https URL.');
	});
});

describe('probeRemote', () => {
	const connection: RemoteConnection = { webUrl: 'https://app.example.com', apiUrl: 'https://api.example.com' };

	it('builds the health URL from the API base', () => {
		expect(remoteHealthUrl(connection)).toBe('https://api.example.com/api/health');
	});

	it('reports ok and the reported version on a healthy response', async () => {
		const fetchFn: ProbeFetch = async (url) => {
			expect(url).toBe('https://api.example.com/api/health');
			return { ok: true, status: 200, json: async () => ({ version: '1.2.3' }) };
		};
		await expect(probeRemote(connection, fetchFn)).resolves.toEqual({ ok: true, status: 200, version: '1.2.3' });
	});

	it('tolerates a health payload without a version', async () => {
		const fetchFn: ProbeFetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'up' }) });
		await expect(probeRemote(connection, fetchFn)).resolves.toEqual({ ok: true, status: 200 });
	});

	it('tolerates a health payload that is not JSON', async () => {
		const fetchFn: ProbeFetch = async () => ({
			ok: true,
			status: 200,
			json: async () => {
				throw new Error('not json');
			}
		});
		await expect(probeRemote(connection, fetchFn)).resolves.toEqual({ ok: true, status: 200 });
	});

	it('surfaces a non-2xx status', async () => {
		const fetchFn: ProbeFetch = async () => ({ ok: false, status: 502 });
		const result = await probeRemote(connection, fetchFn);
		expect(result.ok).toBe(false);
		expect(result.status).toBe(502);
		expect(result.message).toContain('502');
	});

	it('never throws on a transport failure', async () => {
		const fetchFn: ProbeFetch = async () => {
			throw new Error('ENOTFOUND');
		};
		const result = await probeRemote(connection, fetchFn);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('ENOTFOUND');
	});
});

describe('allowedOriginsFor', () => {
	const localOrigins = ['http://localhost:3000', 'http://localhost:3100'];

	it('keeps the local service origins when there is no remote connection', () => {
		expect(allowedOriginsFor(undefined, localOrigins)).toEqual(localOrigins);
	});

	it('swaps in the remote web + api origins in client mode', () => {
		expect(
			allowedOriginsFor({ webUrl: 'https://app.example.com/x', apiUrl: 'https://api.example.com' }, localOrigins)
		).toEqual(['https://app.example.com', 'https://api.example.com']);
	});

	it('collapses a single-origin instance to one entry', () => {
		expect(
			allowedOriginsFor({ webUrl: 'https://works.internal', apiUrl: 'https://works.internal' }, localOrigins)
		).toEqual(['https://works.internal']);
	});
});

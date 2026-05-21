import { describe, it, expect, vi } from 'vitest';
import { lfsBatch, lfsUpload, lfsDownload } from '../lfs-batch.js';

function mockFetch(impls: Array<(url: string, init?: RequestInit) => Promise<Response>>) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const next = impls.shift();
		if (!next) throw new Error(`Unexpected extra fetch call: ${String(url)}`);
		calls.push({ url: String(url), init });
		return next(String(url), init);
	}) as unknown as typeof fetch;
	return { fn, calls };
}

const target = { owner: 'acme', repo: 'storage', token: 'ghp_xxx' };

describe('lfsBatch (upload)', () => {
	it('POSTs to the LFS batch endpoint with the right shape', async () => {
		const { fn, calls } = mockFetch([
			async () =>
				new Response(
					JSON.stringify({
						objects: [
							{
								oid: 'a'.repeat(64),
								size: 100,
								actions: {
									upload: {
										href: 'https://lfs.example.com/upload',
										header: { Authorization: 'Bearer sig' }
									}
								}
							}
						]
					}),
					{ status: 200, headers: { 'Content-Type': 'application/vnd.git-lfs+json' } }
				)
		]);
		const result = await lfsBatch(target, { oid: 'a'.repeat(64), size: 100 }, 'upload', fn);
		expect(result.kind).toBe('action');
		if (result.kind === 'action') {
			expect(result.upload?.href).toBe('https://lfs.example.com/upload');
			expect(result.upload?.header?.Authorization).toBe('Bearer sig');
		}
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://github.com/acme/storage.git/info/lfs/objects/batch');
		const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer ghp_xxx');
		expect(headers.Accept).toBe('application/vnd.git-lfs+json');
		const body = JSON.parse(String(calls[0].init?.body));
		expect(body.operation).toBe('upload');
		expect(body.objects[0].oid).toBe('a'.repeat(64));
		expect(body.objects[0].size).toBe(100);
	});

	it('returns already-exists when the object has no actions', async () => {
		const { fn } = mockFetch([
			async () =>
				new Response(JSON.stringify({ objects: [{ oid: 'b'.repeat(64), size: 1, actions: {} }] }), {
					status: 200,
					headers: { 'Content-Type': 'application/vnd.git-lfs+json' }
				})
		]);
		const result = await lfsBatch(target, { oid: 'b'.repeat(64), size: 1 }, 'upload', fn);
		expect(result.kind).toBe('already-exists');
	});

	it('propagates HTTP errors as kind=error', async () => {
		const { fn } = mockFetch([async () => new Response('LFS disabled on repo', { status: 403 })]);
		const result = await lfsBatch(target, { oid: 'c'.repeat(64), size: 1 }, 'upload', fn);
		expect(result.kind).toBe('error');
		if (result.kind === 'error') {
			expect(result.status).toBe(403);
			expect(result.message).toMatch(/LFS disabled/);
		}
	});

	it('propagates per-object errors from the batch response', async () => {
		const { fn } = mockFetch([
			async () =>
				new Response(
					JSON.stringify({
						objects: [{ oid: 'd'.repeat(64), size: 1, error: { code: 404, message: 'not found' } }]
					}),
					{ status: 200, headers: { 'Content-Type': 'application/vnd.git-lfs+json' } }
				)
		]);
		const result = await lfsBatch(target, { oid: 'd'.repeat(64), size: 1 }, 'upload', fn);
		expect(result).toEqual({ kind: 'error', status: 404, message: 'not found' });
	});
});

describe('lfsUpload', () => {
	it('PUTs the buffer to the signed URL with the supplied headers', async () => {
		const { fn, calls } = mockFetch([async () => new Response('', { status: 200 })]);
		const buf = Buffer.from('hello world');
		const out = await lfsUpload(
			{ href: 'https://lfs.example.com/upload', header: { Authorization: 'Bearer sig' } },
			buf,
			fn
		);
		expect(out.ok).toBe(true);
		expect(calls[0].url).toBe('https://lfs.example.com/upload');
		expect(calls[0].init?.method).toBe('PUT');
		const hdrs = (calls[0].init?.headers ?? {}) as Record<string, string>;
		expect(hdrs['Content-Length']).toBe(String(buf.length));
		expect(hdrs.Authorization).toBe('Bearer sig');
	});

	it('returns ok:false with status when the LFS host rejects', async () => {
		const { fn } = mockFetch([async () => new Response('quota exceeded', { status: 507 })]);
		const out = await lfsUpload({ href: 'https://lfs.example.com/upload' }, Buffer.from('x'), fn);
		expect(out.ok).toBe(false);
		if (!out.ok) {
			expect(out.status).toBe(507);
			expect(out.message).toMatch(/quota/);
		}
	});
});

describe('lfsDownload', () => {
	it('streams the body back as a Buffer', async () => {
		const bytes = Buffer.from([1, 2, 3, 4, 5]);
		const { fn } = mockFetch([async () => new Response(new Uint8Array(bytes), { status: 200 })]);
		const out = await lfsDownload({ href: 'https://lfs.example.com/dl' }, fn);
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.buffer).toEqual(bytes);
		}
	});
});

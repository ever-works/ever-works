import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SignedStatsReport } from '@ever-works/contracts';
import { EverStatsSinkPlugin, mapAnswer } from '../ever-stats-sink.plugin.js';

/**
 * The plugin posts the signed body BYTE FOR BYTE, with the signature headers
 * as given, refuses redirects and anything but a safe base URL, and maps every
 * answer of the published status table onto the closed result.
 */

interface Received {
	method: string;
	url: string;
	headers: IncomingMessage['headers'];
	body: Buffer;
}

function report(body = '{"schema":"ever.stats.v1","k":"é"}'): SignedStatsReport {
	return {
		body: new TextEncoder().encode(body),
		headers: {
			'Ever-Stats-Key': 'a'.repeat(43),
			'Ever-Stats-Signature': `ed25519=${'b'.repeat(86)}`,
			'Ever-Stats-Key-Id': 'c'.repeat(11)
		},
		reportId: '63d8c277-7fa0-4f5d-a5a7-c88fc94e6186',
		period: '2026-10',
		final: false
	};
}

const OPTIONS = { timeoutMs: 5_000, userAgent: 'ever-stats/1.0.0 (works/1.4.2)' };

describe('EverStatsSinkPlugin.send against a local receiver', () => {
	let server: Server;
	let base: string;
	const received: Received[] = [];
	let answer: { status: number; body?: string; headers?: Record<string, string> } = { status: 202 };

	beforeEach(async () => {
		received.length = 0;
		answer = { status: 202, body: '{"accepted":true}' };
		server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => {
				received.push({
					method: req.method ?? '',
					url: req.url ?? '',
					headers: req.headers,
					body: Buffer.concat(chunks)
				});
				res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers ?? {}) });
				res.end(answer.body ?? '');
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it('posts the exact signed bytes and headers to /v1/stats/reports', async () => {
		const signed = report();
		const result = await new EverStatsSinkPlugin().send(signed, { ...OPTIONS, baseUrl: `${base}/` });

		expect(result).toEqual({ status: 'sent', httpStatus: 202, errorCode: null });
		expect(received).toHaveLength(1);
		const [request] = received;
		expect(request.method).toBe('POST');
		expect(request.url).toBe('/v1/stats/reports');
		// Byte-identical: compare buffers, not decoded strings.
		expect(Buffer.compare(request.body, Buffer.from(signed.body))).toBe(0);
		expect(request.headers['ever-stats-key']).toBe(signed.headers['Ever-Stats-Key']);
		expect(request.headers['ever-stats-signature']).toBe(signed.headers['Ever-Stats-Signature']);
		expect(request.headers['ever-stats-key-id']).toBe(signed.headers['Ever-Stats-Key-Id']);
		expect(request.headers['content-type']).toBe('application/json');
		expect(request.headers['user-agent']).toBe(OPTIONS.userAgent);
		// Nothing identifying travels with the report.
		expect(request.headers.cookie).toBeUndefined();
		expect(request.headers.authorization).toBeUndefined();
	});

	it('reports a superseded acceptance', async () => {
		answer = { status: 202, body: '{"accepted":true,"superseded":true}' };
		const result = await new EverStatsSinkPlugin().send(report(), { ...OPTIONS, baseUrl: base });
		expect(result).toEqual({ status: 'sent', httpStatus: 202, errorCode: null, superseded: true });
	});

	it('keeps only the path and code of each refused field on a 422', async () => {
		answer = {
			status: 422,
			body: JSON.stringify({
				type: 'about:blank',
				code: 'schema_violation',
				errors: [{ path: '/tenant_name', code: 'unknown_field', message: 'field not allowed' }]
			})
		};
		const result = await new EverStatsSinkPlugin().send(report(), { ...OPTIONS, baseUrl: base });
		expect(result).toEqual({
			status: 'rejected',
			httpStatus: 422,
			errorCode: 'schema_violation',
			errors: [{ path: '/tenant_name', code: 'unknown_field' }]
		});
	});

	it('does not follow a redirect', async () => {
		answer = { status: 302, headers: { location: `${base}/elsewhere` } };
		const result = await new EverStatsSinkPlugin().send(report(), { ...OPTIONS, baseUrl: base });
		expect(result).toEqual({ status: 'failed', httpStatus: 302, errorCode: 'redirect' });
		expect(received.map((request) => request.url)).toEqual(['/v1/stats/reports']);
	});
});

describe('EverStatsSinkPlugin.send refusals without a request', () => {
	const neverCalled = async (): Promise<Response> => {
		throw new Error('fetch must not be called');
	};

	it.each([
		['plain http to a public host', 'http://stats.example.com'],
		['credentials in the URL', 'https://user:pass@stats.example.com'],
		['a query string', 'https://stats.example.com/?x=1'],
		['another scheme', 'ftp://stats.example.com'],
		['not a URL', 'stats']
	])('refuses %s', async (_label, baseUrl) => {
		const result = await new EverStatsSinkPlugin(neverCalled).send(report(), { ...OPTIONS, baseUrl });
		expect(result).toEqual({ status: 'rejected', httpStatus: null, errorCode: 'invalid_url' });
	});

	it('refuses a body above 16 KiB', async () => {
		const result = await new EverStatsSinkPlugin(neverCalled).send(report('x'.repeat(16_385)), {
			...OPTIONS,
			baseUrl: 'https://stats.example.com'
		});
		expect(result).toEqual({ status: 'rejected', httpStatus: null, errorCode: 'too_large' });
	});

	it('maps a network error and a timeout to failed', async () => {
		const network = new EverStatsSinkPlugin(async () => {
			throw new TypeError('fetch failed');
		});
		expect(await network.send(report(), { ...OPTIONS, baseUrl: 'https://stats.example.com' })).toEqual({
			status: 'failed',
			httpStatus: null,
			errorCode: 'network'
		});
		const timeout = new EverStatsSinkPlugin(async () => {
			throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
		});
		expect(await timeout.send(report(), { ...OPTIONS, baseUrl: 'https://stats.example.com' })).toEqual({
			status: 'failed',
			httpStatus: null,
			errorCode: 'timeout'
		});
	});
});

describe('mapAnswer — the published status table', () => {
	it.each([
		[202, { accepted: true }, { status: 'sent', httpStatus: 202, errorCode: null }],
		[400, { code: 'validation_failed' }, { status: 'rejected', httpStatus: 400, errorCode: 'validation_failed' }],
		[400, { code: 'signature_invalid' }, { status: 'rejected', httpStatus: 400, errorCode: 'signature_invalid' }],
		[409, { code: 'key_mismatch' }, { status: 'rejected', httpStatus: 409, errorCode: 'key_mismatch' }],
		[413, { code: 'validation_failed' }, { status: 'rejected', httpStatus: 413, errorCode: 'too_large' }],
		[415, null, { status: 'rejected', httpStatus: 415, errorCode: 'unsupported_media_type' }],
		[429, { code: 'rate_limited' }, { status: 'failed', httpStatus: 429, errorCode: 'rate_limited' }],
		[500, null, { status: 'failed', httpStatus: 500, errorCode: 'server_error' }],
		[503, null, { status: 'failed', httpStatus: 503, errorCode: 'server_error' }],
		[404, null, { status: 'rejected', httpStatus: 404, errorCode: 'http_error' }],
		[301, null, { status: 'failed', httpStatus: 301, errorCode: 'redirect' }]
	])('%s maps as published', (status, answer, expected) => {
		expect(mapAnswer(status, answer)).toEqual(expected);
	});

	it('drops a refused field whose path is not a short string, and any free-text code', () => {
		expect(
			mapAnswer(422, {
				errors: [{ path: 42 }, { path: '/a', code: 'Some Free Text' }, { path: '/b', code: 'pattern' }]
			})
		).toEqual({
			status: 'rejected',
			httpStatus: 422,
			errorCode: 'schema_violation',
			errors: [
				{ path: '/a', code: null },
				{ path: '/b', code: 'pattern' }
			]
		});
	});
});

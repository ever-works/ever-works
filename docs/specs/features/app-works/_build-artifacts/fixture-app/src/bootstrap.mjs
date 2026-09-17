/**
 * The `bootstrap` job — `.works/works.yml` runs `node src/bootstrap.mjs` as a `first-deploy` job, i.e.
 * **before the ingress is published**, and it exists to make one ordering fact observable (ACC-13-03):
 *
 *   the job saw the app through its **internal** address, and did **not** see it through its **public**
 *   address.
 *
 * `sawPublicApp` is deliberately strict: the app only counts as seen when the response is `200` **and**
 * its `/marker` equals this App Work's marker. An ingress controller's default `404` for an unknown
 * host, or any other application answering on that URL, is "not this app".
 *
 * `GET /state` reports the latest run as `bootstrap: { ranAt, sawInternalApp, sawPublicApp }`.
 *
 * Exit codes: 0 recorded (whatever the two observations were), 1 the internal address did not answer
 * with this app (the deployment is not actually up behind its Service), 2 misconfiguration.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { connect, displaySafeUrl, recordBootstrap } from './db.mjs';
import { isMain } from './server.mjs';

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Fetch `<baseUrl>/marker` and decide whether that response is this app.
 * Never throws: every failure is an observation, because the job exists to record observations.
 * @param {string} baseUrl @param {string} marker
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 */
export async function probeMarker(baseUrl, marker, options = {}) {
	const doFetch = options.fetchImpl ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const url = `${String(baseUrl || '').replace(/\/+$/, '')}/marker`;
	if (!baseUrl) return { url, status: null, marker: null, sawApp: false, reason: 'no address configured' };
	try {
		const response = await doFetch(url, {
			method: 'GET',
			redirect: 'manual', // a redirect to somewhere else is not this app
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(timeoutMs)
		});
		let body = null;
		let text = '';
		try {
			text = await response.text();
			body = JSON.parse(text);
		} catch {
			body = null;
		}
		if (response.status !== 200) {
			return { url, status: response.status, marker: body?.marker ?? null, sawApp: false, reason: `HTTP ${response.status}` };
		}
		if (!body || typeof body.marker !== 'string') {
			return { url, status: 200, marker: null, sawApp: false, reason: 'the response was not this app\'s /marker JSON' };
		}
		if (body.marker !== marker) {
			return { url, status: 200, marker: body.marker, sawApp: false, reason: 'a different marker answered — another application is on this address' };
		}
		return { url, status: 200, marker: body.marker, sawApp: true, reason: 'the app answered with this App Work\'s marker' };
	} catch (error) {
		const reason = error instanceof Error ? (error.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : error.message) : String(error);
		return { url, status: null, marker: null, sawApp: false, reason };
	}
}

/**
 * @param {{env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, timeoutMs?: number, dryRun?: boolean,
 *          log?: (line: string) => void, connectImpl?: typeof connect}} [options]
 */
export async function bootstrap(options = {}) {
	const env = options.env ?? process.env;
	const log = options.log ?? console.log;
	const internalUrl = env.FIXTURE_INTERNAL_URL;
	const publicUrl = env.FIXTURE_PUBLIC_URL;
	const marker = env.FIXTURE_MARKER;

	if (!internalUrl) throw Object.assign(new Error('FIXTURE_INTERNAL_URL is not set (components.web.internalUrl)'), { exitCode: 2 });
	if (!marker) throw Object.assign(new Error('FIXTURE_MARKER is not set — nothing to compare the app against'), { exitCode: 2 });

	const timeoutMs = Number(env.FIXTURE_PROBE_TIMEOUT_MS) > 0 ? Number(env.FIXTURE_PROBE_TIMEOUT_MS) : options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const internal = await probeMarker(internalUrl, marker, { fetchImpl: options.fetchImpl, timeoutMs });
	const isPublicSameAsInternal = Boolean(publicUrl) && publicUrl === internalUrl;
	const publicly = isPublicSameAsInternal
		? { url: `${publicUrl}/marker`, status: null, marker: null, sawApp: false, reason: 'the public and internal addresses are the same, so this is not a public-reachability observation' }
		: await probeMarker(publicUrl, marker, { fetchImpl: options.fetchImpl, timeoutMs });

	const result = {
		internalUrl,
		publicUrl: publicUrl || null,
		marker,
		sawInternalApp: internal.sawApp,
		sawPublicApp: publicly.sawApp,
		internal: { ...internal, url: displaySafeUrl(internal.url) },
		public: { ...publicly, url: displaySafeUrl(publicly.url) }
	};

	log(`bootstrap: internal (${result.internal.url}) → ${internal.sawApp ? 'saw this app' : `did not see it: ${internal.reason}`}`);
	log(`bootstrap: public   (${result.public.url}) → ${publicly.sawApp ? 'saw this app' : `did not see it: ${publicly.reason}`}`);

	if (!options.dryRun) {
		if (!env.DATABASE_URL) throw Object.assign(new Error('DATABASE_URL is not set — the observation cannot be recorded'), { exitCode: 2 });
		const client = await connect(env);
		try {
			await recordBootstrap(client, result);
		} finally {
			await client.end().catch(() => undefined);
		}
		log('bootstrap: recorded in bootstrap_checks');
	} else {
		log('bootstrap: --dry-run, nothing recorded');
	}

	if (!internal.sawApp) {
		const error = new Error(`the app did not answer on its internal address (${result.internal.url}): ${internal.reason}`);
		error.exitCode = 1;
		throw error;
	}
	return result;
}

if (isMain()) {
	try {
		const result = await bootstrap({ dryRun: process.argv.includes('--dry-run') });
		process.stdout.write(`${JSON.stringify({ event: 'bootstrap', sawInternalApp: result.sawInternalApp, sawPublicApp: result.sawPublicApp })}\n`);
		process.exit(0);
	} catch (error) {
		process.stderr.write(`bootstrap: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(error?.exitCode ?? 1);
	}
}

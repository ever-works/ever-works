/**
 * The fixture's whole configuration surface, read once and named once.
 *
 * Every name here is one the App spec binds (`.works/works.yml` §`spec.env`), plus a `FIXTURE_*` knob
 * for each thing a test needs to move (timeouts, directories, a worker interval). Nothing is invented
 * at run time and nothing is logged: the two secrets (`FIXTURE_SESSION_SECRET`, `FIXTURE_CRON_TOKEN`)
 * leave this module only as a value to compare against — `GET /state` reports the session secret's
 * length and a hash prefix instead (blueprint README: "Generated env, never rotated").
 */

import path from 'node:path';

/** @param {NodeJS.ProcessEnv} [env] */
export function loadConfig(env = process.env) {
	const port = numberOr(env.PORT, numberOr(env.FIXTURE_PORT, 8080));
	return {
		/** The port `.works/works.yml` declares for the `web` component. */
		port,
		host: env.HOST || '0.0.0.0',
		marker: env.FIXTURE_MARKER ?? '',
		gitSha: env.FIXTURE_GIT_SHA ?? '',
		buildLabel: env.FIXTURE_BUILD_LABEL ?? '',
		publicUrl: normalizeUrl(env.FIXTURE_PUBLIC_URL),
		internalUrl: normalizeUrl(env.FIXTURE_INTERNAL_URL),
		sessionSecret: env.FIXTURE_SESSION_SECRET ?? '',
		cronToken: env.FIXTURE_CRON_TOKEN ?? '',
		cronName: env.FIXTURE_CRON_NAME || 'tick',
		workerName: env.FIXTURE_WORKER_NAME || 'worker',
		workerIntervalMs: numberOr(env.FIXTURE_WORKER_INTERVAL_MS, 10_000),
		/** The writable volume of `.works/works.yml` (`volumes: [{ name: uploads, path: /data }]`). */
		dataDir: env.FIXTURE_DATA_DIR || '/data',
		uploadsDir: env.FIXTURE_UPLOADS_DIR || '',
		mailTo: env.FIXTURE_MAIL_TO ?? '',
		mailSubject: env.FIXTURE_MAIL_SUBJECT || 'app-fixture-hello smoke test',
		mailRateLimitMs: numberOr(env.FIXTURE_MAIL_RATE_LIMIT_MS, 60_000, { allowZero: true }),
		databaseUrl: env.DATABASE_URL ?? '',
		dependencyCacheMs: numberOr(env.FIXTURE_DEPENDENCY_CACHE_MS, 5_000, { allowZero: true }),
		shutdownGraceMs: numberOr(env.FIXTURE_SHUTDOWN_GRACE_MS, 5_000)
	};
}

/** Where uploads are written: `<dataDir>/uploads` unless the App spec overrides it. */
export function uploadsDir(config) {
	return config.uploadsDir || path.join(config.dataDir, 'uploads');
}

/** Remove one trailing slash so `{{url}}/marker` never becomes `//marker`. */
export function normalizeUrl(value) {
	if (!value) return '';
	return String(value).trim().replace(/\/+$/, '');
}

function numberOr(value, fallback, { allowZero = false } = {}) {
	if (value === undefined || value === null || value === '') return fallback;
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	if (n === 0 && allowZero) return 0;
	return n > 0 ? n : fallback;
}

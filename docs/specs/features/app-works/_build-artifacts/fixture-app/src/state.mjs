/**
 * `GET /state` — every non-secret fact the App spec makes observable, gathered in one place.
 *
 * The blueprint README's feature table is the contract for this shape:
 *
 *   worker heartbeat age · applied migrations · first-deploy bootstrap observation · uploads writable ·
 *   the generated secret's length and hash prefix (never its value) · cron tick count ·
 *   `redisPing` / `bucketRoundTrip` under the `all-dependencies` profile
 *
 * The function never throws: a fixture that cannot reach its database is far more useful when it says
 * so than when it returns 500.
 */

import fs from 'node:fs';
import path from 'node:path';
import { connect, listAppliedMigrations, readBootstrap, readHeartbeat, readTick, migrationFiles } from './db.mjs';
import { uploadsDir } from './config.mjs';
import { fingerprint } from './fingerprint.mjs';
import { redisRoundTrip } from './redis.mjs';
import { bucketRoundTrip } from './s3.mjs';

/** @type {{at: number, value: unknown}} */
let dependencyCache = { at: 0, value: [] };

/**
 * @param {ReturnType<import('./config.mjs').loadConfig>} config
 * @param {{env?: NodeJS.ProcessEnv, rootDir?: string, checkDependencies?: boolean}} [options]
 */
export async function collectState(config, options = {}) {
	const env = options.env ?? process.env;
	const rootDir = options.rootDir ?? process.cwd();
	const now = new Date().toISOString();
	const state = {
		app: 'app-fixture-hello',
		now,
		database: { configured: Boolean(config.databaseUrl), reachable: false, error: null },
		migrations: [],
		migrationDetails: [],
		pendingMigrations: [],
		workerHeartbeatAt: null,
		workerHeartbeatAgeSeconds: null,
		workerBeats: null,
		cronTicks: null,
		lastCronTickAt: null,
		bootstrap: null,
		uploadsWritable: false,
		uploadsPath: uploadsDir(config),
		secretFingerprint: fingerprint(config.sessionSecret),
		redisPing: null,
		bucketRoundTrip: null,
		dependencyChecks: [],
		publicUrl: config.publicUrl
	};

	const expected = migrationFiles(path.join(rootDir, 'migrations')).map((file) => file.name);

	if (config.databaseUrl) {
		// Each read gets its OWN connection. The fixture implements no pooling by design, and the protocol
		// stub it is tested against returns zero rows for every statement after the first on a connection —
		// which is why `/state` used to report the migrations but no heartbeat and no cron ticks (they were
		// the 2nd and 3rd statements on one connection). One read per connection is the shape that survives
		// both the stub and real PostgreSQL; see `evidence/proof.txt` §3.
		const read = async (fn) => {
			const client = await connect(env);
			try {
				return await fn(client);
			} finally {
				await client.end().catch(() => undefined);
			}
		};

		try {
			const details = await read((client) => listAppliedMigrations(client));
			const appRows = details.filter((row) => row.label === 'app');
			const applied = appRows.map((row) => row.file);
			state.database.reachable = true;
			state.migrations = applied;
			state.migrationDetails = details;
			state.pendingMigrations = expected.filter((name) => !applied.includes(name));

			const ticks = await read((client) => readTick(client, config.cronName));
			state.cronTicks = ticks ? Number(ticks.ticks) : 0;
			state.lastCronTickAt = ticks?.last_tick_at ?? null;

			const heartbeat = await read((client) => readHeartbeat(client, config.workerName));
			if (heartbeat) {
				state.workerHeartbeatAt = heartbeat.beat_at;
				state.workerBeats = Number(heartbeat.beat_count);
				state.workerHeartbeatAgeSeconds = ageSeconds(heartbeat.beat_at, now);
			}

			state.bootstrap = await read((client) => readBootstrap(client));
		} catch (error) {
			state.database.error = error instanceof Error ? error.message : String(error);
		}
	} else {
		state.pendingMigrations = expected;
	}

	state.uploadsWritable = checkUploadsWritable(uploadsDir(config));

	if (options.checkDependencies !== false) {
		state.dependencyChecks = await dependencyChecks(config, env);
		const redis = state.dependencyChecks.find((check) => check.name === 'redis');
		const objectStorage = state.dependencyChecks.find((check) => check.name === 'objectStorage');
		if (redis?.configured) state.redisPing = redis.ok;
		if (objectStorage?.configured) state.bucketRoundTrip = objectStorage.ok;
	}

	return state;
}

/**
 * The two optional dependencies of `profiles/all-dependencies.works.yml`, with a short cache so a
 * dependency that is slow to answer cannot make `/state` slow to answer.
 */
async function dependencyChecks(config, env) {
	const cacheMs = config.dependencyCacheMs;
	if (cacheMs > 0 && Date.now() - dependencyCache.at < cacheMs) return dependencyCache.value;

	const redisConfigured = Boolean(env.REDIS_URL || env.REDIS_TLS_URL);
	const storageConfigured = Boolean((env.S3_ENDPOINT || env.OBJECT_STORAGE_ENDPOINT) && (env.S3_BUCKET || env.OBJECT_STORAGE_BUCKET || env.S3_BUCKETS));
	const checks = [];
	if (redisConfigured) {
		const result = await redisRoundTrip(env);
		checks.push({ name: 'redis', configured: true, ok: result.ok, detail: result.detail, ms: result.ms });
	} else {
		checks.push({ name: 'redis', configured: false, ok: null, detail: 'REDIS_URL is not set', ms: 0 });
	}
	if (storageConfigured) {
		const result = await bucketRoundTrip(env);
		checks.push({ name: 'objectStorage', configured: true, ok: result.ok, detail: result.detail, ms: result.ms });
	} else {
		checks.push({ name: 'objectStorage', configured: false, ok: null, detail: 'the object storage outputs are not set', ms: 0 });
	}
	dependencyCache = { at: Date.now(), value: checks };
	return checks;
}

/** Write and remove one small file, so `uploadsWritable` is a fact and not an assumption. */
export function checkUploadsWritable(dir) {
	const probe = path.join(dir, `.probe-${process.pid}-${Date.now()}`);
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(probe, 'app-fixture-hello');
		fs.rmSync(probe, { force: true });
		return true;
	} catch {
		return false;
	}
}

/** Seconds between two ISO-8601 timestamps, or `null` when either cannot be read. */
export function ageSeconds(then, now) {
	if (!then) return null;
	const a = Date.parse(then);
	const b = Date.parse(now);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
	return Math.round(((b - a) / 1000) * 1000) / 1000;
}

/** Test seam: forget the dependency cache between cases. */
export function resetDependencyCache() {
	dependencyCache = { at: 0, value: [] };
}

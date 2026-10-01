/**
 * Every SQL statement the fixture issues, in one place.
 *
 * `src/server.mjs`, `src/worker.mjs`, `src/migrate.mjs` and `src/bootstrap.mjs` all go through these
 * helpers, which keeps the surface a stub or a test double has to understand deliberately small.
 *
 * Timestamps are always rendered by PostgreSQL itself, in UTC and in ISO-8601, so no client-side date
 * parsing can disagree with the database about a time zone.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PgClient, redactUrl } from './pg.mjs';

/** ISO-8601 in UTC, with milliseconds, e.g. `2026-09-17T18:04:05.123Z`. */
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const asIso = (column) => `to_char(${column} AT TIME ZONE 'UTC', ${ISO})`;

export const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
	version    text        NOT NULL,
	label      text        NOT NULL DEFAULT 'app',
	checksum   text        NOT NULL,
	applied_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (version, label)
)`;

export const SQL = {
	ping: 'SELECT 1 AS ok',
	ensureMigrationsTable: SCHEMA_MIGRATIONS_DDL,
	ensureMigrationsLabel: "ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT 'app'",
	appliedMigration: 'SELECT version, label, checksum FROM schema_migrations WHERE version = $1 AND label = $2',
	// Single-line on purpose. The protocol stub these tests run against returns ZERO ROWS for some
	// multi-line statement texts even though the table holds the rows — reproduced directly:
	// `store.schema_migrations.rows.length === 3` while `listMigrations` (multi-line) returned 0 and the
	// same text `.trim()`ed returned 3. Real PostgreSQL does not care about whitespace, so the fix belongs
	// on the statement side until the stub is repaired; see `evidence/proof.txt` §3.
	listMigrations:
		'SELECT version, label, checksum, ' +
		asIso('applied_at') +
		' AS applied_at FROM schema_migrations ORDER BY version ASC, label ASC',
	recordMigration:
		'INSERT INTO schema_migrations (version, label, checksum) VALUES ($1, $2, $3) ' +
		'ON CONFLICT (version, label) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()',
	listTicks: 'SELECT name, ticks, ' + asIso('last_tick_at') + ' AS last_tick_at FROM cron_ticks ORDER BY name ASC',
	readTick: 'SELECT name, ticks, ' + asIso('last_tick_at') + ' AS last_tick_at FROM cron_ticks WHERE name = $1',
	bumpTick: 'UPDATE cron_ticks SET ticks = ticks + 1, last_tick_at = now() WHERE name = $1',
	insertTick: "INSERT INTO cron_ticks (name, ticks, last_tick_at) VALUES ($1, 1, now()) ON CONFLICT (name) DO NOTHING",
	readHeartbeat: 'SELECT name, beat_count, ' + asIso('beat_at') + ' AS beat_at FROM worker_heartbeat WHERE name = $1',
	bumpHeartbeat: 'UPDATE worker_heartbeat SET beat_at = now(), beat_count = beat_count + 1 WHERE name = $1',
	insertHeartbeat:
		"INSERT INTO worker_heartbeat (name, beat_at, beat_count) VALUES ($1, now(), 1) ON CONFLICT (name) DO NOTHING",
	insertBootstrap:
		'INSERT INTO bootstrap_checks (internal_url, public_url, saw_internal_app, saw_public_app, marker) ' +
		'VALUES ($1, $2, $3, $4, $5)',
	readBootstrap:
		'SELECT ' +
		asIso('ran_at') +
		' AS ran_at, internal_url, public_url, saw_internal_app, saw_public_app, marker ' +
		'FROM bootstrap_checks ORDER BY id DESC LIMIT 1'
};

/** The migrations directory, or `null` when it does not exist. */
export function migrationsDir(rootDir = process.cwd()) {
	const dir = process.env.FIXTURE_MIGRATIONS_DIR || path.join(rootDir, 'migrations');
	return fs.existsSync(dir) ? dir : null;
}

/** Every `*.sql` file of the migrations directory, in lexical (therefore numeric) order. */
export function migrationFiles(dir = migrationsDir()) {
	if (!dir) return [];
	return fs
		.readdirSync(dir)
		.filter((name) => name.endsWith('.sql'))
		.sort()
		.map((name) => ({ name, fullPath: path.join(dir, name) }));
}

/** @param {string} file */
export function checksumOf(file) {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** True when a connection can be opened and answers `SELECT 1`. Never throws. */
export async function probe(client) {
	try {
		await client.query(SQL.ping);
		return { reachable: true, error: null };
	} catch (error) {
		return { reachable: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** A connected client, or `null` when the fixture has no database configured. */
export async function connect(env = process.env) {
	const url = env.DATABASE_URL;
	if (!url) return null;
	const client = new PgClient({
		url,
		connectTimeoutMs: numberOr(env.FIXTURE_DB_CONNECT_TIMEOUT_MS, 5_000),
		queryTimeoutMs: numberOr(env.FIXTURE_DB_QUERY_TIMEOUT_MS, 10_000)
	});
	await client.connect();
	return client;
}

/** Connect, run `fn`, always close. */
export async function withClient(env, fn) {
	const client = await connect(env);
	if (!client) throw new Error('DATABASE_URL is not set');
	try {
		return await fn(client);
	} finally {
		await client.end().catch(() => undefined);
	}
}

/** `{ file, label, checksum, appliedAt }` for every recorded migration, any label. */
export async function listAppliedMigrations(client) {
	const { rows } = await client.query(SQL.listMigrations);
	return rows.map((row) => ({
		file: row.version,
		label: row.label,
		checksum: row.checksum,
		appliedAt: row.applied_at
	}));
}

/** The names applied under one label — `app` is the application's own set. */
export async function appliedVersions(client, label = 'app') {
	const rows = await listAppliedMigrations(client);
	return rows.filter((row) => row.label === label).map((row) => row.file);
}

/** Increment the named counter and return its new value. */
export async function bumpTick(client, name) {
	const updated = await client.query(SQL.bumpTick, [name]);
	if (updated.rowCount === 0) await client.query(SQL.insertTick, [name]);
	const { rows } = await client.query(SQL.readTick, [name]);
	return rows[0] ?? null;
}

export async function readTick(client, name) {
	try {
		const { rows } = await client.query(SQL.readTick, [name]);
		return rows[0] ?? null;
	} catch {
		return null;
	}
}

export async function writeHeartbeat(client, name = 'worker') {
	const updated = await client.query(SQL.bumpHeartbeat, [name]);
	if (updated.rowCount === 0) await client.query(SQL.insertHeartbeat, [name]);
	const { rows } = await client.query(SQL.readHeartbeat, [name]);
	return rows[0] ?? null;
}

export async function readHeartbeat(client, name = 'worker') {
	try {
		const { rows } = await client.query(SQL.readHeartbeat, [name]);
		return rows[0] ?? null;
	} catch {
		return null;
	}
}

export async function recordBootstrap(client, result) {
	await client.query(SQL.insertBootstrap, [
		result.internalUrl ?? null,
		result.publicUrl ?? null,
		result.sawInternalApp,
		result.sawPublicApp,
		result.marker ?? null
	]);
}

export async function readBootstrap(client) {
	try {
		const { rows } = await client.query(SQL.readBootstrap);
		const row = rows[0];
		if (!row) return null;
		return {
			ranAt: row.ran_at,
			internalUrl: row.internal_url,
			publicUrl: row.public_url,
			sawInternalApp: row.saw_internal_app,
			sawPublicApp: row.saw_public_app,
			marker: row.marker
		};
	} catch {
		return null;
	}
}

/** The connection URL with its password removed, for logs and error messages. */
export function describeDatabase(env = process.env) {
	if (!env.DATABASE_URL) return 'unconfigured';
	try {
		const url = new URL(env.DATABASE_URL);
		return `${url.hostname}:${url.port || 5432}/${url.pathname.replace(/^\//, '')}`;
	} catch {
		return redactUrl(env.DATABASE_URL);
	}
}

/** Any URL with its userinfo removed, for logs. */
export function displaySafeUrl(url) {
	if (!url) return '';
	try {
		const parsed = new URL(url);
		parsed.username = '';
		parsed.password = '';
		return parsed.toString();
	} catch {
		return redactUrl(url);
	}
}

function numberOr(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

import type { IPlugin } from '../plugin.interface.js';

/**
 * Pluggable relational-database backend for deployed Works (the "PostgreSQL DB"
 * plugin). Distinct from `storage` (object storage / blobs).
 *
 * The plugin holds the **tenant-level connection choice** in its settings —
 * either the managed **Ever Works DB** (a shared Postgres cluster the platform
 * runs) or a **custom connection string** (the user's own server) — plus an
 * optional **per-Work override** connection string. The per-Work database name
 * is derived (`ew_<workId>`) so every Work shares the same server but gets its
 * own database.
 *
 * Provisioning + URL composition are orchestrated **server-side** by the deploy
 * pipeline, which reads this plugin's resolved settings and delegates the DDL
 * to `EverWorksDbProvisionService` (it needs the shared-cluster admin
 * connection + the `pg` client). The plugin itself only declares availability
 * and validates a connection string, so it stays a thin, dependency-light
 * config surface.
 */
export interface DatastoreConnectionTestResult {
	readonly ok: boolean;
	readonly error?: string;
}

export interface IDatastorePlugin extends IPlugin {
	/**
	 * True when the backend can actually be used — e.g. the Ever Works DB env is
	 * wired (`DB_EVER_WORKS_SHARED_*`) for the managed mode, or a custom
	 * connection string is configured. The onboarding card / Deploy selector use
	 * this to decide whether to offer the option.
	 */
	isAvailable(): boolean | Promise<boolean>;

	/**
	 * Validate a user-supplied Postgres connection string (short-timeout connect
	 * + `SELECT 1`). Never throws — returns `{ ok:false, error }` on failure so
	 * the UI can surface a friendly message.
	 */
	testDatabaseConnection(connectionString: string): Promise<DatastoreConnectionTestResult>;
}

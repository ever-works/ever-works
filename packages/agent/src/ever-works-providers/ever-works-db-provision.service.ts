import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Client } from 'pg';
import { config } from '../config';
import { WorkRuntimeEnvService } from '../services/work-runtime-env.service';

/**
 * Auto-provisions a per-Work database on the shared **"Ever Works DB"** cluster
 * so a customer Work can pick "Ever Works DB" and get a working, isolated
 * Postgres without bringing their own — the missing half of the DB-storage
 * feature (the platform had no way to CREATE a database).
 *
 * Isolation model (owner decision): **one database + one role per Work**
 * (`ew_<hex>` owned by `ewr_<hex>`, `<hex>` = the Work's UUID without dashes),
 * so a Work fully owns its schema and teardown is a single `DROP DATABASE`.
 *
 * 🛑 Two hard-won facts baked in here:
 *  - **DDL goes DIRECT** to the cluster (`DB_EVER_WORKS_SHARED_ADMIN_URL`, a
 *    least-priv CREATEDB+CREATEROLE role) — a transaction-pooled PgBouncer
 *    cannot run `CREATE DATABASE`.
 *  - The injected per-Work `DATABASE_URL` (composed from `..._HOST/_PORT`)
 *    points at the app endpoint (which MAY be a cross-cluster PgBouncer LB).
 *    No seeding is needed: the directory-web-template builds its own schema via
 *    drizzle **migrate-on-boot** (which needs a session connection — hence the
 *    app endpoint should be a session/`unpooled`-style endpoint for these).
 *
 * The freshly-created database is empty and owned by `ewr_<hex>`; because the
 * role owns the database it can create the `drizzle`/`public` schema objects
 * that migrate-on-boot needs.
 */
@Injectable()
export class EverWorksDbProvisionService {
    private readonly logger = new Logger(EverWorksDbProvisionService.name);

    constructor(private readonly workRuntimeEnvService: WorkRuntimeEnvService) {}

    /** True when an operator has wired the shared-DB admin + host env. */
    isReady(): boolean {
        return config.everWorks.sharedDb.isReady();
    }

    /**
     * Ensure the Work has a shared-DB `DATABASE_URL`, provisioning one on first
     * call. Returns the existing URL if already provisioned (idempotent), or
     * `null` if the shared-DB feature isn't ready (caller falls back to
     * warn/skip). Pass `{ force: true }` to (re)point the Work at its shared DB
     * even when a URL is already set — used when a user switches an existing
     * Work from a custom connection string to the Ever Works DB.
     */
    async ensureDatabaseForWork(
        workId: string,
        opts: { force?: boolean } = {},
    ): Promise<string | null> {
        if (!this.isReady()) {
            return null;
        }
        if (!opts.force) {
            const existing = await this.workRuntimeEnvService.getDatabaseUrl(workId);
            if (existing) {
                return existing;
            }
        }

        const shared = config.everWorks.sharedDb;
        const hex = workId.replace(/-/g, '').toLowerCase();
        const prefix = shared.getNamePrefix();
        const dbName = `${prefix}_${hex}`;
        const roleName = `${prefix}r_${hex}`;
        const password = this.randomPassword();

        // Idempotent DDL: the ew_<hex> database + ewr_<hex> role are keyed on the
        // stable Work id, so this reuses them (re-keying the role password) on a
        // forced re-point rather than creating duplicates.
        await this.runDdl(shared.getAdminUrl(), dbName, roleName, password);

        const url = this.composeUrl(roleName, password, dbName);
        let stored: string;
        if (opts.force) {
            await this.workRuntimeEnvService.setDatabaseUrl(workId, url);
            stored = url;
        } else {
            stored = await this.workRuntimeEnvService.setDatabaseUrlIfNull(workId, url);
        }
        this.logger.log(`Provisioned shared Ever Works DB "${dbName}" for work ${workId}`);
        return stored;
    }

    /**
     * Validate a user-supplied custom Postgres connection string: attempt a
     * short-timeout connect + `SELECT 1`. Returns `{ ok }` or `{ ok:false,
     * error }` — never throws, so the caller can surface a friendly message.
     */
    async testConnection(databaseUrl: string): Promise<{ ok: boolean; error?: string }> {
        if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
            return { ok: false, error: 'Connection string must start with postgres:// or postgresql://' };
        }
        const client = new Client({
            connectionString: databaseUrl,
            ssl: this.sslFor(databaseUrl),
            connectionTimeoutMillis: 8000,
            statement_timeout: 8000,
        });
        try {
            await client.connect();
            await client.query('SELECT 1');
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        } finally {
            await client.end().catch(() => {});
        }
    }

    /**
     * Idempotent DDL: create (or re-key) the role, then create the database
     * owned by it if absent. Identifiers + password are controlled (hex / prefix
     * / random hex) so literal interpolation is injection-safe here.
     */
    private async runDdl(
        adminUrl: string,
        dbName: string,
        roleName: string,
        password: string,
    ): Promise<void> {
        const client = new Client({
            connectionString: adminUrl,
            ssl: this.sslFor(adminUrl),
            connectionTimeoutMillis: 10000,
        });
        await client.connect();
        try {
            const role = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [roleName]);
            if (role.rowCount && role.rowCount > 0) {
                await client.query(`ALTER ROLE "${roleName}" WITH LOGIN PASSWORD '${password}'`);
            } else {
                await client.query(`CREATE ROLE "${roleName}" WITH LOGIN PASSWORD '${password}'`);
            }
            const db = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
            if (!db.rowCount) {
                // CREATE DATABASE cannot run inside a transaction — the pg client
                // autocommits each simple query, so this is fine (and is why the
                // admin URL must be a direct, non-transaction-pooled endpoint).
                await client.query(`CREATE DATABASE "${dbName}" OWNER "${roleName}"`);
            }
        } finally {
            await client.end().catch(() => {});
        }
    }

    private composeUrl(role: string, password: string, dbName: string): string {
        const shared = config.everWorks.sharedDb;
        const host = shared.getHost();
        const port = shared.getPort();
        const sslmode = shared.getSslMode();
        const auth = `${encodeURIComponent(role)}:${encodeURIComponent(password)}`;
        return `postgresql://${auth}@${host}:${port}/${dbName}?sslmode=${sslmode}`;
    }

    private sslFor(url: string): { rejectUnauthorized: boolean } | undefined {
        // Managed cluster uses a self-signed CA; `sslmode=require` means encrypt
        // without CA verification (matches libpq's `require`).
        return /sslmode=(require|prefer|verify)/i.test(url)
            ? { rejectUnauthorized: false }
            : undefined;
    }

    private randomPassword(): string {
        // 32 hex chars — safe to embed in SQL literals and connection strings.
        return randomBytes(16).toString('hex');
    }
}

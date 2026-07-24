import { Client } from 'pg';
import type {
	IPlugin,
	IDatastorePlugin,
	DatastoreConnectionTestResult,
	PluginContext,
	PluginManifest,
	PluginCategory,
	JsonSchema,
	ConnectionValidationResult
} from '@ever-works/plugin';

/** Snapshot of the managed "Ever Works DB" wiring from env. */
function sharedDbEnv() {
	return {
		enabled: process.env.DB_EVER_WORKS_SHARED_ENABLED === 'true',
		adminUrl: process.env.DB_EVER_WORKS_SHARED_ADMIN_URL || '',
		host: process.env.DB_EVER_WORKS_SHARED_HOST || ''
	};
}

/** Managed Ever Works DB is usable when the feature flag + provisioner + host are set. */
function isSharedReady(): boolean {
	const s = sharedDbEnv();
	return s.enabled && Boolean(s.adminUrl) && Boolean(s.host);
}

/** Self-signed managed cluster → encrypt without CA verification (libpq `require`). */
function sslFor(url: string): { rejectUnauthorized: boolean } | undefined {
	return /sslmode=(require|prefer|verify)/i.test(url) ? { rejectUnauthorized: false } : undefined;
}

/**
 * "PostgreSQL DB" — gives deployed Works a Postgres database.
 *
 * The user picks a backend ONCE at the account level (onboarding): the managed
 * **Ever Works DB** (a shared Postgres cluster the platform runs) or a **custom
 * connection string** (their own server). By default every Work uses that same
 * server but gets its own database (`ew_<workId>`); a Work can override with a
 * full connection string on its Deploy page.
 *
 * This plugin is the CONFIG + VALIDATION surface (settings schema + connection
 * test). The actual per-Work database provisioning + `DATABASE_URL` composition
 * is done server-side by the deploy pipeline (it needs the shared-cluster admin
 * connection), which reads this plugin's resolved settings — see
 * `DeployService.ensureRuntimeEnv` + `EverWorksDbProvisionService`.
 */
export class PostgresDbPlugin implements IPlugin, IDatastorePlugin {
	readonly id = 'postgres-db';
	readonly name = 'PostgreSQL DB';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'database';
	readonly capabilities: readonly string[] = ['database', 'datastore'];
	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			// Account-level (user-scope) backend choice — cascades to every Work
			// via `autoEnableForWorks`.
			mode: {
				type: 'string',
				enum: ['ever-works-db', 'custom'],
				default: 'ever-works-db',
				title: 'Database',
				description:
					"'Ever Works DB' — a managed database provisioned for you (one per Work), no setup needed. 'Custom' — connect your own Postgres server.",
				'x-scope': 'user'
			},
			customConnectionString: {
				type: 'string',
				title: 'Connection string',
				description:
					'postgresql://user:password@host:5432/db — used as the server for all your Works. A database is created per Work on it when the role allows (CREATE DATABASE); otherwise the connection is used as-is. Stored encrypted; shown masked.',
				'x-secret': true,
				'x-scope': 'user',
				'x-widget': 'password',
				'x-showIf': { field: 'mode', value: 'custom' }
			},
			// Per-Work override (work-scope) — only writable/visible on the Deploy
			// page (the scope guards enforce this).
			overrideConnectionString: {
				type: 'string',
				title: 'Per-Work override (optional)',
				description:
					'Override the database for THIS Work only with a full connection string. Leave blank to use the account-level setting.',
				'x-secret': true,
				'x-scope': 'work',
				'x-widget': 'password'
			}
		}
	};

	async onLoad(_context: PluginContext): Promise<void> {
		// Stateless — config is resolved per request from settings + env.
	}

	async onUnload(): Promise<void> {
		// no-op
	}

	/**
	 * The plugin is always usable: 'custom' is always an option, and the managed
	 * 'Ever Works DB' option additionally requires its env to be wired
	 * (surfaced separately via the onboarding card's `available` flag).
	 */
	isAvailable(): boolean {
		return true;
	}

	/** Whether the managed Ever Works DB option can actually be offered. */
	isEverWorksDbAvailable(): boolean {
		return isSharedReady();
	}

	async testDatabaseConnection(connectionString: string): Promise<DatastoreConnectionTestResult> {
		if (!/^postgres(ql)?:\/\//i.test(connectionString)) {
			return {
				ok: false,
				error: 'Connection string must start with postgres:// or postgresql://'
			};
		}
		const client = new Client({
			connectionString,
			ssl: sslFor(connectionString),
			connectionTimeoutMillis: 8000,
			statement_timeout: 8000
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

	/** Save & verify (verifiesOnSave): validate the chosen backend. */
	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const mode = (settings.mode as string) ?? 'ever-works-db';
		if (mode === 'custom') {
			const conn = ((settings.customConnectionString as string) ?? '').trim();
			if (!conn) {
				return { success: false, message: 'Enter a custom Postgres connection string.' };
			}
			const r = await this.testDatabaseConnection(conn);
			return r.ok
				? { success: true, message: 'Connected to your database successfully.' }
				: { success: false, message: r.error ?? 'Connection failed.' };
		}
		return isSharedReady()
			? {
					success: true,
					message: 'Ever Works DB is available — a database is provisioned per Work.'
				}
			: {
					success: false,
					message:
						'Ever Works DB is not configured on this instance. Ask an operator to enable it, or use a custom database.'
				};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Gives your deployed Works a PostgreSQL database — the managed Ever Works DB or your own server. One database is provisioned per Work.',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			systemPlugin: true,
			autoEnable: true,
			visibility: 'user-only',
			defaultForCapabilities: ['datastore'],
			readme: [
				'## What does the PostgreSQL DB plugin do?',
				'',
				'It gives every deployed Work a PostgreSQL database. Configure it once for',
				'your account; each Work then gets its own database on the same server.',
				'',
				'## Two backends',
				'',
				'- **Ever Works DB** — a managed Postgres cluster the platform runs. A',
				'  dedicated database is provisioned per Work automatically. No setup.',
				'- **Custom** — connect your own Postgres server with a connection string.',
				'  A database is created per Work on it when your role allows; otherwise',
				'  the connection is used as-is.',
				'',
				'## Per-Work override',
				'',
				'Any Work can override the account default on its **Deploy** page with a',
				'full connection string (its own server + database).'
			].join('\n'),
			uiHints: {
				includeInOnboarding: true,
				onboardingPriority: 3,
				onboardingDescription:
					'Choose where your Works store data — the managed Ever Works DB or your own Postgres.',
				completionFields: ['mode'],
				verifiesOnSave: true
			},
			icon: {
				type: 'lucide',
				value: 'Database',
				backgroundColor: '#336791'
			}
		};
	}
}

/**
 * The `migrate` job — `.works/works.yml` runs `node src/migrate.mjs` as a `pre-deploy` job with a
 * 120-second budget, and `variant/bad-migration` proves a failure stops the rollout by breaking
 * `0002_ticks.sql`.
 *
 * Behaviour: connect, create `schema_migrations` if it is missing, then apply every `migrations/*.sql`
 * file in lexical order, each in its own transaction, recording the file name, the label and a SHA-256
 * of its contents. A file already applied with the same checksum is skipped; a file whose contents
 * changed after it was applied is an error, because silently re-running it is how a fixture would lie.
 * Any failure rolls the transaction back, prints why and exits non-zero.
 *
 * `--label <name>` records the migrations under another label. `variant/services-postgres` uses
 * `--label build-time` to migrate the throwaway database that only exists during its build: the App
 * Work's own `/state` must then show no `build-time` row (ACC-05-12), which is exactly what the label
 * makes visible.
 *
 * Exit codes: 0 applied (or already applied), 1 a migration failed, 2 misconfiguration (no database,
 * no migrations directory, unreadable file).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checksumOf, connect, describeDatabase, migrationFiles, SQL } from './db.mjs';
import { isMain } from './server.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Apply every pending migration.
 * @param {{databaseUrl?: string, dir?: string, label?: string, log?: (line: string) => void}} options
 * @returns {Promise<{applied: string[], skipped: string[], label: string}>}
 */
export async function migrate({ databaseUrl, dir, label = 'app', log = console.log } = {}) {
	if (!databaseUrl) throw Object.assign(new Error('DATABASE_URL is not set'), { exitCode: 2 });
	const directory = dir ?? process.env.FIXTURE_MIGRATIONS_DIR ?? path.join(rootDir, 'migrations');
	if (!fs.existsSync(directory)) throw Object.assign(new Error(`migrations directory not found: ${directory}`), { exitCode: 2 });

	const files = migrationFiles(directory);
	if (!files.length) throw Object.assign(new Error(`no *.sql files in ${directory}`), { exitCode: 2 });

	const client = await connect({ ...process.env, DATABASE_URL: databaseUrl });
	const applied = [];
	const skipped = [];
	try {
		await client.simpleQuery(SQL.ensureMigrationsTable);
		await client.simpleQuery(SQL.ensureMigrationsLabel);

		for (const file of files) {
			const checksum = checksumOf(file.fullPath);
			const known = await client.query(SQL.appliedMigration, [file.name, label]);
			if (known.rows.length) {
				if (known.rows[0].checksum !== checksum) {
					throw Object.assign(
						new Error(
							`${file.name} was applied under label "${label}" with checksum ${known.rows[0].checksum.slice(0, 12)} but is now ${checksum.slice(0, 12)} — refusing to apply a changed migration`
						),
						{ exitCode: 1 }
					);
				}
				skipped.push(file.name);
				log(`migrate: ${file.name} already applied (label=${label})`);
				continue;
			}

			const sql = fs.readFileSync(file.fullPath, 'utf8');
			await client.simpleQuery('BEGIN');
			try {
				if (sql.trim()) await client.simpleQuery(sql);
				await client.query(SQL.recordMigration, [file.name, label, checksum]);
				await client.simpleQuery('COMMIT');
			} catch (error) {
				await client.simpleQuery('ROLLBACK').catch(() => undefined);
				throw Object.assign(new Error(`${file.name} failed: ${error.message}`), { exitCode: 1, cause: error });
			}
			applied.push(file.name);
			log(`migrate: applied ${file.name} (label=${label}, sha256=${checksum.slice(0, 12)})`);
		}
		log(`migrate: ${applied.length} applied, ${skipped.length} already present, label=${label}, database=${describeDatabase({ DATABASE_URL: databaseUrl })}`);
		return { applied, skipped, label };
	} finally {
		await client.end().catch(() => undefined);
	}
}

if (isMain()) {
	const label = valueOfFlag('--label') ?? 'app';
	const databaseUrl = valueOfFlag('--database-url') ?? process.env.DATABASE_URL;
	try {
		await migrate({ databaseUrl, label });
		process.exit(0);
	} catch (error) {
		process.stderr.write(`migrate: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(error?.exitCode ?? 1);
	}
}

/** `--label build-time` and `--label=build-time` both work. */
function valueOfFlag(name, argv = process.argv.slice(2)) {
	const withEquals = argv.find((arg) => arg.startsWith(`${name}=`));
	if (withEquals) return withEquals.slice(name.length + 1);
	const index = argv.indexOf(name);
	if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1];
	return null;
}

import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';

/**
 * Boot-time DB readiness hook.
 *
 * - Always: open the TypeORM DataSource if it isn't already initialised
 *   (idempotent — the data source's own check guards re-init).
 * - When `APP_TYPE === 'cli'`: also call `dataSource.synchronize()` to
 *   make the schema match the entity definitions, so a freshly-checked
 *   out CLI run against an empty DB can create the tables it needs
 *   without a separate migration step.
 *
 * **DANGER — synchronize() is destructive.** TypeORM `synchronize()`
 * issues raw `ALTER TABLE` / `DROP COLUMN` to bring the schema in line
 * with entity classes. If you point a CLI run at a production database
 * with `APP_TYPE=cli` set, any column that isn't in the current entity
 * tree will be silently dropped. Migrations (see NN #16 in CLAUDE.md
 * and `docs/specs/architecture/database-migrations.md`) are the only
 * supported way to evolve prod schema; this hook MUST stay gated on
 * `APP_TYPE === 'cli'` and the operator MUST NOT set that env var on
 * any deployment that holds real data.
 */
@Injectable()
export class DatabaseInitService implements OnModuleInit {
    private readonly logger = new Logger(DatabaseInitService.name);

    constructor(@InjectDataSource() private dataSource: DataSource) {}

    async onModuleInit() {
        try {
            // Ensure database connection is established
            if (!this.dataSource.isInitialized) {
                await this.dataSource.initialize();
                this.logger.debug('Database connection initialized');
            }

            // CLI-only schema bootstrap. See the DANGER note on the class:
            // synchronize() will drop columns not present in entities, so
            // never run this against a production database.
            if (process.env.APP_TYPE === 'cli') {
                await this.dataSource.synchronize();
                this.logger.debug('Database schema synchronized');
            }
        } catch (error) {
            this.logger.error('Failed to initialize database', error);
            throw error;
        }
    }
}

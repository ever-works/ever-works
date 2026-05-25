import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Agents / Skills / Tasks — Phase 1.6 (PR #1017 specs).
 *
 * Adds the nullable `agentId` column + `(agentId, occurredAt)` index to
 * `plugin_usage_events`. Existing rows are left null (the column is
 * additive; pre-existing usage rows pre-date the Agent feature). New
 * usage rows generated from AI calls made inside an Agent's heartbeat
 * / task / chat run carry the `agentId` so the BudgetService aggregator
 * can sum per-Agent spend without an additional join table.
 *
 * Idempotent: column add gated on `hasColumn`, index add gated on
 * `indices.some`.
 *
 * No FK constraint is added here — `agents` is created in the prior
 * migration but the soft FK is enforced at write-time (the existing
 * PluginUsageService already validates `workId` / `userId`; we add
 * `agentId` to that validation in the Phase 3 service work). Avoiding
 * a hard FK simplifies the agent-delete path: archiving an Agent does
 * NOT cascade-delete historical usage rows (they're an audit trail).
 */
export class AddAgentIdToPluginUsageEvents1779978011000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		const hasTable = await queryRunner.hasTable('plugin_usage_events');
		if (!hasTable) {
			return; // table doesn't exist yet — caller has bigger problems
		}

		const hasCol = await queryRunner.hasColumn('plugin_usage_events', 'agentId');
		if (!hasCol) {
			await queryRunner.addColumn(
				'plugin_usage_events',
				new TableColumn({
					name: 'agentId',
					type: 'uuid',
					isNullable: true,
				}),
			);
		}

		const table = await queryRunner.getTable('plugin_usage_events');
		const hasIdx = table?.indices.some(
			(idx) => idx.name === 'idx_plugin_usage_events_agent_occurred',
		);
		if (!hasIdx) {
			await queryRunner.createIndex(
				'plugin_usage_events',
				new TableIndex({
					name: 'idx_plugin_usage_events_agent_occurred',
					columnNames: ['agentId', 'occurredAt'],
				}),
			);
		}
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		const table = await queryRunner.getTable('plugin_usage_events');
		if (!table) {
			return;
		}

		const idx = table.indices.find(
			(i) => i.name === 'idx_plugin_usage_events_agent_occurred',
		);
		if (idx) {
			await queryRunner.dropIndex('plugin_usage_events', idx);
		}

		if (await queryRunner.hasColumn('plugin_usage_events', 'agentId')) {
			await queryRunner.dropColumn('plugin_usage_events', 'agentId');
		}
	}
}

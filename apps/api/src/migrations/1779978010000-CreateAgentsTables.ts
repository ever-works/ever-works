import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Agents / Skills / Tasks — Phase 1 (PR #1017 specs).
 *
 * Creates the five tables behind the new Agent entities
 * (agents/plan.md §3.1):
 *
 *   - agents             — user-defined Agent rows + DB-inline file
 *                          storage (ADR-008) + H3 avatar columns.
 *   - agent_runs         — per-execution row (heartbeat/manual/task/chat).
 *   - agent_run_logs     — structured log lines per run.
 *   - agent_budgets      — per-Agent budget with all 5 intervalUnit
 *                          values (N6 override).
 *   - agent_memberships  — polymorphic targets for tenant Agents.
 *
 * Plus all FK constraints required by the entity decorators. Idempotent:
 * every `createTable` / `createIndex` / `createForeignKey` gates on
 * `hasTable` / `hasIndex` / `foreignKeys.some` so the migration is
 * safe to re-run on dev resets + CI.
 *
 * Column type choices follow the Missions migration pattern:
 *   - `text` for `simple-json` columns (portable across sqlite + postgres)
 *   - `'now()'` default for timestamps
 *   - explicit `length` on every varchar
 *
 * FKs deliberately NOT created for `agent_runs.taskId` and
 * `agent_runs.chatMessageId` — the `tasks` and `task_chat_messages`
 * tables don't exist yet (Phase 11 ships them). Those FKs land in the
 * Phase 11 migration instead.
 */
export class CreateAgentsTables1779978010000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		// ── agents ───────────────────────────────────────────────────
		if (!(await queryRunner.hasTable('agents'))) {
			await queryRunner.createTable(
				new Table({
					name: 'agents',
					columns: [
						{
							name: 'id',
							type: 'uuid',
							isPrimary: true,
							isGenerated: true,
							generationStrategy: 'uuid',
							default: 'uuid_generate_v4()',
						},
						{ name: 'userId', type: 'uuid', isNullable: false },
						{ name: 'scope', type: 'varchar', length: '16', isNullable: false },
						{ name: 'missionId', type: 'uuid', isNullable: true },
						{ name: 'ideaId', type: 'uuid', isNullable: true },
						{ name: 'workId', type: 'uuid', isNullable: true },
						{ name: 'name', type: 'varchar', length: '120', isNullable: false },
						{ name: 'slug', type: 'varchar', length: '80', isNullable: false },
						{ name: 'title', type: 'varchar', length: '200', isNullable: true },
						{ name: 'capabilities', type: 'text', isNullable: true },
						{ name: 'aiProviderId', type: 'varchar', length: '100', isNullable: true },
						{ name: 'modelId', type: 'varchar', length: '100', isNullable: true },
						{
							name: 'maxSkillContextTokens',
							type: 'int',
							isNullable: false,
							default: 4000,
						},
						{
							name: 'status',
							type: 'varchar',
							length: '16',
							isNullable: false,
							default: "'draft'",
						},
						// permissions JSON — text for dialect portability.
						{ name: 'permissions', type: 'text', isNullable: false },
						{ name: 'targets', type: 'text', isNullable: true },
						{ name: 'heartbeatCadence', type: 'varchar', length: '64', isNullable: true },
						{
							name: 'idleBehavior',
							type: 'varchar',
							length: '16',
							isNullable: false,
							default: "'propose'",
						},
						{ name: 'nextHeartbeatAt', type: 'timestamp', isNullable: true },
						{ name: 'lastRunAt', type: 'timestamp', isNullable: true },
						{ name: 'lastRunStatus', type: 'varchar', length: '16', isNullable: true },
						{ name: 'errorCount', type: 'int', isNullable: false, default: 0 },
						{ name: 'pauseAfterFailures', type: 'int', isNullable: false, default: 3 },
						// Avatar (H3 — all three modes).
						{
							name: 'avatarMode',
							type: 'varchar',
							length: '8',
							isNullable: false,
							default: "'initials'",
						},
						{ name: 'avatarIcon', type: 'varchar', length: '64', isNullable: true },
						{ name: 'avatarImageUploadId', type: 'uuid', isNullable: true },
						// Tenant-scope DB-inline file storage (ADR-008).
						{ name: 'soulMd', type: 'text', isNullable: true },
						{ name: 'agentsMd', type: 'text', isNullable: true },
						{ name: 'heartbeatMd', type: 'text', isNullable: true },
						{ name: 'toolsMd', type: 'text', isNullable: true },
						{ name: 'agentYml', type: 'text', isNullable: true },
						{ name: 'contentHash', type: 'varchar', length: '64', isNullable: true },
						{
							name: 'createdAt',
							type: 'timestamp',
							default: 'now()',
							isNullable: false,
						},
						{
							name: 'updatedAt',
							type: 'timestamp',
							default: 'now()',
							isNullable: false,
						},
					],
					foreignKeys: [
						{
							name: 'fk_agents_user',
							columnNames: ['userId'],
							referencedTableName: 'users',
							referencedColumnNames: ['id'],
							onDelete: 'CASCADE',
						},
						{
							name: 'fk_agents_mission',
							columnNames: ['missionId'],
							referencedTableName: 'missions',
							referencedColumnNames: ['id'],
							onDelete: 'CASCADE',
						},
						{
							name: 'fk_agents_idea',
							columnNames: ['ideaId'],
							referencedTableName: 'work_proposals',
							referencedColumnNames: ['id'],
							onDelete: 'CASCADE',
						},
						{
							name: 'fk_agents_work',
							columnNames: ['workId'],
							referencedTableName: 'works',
							referencedColumnNames: ['id'],
							onDelete: 'CASCADE',
						},
						{
							name: 'fk_agents_avatar_upload',
							columnNames: ['avatarImageUploadId'],
							referencedTableName: 'work_knowledge_upload',
							referencedColumnNames: ['id'],
							onDelete: 'SET NULL',
						},
					],
				}),
				true,
			);
		}

		await this.ensureIndex(queryRunner, 'agents', 'uq_agents_user_scope_slug', [
			'userId',
			'scope',
			'missionId',
			'ideaId',
			'workId',
			'slug',
		], true);
		await this.ensureIndex(queryRunner, 'agents', 'idx_agents_user_status', ['userId', 'status']);
		await this.ensureIndex(queryRunner, 'agents', 'idx_agents_next_heartbeat', [
			'status',
			'nextHeartbeatAt',
		]);
		await this.ensureIndex(queryRunner, 'agents', 'idx_agents_mission', ['missionId']);
		await this.ensureIndex(queryRunner, 'agents', 'idx_agents_work', ['workId']);
		await this.ensureIndex(queryRunner, 'agents', 'idx_agents_idea', ['ideaId']);

		// ── agent_runs ───────────────────────────────────────────────
		if (!(await queryRunner.hasTable('agent_runs'))) {
			await queryRunner.createTable(
				new Table({
					name: 'agent_runs',
					columns: [
						{
							name: 'id',
							type: 'uuid',
							isPrimary: true,
							isGenerated: true,
							generationStrategy: 'uuid',
							default: 'uuid_generate_v4()',
						},
						{ name: 'agentId', type: 'uuid', isNullable: false },
						{ name: 'userId', type: 'uuid', isNullable: false },
						{ name: 'triggerKind', type: 'varchar', length: '16', isNullable: false },
						{ name: 'status', type: 'varchar', length: '16', isNullable: false },
						{ name: 'triggerRunId', type: 'varchar', length: '64', isNullable: true },
						{ name: 'startedAt', type: 'timestamp', isNullable: true },
						{ name: 'finishedAt', type: 'timestamp', isNullable: true },
						{ name: 'durationMs', type: 'int', isNullable: true },
						{ name: 'errorMessage', type: 'text', isNullable: true },
						{ name: 'summary', type: 'text', isNullable: true },
						{ name: 'taskId', type: 'uuid', isNullable: true },
						{ name: 'chatMessageId', type: 'uuid', isNullable: true },
						{
							name: 'createdAt',
							type: 'timestamp',
							default: 'now()',
							isNullable: false,
						},
					],
					foreignKeys: [
						{
							name: 'fk_agent_runs_agent',
							columnNames: ['agentId'],
							referencedTableName: 'agents',
							referencedColumnNames: ['id'],
							onDelete: 'CASCADE',
						},
						{
							name: 'fk_agent_runs_user',
							columnNames: ['userId'],
							referencedTableName: 'users',
							referencedColumnNames: ['id'],
							onDelete: 'CASCADE',
						},
					],
				}),
				true,
			);
		}

		await this.ensureIndex(queryRunner, 'agent_runs', 'idx_agent_runs_agent_started', [
			'agentId',
			'startedAt',
		]);
		await this.ensureIndex(queryRunner, 'agent_runs', 'idx_agent_runs_status', ['status']);
		await this.ensureIndex(queryRunner, 'agent_runs', 'idx_agent_runs_task', ['taskId']);
		await this.ensureIndex(queryRunner, 'agent_runs', 'idx_agent_runs_chat_message', [
			'chatMessageId',
		]);

		// ── agent_run_logs ───────────────────────────────────────────
		if (!(await queryRunner.hasTable('agent_run_logs'))) {
			await queryRunner.createTable(
				new Table({
					name: 'agent_run_logs',
					columns: [
						{
							name: 'id',
							type: 'uuid',
							isPrimary: true,
							isGenerated: true,
							generationStrategy: 'uuid',
							default: 'uuid_generate_v4()',
						},
						{ name: 'runId', type: 'uuid', isNullable: false },
						{ name: 'level', type: 'varchar', length: '8', isNullable: false },
						{ name: 'step', type: 'varchar', length: '80', isNullable: false },
						{ name: 'message', type: 'text', isNullable: false },
						{ name: 'metadata', type: 'text', isNullable: true },
						{
							name: 'createdAt',
							type: 'timestamp',
							default: 'now()',
							isNullable: false,
						},
					],
					foreignKeys: [
						{
							name: 'fk_agent_run_logs_run',
							columnNames: ['runId'],
							referencedTableName: 'agent_runs',
							referencedColumnNames: ['id'],
							onDelete: 'CASCADE',
						},
					],
				}),
				true,
			);
		}

		await this.ensureIndex(queryRunner, 'agent_run_logs', 'idx_agent_run_logs_run_created', [
			'runId',
			'createdAt',
		]);
		await this.ensureIndex(queryRunner, 'agent_run_logs', 'idx_agent_run_logs_run_level', [
			'runId',
			'level',
		]);

		// ── agent_budgets ────────────────────────────────────────────
		if (!(await queryRunner.hasTable('agent_budgets'))) {
			await queryRunner.createTable(
				new Table({
					name: 'agent_budgets',
					columns: [
						{
							name: 'id',
							type: 'uuid',
							isPrimary: true,
							isGenerated: true,
							generationStrategy: 'uuid',
							default: 'uuid_generate_v4()',
						},
						{ name: 'agentId', type: 'uuid', isNullable: false },
						{ name: 'intervalUnit', type: 'varchar', length: '16', isNullable: false },
						{ name: 'intervalAnchor', type: 'timestamp', isNullable: true },
						{ name: 'capCents', type: 'int', isNullable: false },
						{
							name: 'currency',
							type: 'varchar',
							length: '3',
							isNullable: false,
							default: "'usd'",
						},
						{
							name: 'allowOverage',
							type: 'boolean',
							isNullable: false,
							default: false,
						},
						{
							name: 'createdAt',
							type: 'timestamp',
							default: 'now()',
							isNullable: false,
						},
						{
							name: 'updatedAt',
							type: 'timestamp',
							default: 'now()',
							isNullable: false,
						},
					],
					foreignKeys: [
						{
							name: 'fk_agent_budgets_agent',
							columnNames: ['agentId'],
							referencedTableName: 'agents',
							referencedColumnNames: ['id'],
							onDelete: 'CASCADE',
						},
					],
				}),
				true,
			);
		}

		await this.ensureIndex(
			queryRunner,
			'agent_budgets',
			'uq_agent_budgets_agentId',
			['agentId'],
			true,
		);

		// ── agent_memberships ────────────────────────────────────────
		if (!(await queryRunner.hasTable('agent_memberships'))) {
			await queryRunner.createTable(
				new Table({
					name: 'agent_memberships',
					columns: [
						{
							name: 'id',
							type: 'uuid',
							isPrimary: true,
							isGenerated: true,
							generationStrategy: 'uuid',
							default: 'uuid_generate_v4()',
						},
						{ name: 'agentId', type: 'uuid', isNullable: false },
						{ name: 'targetType', type: 'varchar', length: '16', isNullable: false },
						{ name: 'targetId', type: 'uuid', isNullable: true },
						{
							name: 'createdAt',
							type: 'timestamp',
							default: 'now()',
							isNullable: false,
						},
					],
					foreignKeys: [
						{
							name: 'fk_agent_memberships_agent',
							columnNames: ['agentId'],
							referencedTableName: 'agents',
							referencedColumnNames: ['id'],
							onDelete: 'CASCADE',
						},
					],
				}),
				true,
			);
		}

		await this.ensureIndex(
			queryRunner,
			'agent_memberships',
			'uq_agent_membership',
			['agentId', 'targetType', 'targetId'],
			true,
		);
		await this.ensureIndex(queryRunner, 'agent_memberships', 'idx_agent_memberships_target', [
			'targetType',
			'targetId',
		]);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		// Drop in reverse dependency order. FKs cascade-drop with table.
		for (const t of ['agent_memberships', 'agent_budgets', 'agent_run_logs', 'agent_runs', 'agents']) {
			if (await queryRunner.hasTable(t)) {
				await queryRunner.dropTable(t);
			}
		}
	}

	private async ensureIndex(
		queryRunner: QueryRunner,
		tableName: string,
		indexName: string,
		columnNames: string[],
		isUnique = false,
	): Promise<void> {
		const table = await queryRunner.getTable(tableName);
		const exists = table?.indices.some((idx) => idx.name === indexName);
		if (!exists) {
			await queryRunner.createIndex(
				tableName,
				new TableIndex({ name: indexName, columnNames, isUnique }),
			);
		}
	}
}

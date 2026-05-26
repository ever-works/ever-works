import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Tasks feature — Phase 11.3 (`features/task-tracking/plan.md §3.3`).
 *
 * Creates the 11 tables behind the Tasks family + a 12th
 * `user_task_counter` row for the human-readable slug sequence.
 *
 * Tables created (in FK-safe order — parent table first):
 *   - tasks               — core Task entity + recurring columns (F5)
 *   - task_assignees      — many-to-many (Task, actor) for assignees
 *   - task_reviewers      — same shape + reviewState/reviewedAt
 *   - task_approvers      — same shape + approvalState/approvedAt
 *   - task_blocks         — hard dependency edges
 *   - task_relations      — soft related/duplicates/follow-up edges
 *   - task_chat_messages  — per-Task chat thread
 *   - task_attachments    — Task → work_knowledge_upload edge
 *   - task_watchers       — explicit subscriptions
 *   - task_kb_mentions    — materialized KB references
 *   - user_task_counter   — per-user atomic slug sequence
 *
 * `tasks.parentTaskId`, `task_blocks.blockedByTaskId`,
 * `task_relations.relatedTaskId`, and `task_attachments.uploadId` are
 * deliberately NOT created as FKs. The first three would create a
 * self-referential cycle in the schema graph; the fourth points at
 * an upload row that may have been deleted independently. The
 * Task service validates the references on every write.
 *
 * Idempotent: every createTable / createIndex gates on `has*`.
 */
export class CreateTasksTables1779978013000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		if (!(await queryRunner.hasTable('tasks'))) {
			await queryRunner.createTable(
				new Table({
					name: 'tasks',
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
						{ name: 'slug', type: 'varchar', length: '16', isNullable: false },
						{ name: 'title', type: 'varchar', length: '200', isNullable: false },
						{ name: 'description', type: 'text', isNullable: true },
						{
							name: 'status',
							type: 'varchar',
							length: '16',
							isNullable: false,
							default: "'backlog'",
						},
						{ name: 'previousStatus', type: 'varchar', length: '16', isNullable: true },
						{
							name: 'priority',
							type: 'varchar',
							length: '4',
							isNullable: false,
							default: "'p3'",
						},
						{ name: 'labels', type: 'text', isNullable: true },
						{ name: 'missionId', type: 'uuid', isNullable: true },
						{ name: 'ideaId', type: 'uuid', isNullable: true },
						{ name: 'workId', type: 'uuid', isNullable: true },
						{ name: 'parentTaskId', type: 'uuid', isNullable: true },
						{ name: 'createdByType', type: 'varchar', length: '16', isNullable: false },
						{ name: 'createdById', type: 'uuid', isNullable: false },
						{
							name: 'requireAllApprovers',
							type: 'boolean',
							isNullable: false,
							default: true,
						},
						{ name: 'startedAt', type: 'timestamp', isNullable: true },
						{ name: 'completedAt', type: 'timestamp', isNullable: true },
						{ name: 'promotedToIdeaId', type: 'uuid', isNullable: true },
						// Recurring (F5 override)
						{ name: 'isRecurring', type: 'boolean', isNullable: false, default: false },
						{ name: 'recurrenceRule', type: 'varchar', length: '200', isNullable: true },
						{
							name: 'recurrenceTimezone',
							type: 'varchar',
							length: '64',
							isNullable: true,
							default: "'UTC'",
						},
						{ name: 'nextOccurrenceAt', type: 'timestamp', isNullable: true },
						{ name: 'recurrenceEndsAt', type: 'timestamp', isNullable: true },
						{ name: 'recurrenceMaxOccurrences', type: 'int', isNullable: true },
						{
							name: 'recurrenceOccurredCount',
							type: 'int',
							isNullable: false,
							default: 0,
						},
						{ name: 'parentRecurringTaskId', type: 'uuid', isNullable: true },
						{ name: 'createdAt', type: 'timestamp', default: 'now()', isNullable: false },
						{ name: 'updatedAt', type: 'timestamp', default: 'now()', isNullable: false },
					],
					foreignKeys: [
						{
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

		// Review-fix C1: slug uniqueness is per-user, not global. The
		// UserTaskCounter increments per user (T-1, T-2, …) so two users
		// will both produce `T-1` — a global unique constraint here
		// would deadlock the platform after the second user creates a
		// Task. Constraint scopes to (userId, slug).
		await this.ensureIndex(queryRunner, 'tasks', 'uq_tasks_slug', ['userId', 'slug'], true);
		await this.ensureIndex(queryRunner, 'tasks', 'idx_tasks_user_status', ['userId', 'status']);
		await this.ensureIndex(queryRunner, 'tasks', 'idx_tasks_work', ['workId', 'status']);
		await this.ensureIndex(queryRunner, 'tasks', 'idx_tasks_mission', ['missionId', 'status']);
		await this.ensureIndex(queryRunner, 'tasks', 'idx_tasks_idea', ['ideaId', 'status']);
		await this.ensureIndex(queryRunner, 'tasks', 'idx_tasks_parent', ['parentTaskId']);
		await this.ensureIndex(queryRunner, 'tasks', 'idx_tasks_recurrence_due', [
			'isRecurring',
			'nextOccurrenceAt',
		]);

		await this.createJoinTable(queryRunner, 'task_assignees', [
			{ name: 'assigneeType', type: 'varchar', length: '8', isNullable: false },
			{ name: 'assigneeId', type: 'uuid', isNullable: false },
		]);
		await this.ensureIndex(
			queryRunner,
			'task_assignees',
			'uq_task_assignee',
			['taskId', 'assigneeType', 'assigneeId'],
			true,
		);
		await this.ensureIndex(queryRunner, 'task_assignees', 'idx_task_assignee_actor', [
			'assigneeType',
			'assigneeId',
		]);

		await this.createJoinTable(queryRunner, 'task_reviewers', [
			{ name: 'reviewerType', type: 'varchar', length: '8', isNullable: false },
			{ name: 'reviewerId', type: 'uuid', isNullable: false },
			{ name: 'reviewState', type: 'varchar', length: '24', default: "'pending'", isNullable: false },
			{ name: 'reviewedAt', type: 'timestamp', isNullable: true },
		]);
		await this.ensureIndex(
			queryRunner,
			'task_reviewers',
			'uq_task_reviewer',
			['taskId', 'reviewerType', 'reviewerId'],
			true,
		);
		await this.ensureIndex(queryRunner, 'task_reviewers', 'idx_task_reviewer_actor', [
			'reviewerType',
			'reviewerId',
		]);

		await this.createJoinTable(queryRunner, 'task_approvers', [
			{ name: 'approverType', type: 'varchar', length: '8', isNullable: false },
			{ name: 'approverId', type: 'uuid', isNullable: false },
			{ name: 'approvalState', type: 'varchar', length: '16', default: "'pending'", isNullable: false },
			{ name: 'approvedAt', type: 'timestamp', isNullable: true },
		]);
		await this.ensureIndex(
			queryRunner,
			'task_approvers',
			'uq_task_approver',
			['taskId', 'approverType', 'approverId'],
			true,
		);
		await this.ensureIndex(queryRunner, 'task_approvers', 'idx_task_approver_actor', [
			'approverType',
			'approverId',
		]);

		await this.createJoinTable(queryRunner, 'task_blocks', [
			{ name: 'blockedByTaskId', type: 'uuid', isNullable: false },
		]);
		await this.ensureIndex(
			queryRunner,
			'task_blocks',
			'uq_task_block',
			['taskId', 'blockedByTaskId'],
			true,
		);
		await this.ensureIndex(queryRunner, 'task_blocks', 'idx_task_blocked_by', ['blockedByTaskId']);

		await this.createJoinTable(queryRunner, 'task_relations', [
			{ name: 'relatedTaskId', type: 'uuid', isNullable: false },
			{ name: 'kind', type: 'varchar', length: '16', isNullable: false },
		]);
		await this.ensureIndex(
			queryRunner,
			'task_relations',
			'uq_task_relation',
			['taskId', 'relatedTaskId'],
			true,
		);
		await this.ensureIndex(queryRunner, 'task_relations', 'idx_task_related', ['relatedTaskId']);

		if (!(await queryRunner.hasTable('task_chat_messages'))) {
			await queryRunner.createTable(
				new Table({
					name: 'task_chat_messages',
					columns: [
						{
							name: 'id',
							type: 'uuid',
							isPrimary: true,
							isGenerated: true,
							generationStrategy: 'uuid',
							default: 'uuid_generate_v4()',
						},
						{ name: 'taskId', type: 'uuid', isNullable: false },
						{ name: 'authorType', type: 'varchar', length: '8', isNullable: false },
						{ name: 'authorId', type: 'uuid', isNullable: false },
						{ name: 'body', type: 'text', isNullable: false },
						{ name: 'mentions', type: 'text', isNullable: true },
						{ name: 'attachments', type: 'text', isNullable: true },
						{ name: 'editedAt', type: 'timestamp', isNullable: true },
						{ name: 'createdAt', type: 'timestamp', default: 'now()', isNullable: false },
						{ name: 'updatedAt', type: 'timestamp', default: 'now()', isNullable: false },
					],
					foreignKeys: [
						{
							columnNames: ['taskId'],
							referencedTableName: 'tasks',
							referencedColumnNames: ['id'],
							onDelete: 'CASCADE',
						},
					],
				}),
				true,
			);
		}
		await this.ensureIndex(queryRunner, 'task_chat_messages', 'idx_task_chat_task_created', [
			'taskId',
			'createdAt',
		]);
		await this.ensureIndex(queryRunner, 'task_chat_messages', 'idx_task_chat_author', [
			'authorType',
			'authorId',
		]);

		await this.createJoinTable(queryRunner, 'task_attachments', [
			{ name: 'uploadId', type: 'uuid', isNullable: false },
		]);
		await this.ensureIndex(
			queryRunner,
			'task_attachments',
			'uq_task_attachment',
			['taskId', 'uploadId'],
			true,
		);
		await this.ensureIndex(queryRunner, 'task_attachments', 'idx_task_attachment_upload', [
			'uploadId',
		]);

		await this.createJoinTable(queryRunner, 'task_watchers', [
			{ name: 'userId', type: 'uuid', isNullable: false },
		]);
		await this.ensureIndex(
			queryRunner,
			'task_watchers',
			'uq_task_watcher',
			['taskId', 'userId'],
			true,
		);
		await this.ensureIndex(queryRunner, 'task_watchers', 'idx_task_watcher_user', ['userId']);

		await this.createJoinTable(queryRunner, 'task_kb_mentions', [
			{ name: 'kbDocumentId', type: 'uuid', isNullable: false },
		]);
		await this.ensureIndex(
			queryRunner,
			'task_kb_mentions',
			'uq_task_kb_mention',
			['taskId', 'kbDocumentId'],
			true,
		);
		await this.ensureIndex(queryRunner, 'task_kb_mentions', 'idx_task_kb_mention_doc', [
			'kbDocumentId',
		]);

		if (!(await queryRunner.hasTable('user_task_counter'))) {
			await queryRunner.createTable(
				new Table({
					name: 'user_task_counter',
					columns: [
						{ name: 'userId', type: 'uuid', isPrimary: true, isNullable: false },
						{ name: 'lastSlugNumber', type: 'int', default: 0, isNullable: false },
						{ name: 'updatedAt', type: 'timestamp', default: 'now()', isNullable: false },
					],
					foreignKeys: [
						{
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
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		for (const t of [
			'user_task_counter',
			'task_kb_mentions',
			'task_watchers',
			'task_attachments',
			'task_chat_messages',
			'task_relations',
			'task_blocks',
			'task_approvers',
			'task_reviewers',
			'task_assignees',
			'tasks',
		]) {
			if (await queryRunner.hasTable(t)) {
				await queryRunner.dropTable(t);
			}
		}
	}

	private async createJoinTable(
		queryRunner: QueryRunner,
		name: string,
		extraColumns: Array<Record<string, unknown>>,
	): Promise<void> {
		if (await queryRunner.hasTable(name)) return;
		await queryRunner.createTable(
			new Table({
				name,
				columns: [
					{
						name: 'id',
						type: 'uuid',
						isPrimary: true,
						isGenerated: true,
						generationStrategy: 'uuid',
						default: 'uuid_generate_v4()',
					},
					{ name: 'taskId', type: 'uuid', isNullable: false },
					...(extraColumns as any[]),
					{ name: 'createdAt', type: 'timestamp', default: 'now()', isNullable: false },
				],
				foreignKeys: [
					{
						columnNames: ['taskId'],
						referencedTableName: 'tasks',
						referencedColumnNames: ['id'],
						onDelete: 'CASCADE',
					},
				],
			}),
			true,
		);
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

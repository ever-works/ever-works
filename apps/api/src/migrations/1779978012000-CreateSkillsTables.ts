import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Skills feature — Phase 8.3 (`features/skills/plan.md §3.2`).
 *
 * Creates the two tables behind the new Skill / SkillBinding entities:
 *
 *   - skills          — user-owned skill rows. The owner-type lattice
 *                       supports tenant / mission / idea / work / agent
 *                       scope. instructionsMd stores the body inline;
 *                       Mission/Work scopes also commit to
 *                       `.works/skills/<slug>.md` via GitFacadeService
 *                       (mirrors Agent file storage policy).
 *   - skill_bindings  — many-to-many between skills and targets
 *                       (Agent / Work / Mission / Idea / Tenant) with
 *                       per-binding priority + injection toggles.
 *
 * Idempotent: every createTable / createIndex / createForeignKey
 * gates on the matching `has*` check so the migration is safe to
 * re-run.
 *
 * `text` for simple-json columns (frontmatter) — portable between
 * SQLite (dev/CI) and Postgres (prod).
 */
export class CreateSkillsTables1779978012000 implements MigrationInterface {
	public async up(queryRunner: QueryRunner): Promise<void> {
		if (!(await queryRunner.hasTable('skills'))) {
			await queryRunner.createTable(
				new Table({
					name: 'skills',
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
						{ name: 'ownerType', type: 'varchar', length: '16', isNullable: false },
						{ name: 'ownerId', type: 'uuid', isNullable: false },
						{ name: 'slug', type: 'varchar', length: '80', isNullable: false },
						{ name: 'title', type: 'varchar', length: '120', isNullable: false },
						{ name: 'description', type: 'text', isNullable: false },
						{ name: 'frontmatter', type: 'text', isNullable: false },
						{ name: 'instructionsMd', type: 'text', isNullable: false },
						{ name: 'contentHash', type: 'varchar', length: '64', isNullable: false },
						{ name: 'sourcePath', type: 'varchar', length: '200', isNullable: true },
						{ name: 'sourceCatalogSlug', type: 'varchar', length: '80', isNullable: true },
						{
							name: 'sourceCatalogVersion',
							type: 'varchar',
							length: '16',
							isNullable: true,
						},
						{
							name: 'version',
							type: 'varchar',
							length: '16',
							isNullable: false,
							default: "'1.0.0'",
						},
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

		await this.ensureIndex(
			queryRunner,
			'skills',
			'uq_skills_owner_slug',
			['ownerType', 'ownerId', 'slug'],
			true,
		);
		await this.ensureIndex(queryRunner, 'skills', 'idx_skills_owner', ['ownerType', 'ownerId']);
		await this.ensureIndex(queryRunner, 'skills', 'idx_skills_user', ['userId']);

		if (!(await queryRunner.hasTable('skill_bindings'))) {
			await queryRunner.createTable(
				new Table({
					name: 'skill_bindings',
					columns: [
						{
							name: 'id',
							type: 'uuid',
							isPrimary: true,
							isGenerated: true,
							generationStrategy: 'uuid',
							default: 'uuid_generate_v4()',
						},
						{ name: 'skillId', type: 'uuid', isNullable: false },
						{ name: 'targetType', type: 'varchar', length: '16', isNullable: false },
						{ name: 'targetId', type: 'uuid', isNullable: true },
						{ name: 'userId', type: 'uuid', isNullable: false },
						{
							name: 'injectIntoAgent',
							type: 'boolean',
							isNullable: false,
							default: true,
						},
						{
							name: 'injectIntoGenerator',
							type: 'boolean',
							isNullable: false,
							default: false,
						},
						{ name: 'priority', type: 'int', isNullable: false, default: 100 },
						{ name: 'createdAt', type: 'timestamp', default: 'now()', isNullable: false },
					],
					foreignKeys: [
						{
							columnNames: ['skillId'],
							referencedTableName: 'skills',
							referencedColumnNames: ['id'],
							onDelete: 'CASCADE',
						},
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

		await this.ensureIndex(
			queryRunner,
			'skill_bindings',
			'uq_skill_binding',
			['skillId', 'targetType', 'targetId'],
			true,
		);
		await this.ensureIndex(queryRunner, 'skill_bindings', 'idx_skill_binding_target', [
			'targetType',
			'targetId',
		]);
		await this.ensureIndex(queryRunner, 'skill_bindings', 'idx_skill_binding_user', ['userId']);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		for (const t of ['skill_bindings', 'skills']) {
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

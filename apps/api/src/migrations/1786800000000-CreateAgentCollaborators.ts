import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Agent Collaborators — the `agent_collaborators` table.
 *
 * ## Why
 *
 * Sub-agent delegation (judgment layer G9) let a parent name ANY
 * same-owner agent as `childAgentId` — the only check in the runner was
 * ownership. This table is the per-agent allow-list layered on top:
 * which OTHER agents this agent may spawn/delegate to as sub-agents.
 * No rows for an agent keeps exactly the legacy self-only default; rows
 * make named children admissible only while their `enabled` toggle is
 * on. Enforcement: `SubAgentDelegationRunnerService` via the pure
 * `evaluateCollaboratorDelegation` helper in `@ever-works/contracts`.
 *
 * ## Additive
 *
 * One new table; no existing table changes. Nothing to backfill — no
 * rows means "self only", which is what every existing agent had.
 *
 * ## Shape notes
 *
 * - UNIQUE(agentId, collaboratorAgentId) makes the PUT upsert
 *   idempotent — toggling is an UPDATE, never a second row.
 * - Both agent FKs CASCADE: deleting EITHER end of the edge removes the
 *   rule (a rule naming a dead agent is meaningless and would refuse
 *   forever).
 * - `agentId != collaboratorAgentId` is a SERVICE guard
 *   (`AgentCollaboratorRepository.upsert` throws) rather than a DB
 *   CHECK — no other migration here uses TableCheck, and the portable
 *   Table API's CHECK quoting differs between postgres and
 *   better-sqlite3 (the CI driver). The unique index still makes the
 *   worst case one inert row, and the runner treats a self edge as
 *   allowed anyway.
 * - `tenantId`/`organizationId` are the EW-651 Tier C denorm columns,
 *   nullable and unwritten for now (every read path is keyed on
 *   `agentId`, which the API owner-checks). NO scope XOR CHECK (see
 *   1784820000000-CreateWorkflows for why that pattern aborts).
 *
 * Built with TypeORM's portable `Table` API because CI and the e2e
 * stack run better-sqlite3 while production runs Postgres. Forward-only
 * with an idempotent guard (house pattern, mirrors
 * 1785000000000-CreateTermsAcceptance).
 */
export class CreateAgentCollaborators1786800000000 implements MigrationInterface {
    name = 'CreateAgentCollaborators1786800000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('agent_collaborators')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'agent_collaborators',
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
                    { name: 'agentId', type: 'uuid', isNullable: false },
                    { name: 'collaboratorAgentId', type: 'uuid', isNullable: false },
                    { name: 'enabled', type: 'boolean', default: true, isNullable: false },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()', isNullable: false },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()', isNullable: false },
                ],
            }),
            true,
        );

        // Guarded on the agents table existing so the migration (and its
        // sqlite harness spec) never explodes on a database where the
        // referenced table is not there yet — same posture as
        // 1784820000000-CreateWorkflows' users FK.
        if (await queryRunner.hasTable('agents')) {
            await queryRunner.createForeignKey(
                'agent_collaborators',
                new TableForeignKey({
                    name: 'fk_agent_collaborators_agent',
                    columnNames: ['agentId'],
                    referencedTableName: 'agents',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'agent_collaborators',
                new TableForeignKey({
                    name: 'fk_agent_collaborators_collaborator',
                    columnNames: ['collaboratorAgentId'],
                    referencedTableName: 'agents',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }

        // The upsert key — one rule per (parent, collaborator) pair.
        await queryRunner.createIndex(
            'agent_collaborators',
            new TableIndex({
                name: 'uq_agent_collaborator',
                columnNames: ['agentId', 'collaboratorAgentId'],
                isUnique: true,
            }),
        );
        // Reverse lookup: "which agents list THIS one as a collaborator?"
        await queryRunner.createIndex(
            'agent_collaborators',
            new TableIndex({
                name: 'idx_agent_collaborators_collaborator',
                columnNames: ['collaboratorAgentId'],
            }),
        );
        // Owner-scoped listings for the settings surface.
        await queryRunner.createIndex(
            'agent_collaborators',
            new TableIndex({
                name: 'idx_agent_collaborators_user',
                columnNames: ['userId'],
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverting removes the feature's configuration wholesale: every
        // agent falls back to the legacy self-only delegation default. No
        // other table references these rows.
        if (await queryRunner.hasTable('agent_collaborators')) {
            await queryRunner.dropTable('agent_collaborators');
        }
    }
}

import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Agent Dispatch Guardrails — two additive columns:
 *
 *   1. `agents.guardrails` — nullable TEXT backing the entity's
 *      `simple-json` column (portable across sqlite + postgres, same
 *      choice as `agents.targets` / `agent_action_proposals.payload`).
 *      Holds the per-Agent dispatch policy (`mode` +
 *      `autoApproveActionTypes` + `blockedActionTypes` — see
 *      `packages/agent/src/agents/guardrails.ts`). NULL = default
 *      queue-everything posture, so existing rows keep today's
 *      behavior with no backfill.
 *
 *   2. `agent_action_proposals.decidedVia` — nullable varchar(16),
 *      `'user' | 'guardrail'`. Marks whether a decided proposal was
 *      decided by a human in the queue or auto-decided at creation by
 *      the Agent's guardrails. NULL while pending; existing decided
 *      rows stay NULL (pre-guardrails decisions were all human, but we
 *      don't rewrite history in a migration).
 *
 * Forward-only, additive, idempotent (gates on `hasColumn`) — same
 * pattern as `1779991011000-AddMemorySessionIdToAgentRuns`.
 */
export class AddAgentGuardrailsAndProposalDecidedVia1781900000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('agents', 'guardrails'))) {
            await queryRunner.addColumn(
                'agents',
                new TableColumn({
                    name: 'guardrails',
                    type: 'text',
                    isNullable: true,
                }),
            );
        }

        if (!(await queryRunner.hasColumn('agent_action_proposals', 'decidedVia'))) {
            await queryRunner.addColumn(
                'agent_action_proposals',
                new TableColumn({
                    name: 'decidedVia',
                    type: 'varchar',
                    length: '16',
                    isNullable: true,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasColumn('agent_action_proposals', 'decidedVia')) {
            await queryRunner.dropColumn('agent_action_proposals', 'decidedVia');
        }
        if (await queryRunner.hasColumn('agents', 'guardrails')) {
            await queryRunner.dropColumn('agents', 'guardrails');
        }
    }
}

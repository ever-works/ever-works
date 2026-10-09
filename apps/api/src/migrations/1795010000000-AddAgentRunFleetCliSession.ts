import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Self-build slice AU (fleet run continuity) — adds
 * `agent_runs.fleetCliSession`, WHICH fleet node holds a run's CLI session.
 *
 * Entity: `packages/agent/src/entities/agent-run.entity.ts` (`fleetCliSession`)
 * Writer: `apps/api/src/fleet/fleet-agent-task-reconciler.service.ts` — from a
 * node's completion report, through `AgentRunRepository.recordFleetCliSession`,
 * which writes it together with `cliSessionId` in one statement; and
 * `RunSteeringService.resume`, which carries it onto the successor beside
 * `cliSessionId`.
 * Reader: `apps/api/src/fleet/fleet-agent-task-planner.service.ts` — offers the
 * session to the successor's job as `execution.resume`.
 *
 * ## Why a column
 *
 * An answered owner question used to restart the model from zero: the node
 * reported `result.model.sessionId` and nothing kept it, so the answer run
 * opened a fresh CLI session with none of the reasoning behind the question.
 * The session id itself has a home — `cliSessionId`, the run's resume key,
 * which resume already carries — but a model CLI keeps its sessions in ONE
 * machine's config home, so the id is useless without the node that holds it
 * (and the provider that minted it). No existing column says that, hence one.
 *
 * ## What `up()` does, and nothing else
 *
 * ONE nullable `text` column (TypeORM `simple-json`: `{ sessionId, nodeId,
 * provider }` — ids only, never content) with no default and no index: it is
 * read with the run by primary key only. Nothing is renamed, dropped or
 * narrowed.
 *
 * ## No backfill
 *
 * No session was ever recorded before this column, so NULL ("no fleet session
 * known") is the true value of every existing row, and a run parked before the
 * upgrade simply resumes as it did before — a fresh session with the owner's
 * answer in its instructions.
 *
 * ## Forward-only, idempotent, portable
 *
 * Both directions are guarded (`hasTable` and `hasColumn`), so a re-run is a
 * no-op and `down()` is safe on a database where `up()` never ran. Portable
 * `TableColumn` DDL, because the e2e stack and CI run better-sqlite3 while
 * production runs Postgres.
 */
export class AddAgentRunFleetCliSession1795010000000 implements MigrationInterface {
    name = 'AddAgentRunFleetCliSession1795010000000';

    private static readonly TABLE = 'agent_runs';
    private static readonly COLUMN = 'fleetCliSession';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const { TABLE, COLUMN } = AddAgentRunFleetCliSession1795010000000;
        if (!(await queryRunner.hasTable(TABLE))) return;
        if (await queryRunner.hasColumn(TABLE, COLUMN)) return;

        await queryRunner.addColumn(
            TABLE,
            new TableColumn({ name: COLUMN, type: 'text', isNullable: true }),
        );
    }

    /** Drops the one column `up()` added — nothing else. */
    public async down(queryRunner: QueryRunner): Promise<void> {
        const { TABLE, COLUMN } = AddAgentRunFleetCliSession1795010000000;
        if (!(await queryRunner.hasTable(TABLE))) return;
        if (!(await queryRunner.hasColumn(TABLE, COLUMN))) return;

        await queryRunner.dropColumn(TABLE, COLUMN);
    }
}

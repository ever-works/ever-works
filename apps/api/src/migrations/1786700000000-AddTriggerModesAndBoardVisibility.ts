import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Task Triggers, second batch — the trigger "shape" columns the New
 * Trigger form and the trigger detail page write, plus the board-
 * visibility flag their spawned Tasks carry.
 *
 * ## `inbound_triggers`
 *
 *  - `mode`             — varchar(16) NOT NULL DEFAULT 'single-task'
 *                         ('single-task' | 'template'). IMMUTABLE after
 *                         create (enforced in the service, not the DB:
 *                         the API never issues an UPDATE for it).
 *  - `agentPrompt`      — text NULL; 'single-task' instructions. The
 *                         delivery payload is appended at fire time in a
 *                         neutralized `<webhook_body>` block.
 *  - `showOnBoard`      — boolean NOT NULL DEFAULT false; when true the
 *                         primary Task a fire produces is visible on the
 *                         Kanban board.
 *  - `replayWindowSec`  — int NOT NULL DEFAULT 300; per-trigger replay
 *                         window (timestamp freshness AND duplicate
 *                         delivery suppression).
 *  - `autoStart`        — varchar(16) NOT NULL DEFAULT 'always'
 *                         ('always' | 'manual').
 *  - `defaultVariables` — text NULL; `simple-json` array of
 *                         `{key, label?, required}` the payload must
 *                         satisfy. `simple-json` is plain text at the DB
 *                         level on every supported driver.
 *
 * Every default reproduces the pre-existing behavior exactly, so rows
 * created before this migration keep firing the way they always did.
 *
 * ## `tasks`
 *
 *  - `hiddenFromBoard`  — boolean NOT NULL DEFAULT false. Board/list
 *                         reads exclude hidden rows unless the caller
 *                         opts in (`includeHidden`), which is how a
 *                         trigger with `showOnBoard: false` keeps its
 *                         automated Tasks out of the human board without
 *                         hiding them from the trigger's fire log.
 *
 * Forward-only with idempotent per-step guards (house pattern, mirrors
 * 1784100000000-AddRunSteeringColumns). Portable across postgres and
 * better-sqlite3 (CI/e2e).
 */
export class AddTriggerModesAndBoardVisibility1786700000000 implements MigrationInterface {
    name = 'AddTriggerModesAndBoardVisibility1786700000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const triggers = await queryRunner.getTable('inbound_triggers');
        if (triggers) {
            const addTriggerColumn = async (name: string, ddl: string) => {
                if (!triggers.findColumnByName(name)) {
                    await queryRunner.query(`ALTER TABLE "inbound_triggers" ADD COLUMN ${ddl}`);
                }
            };
            await addTriggerColumn('mode', `"mode" varchar(16) NOT NULL DEFAULT 'single-task'`);
            await addTriggerColumn('agentPrompt', `"agentPrompt" text`);
            await addTriggerColumn('showOnBoard', `"showOnBoard" boolean NOT NULL DEFAULT false`);
            await addTriggerColumn(
                'replayWindowSec',
                `"replayWindowSec" integer NOT NULL DEFAULT 300`,
            );
            await addTriggerColumn(
                'autoStart',
                `"autoStart" varchar(16) NOT NULL DEFAULT 'always'`,
            );
            await addTriggerColumn('defaultVariables', `"defaultVariables" text`);
        }

        const tasks = await queryRunner.getTable('tasks');
        if (tasks && !tasks.findColumnByName('hiddenFromBoard')) {
            await queryRunner.query(
                `ALTER TABLE "tasks" ADD COLUMN "hiddenFromBoard" boolean NOT NULL DEFAULT false`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const tasks = await queryRunner.getTable('tasks');
        if (tasks?.findColumnByName('hiddenFromBoard')) {
            // Dropping this only makes hidden Tasks visible again — it
            // destroys a display preference, never work.
            await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "hiddenFromBoard"`);
        }

        const triggers = await queryRunner.getTable('inbound_triggers');
        if (!triggers) return;
        for (const column of [
            'defaultVariables',
            'autoStart',
            'replayWindowSec',
            'showOnBoard',
            'agentPrompt',
            'mode',
        ]) {
            if (triggers.findColumnByName(column)) {
                await queryRunner.query(`ALTER TABLE "inbound_triggers" DROP COLUMN "${column}"`);
            }
        }
    }
}

import { Command } from 'commander';
import chalk from 'chalk';
import {
    FLEET_TOOL_CATALOGUE,
    type FleetCliEnvelope,
    type FleetToolCatalogueEntry,
} from '@ever-works/contracts';
import { FLEET_EXIT } from './fleet-exit';
import { fleetTable } from './fleet-output';

/**
 * `ever-works fleet tools [--family <f>] [--planned] [--json]` (FL-19) — the
 * fleet tool catalogue, read locally: every `fleet_<family>_<verb>` tool an
 * Agent, the MCP server and this CLI share, with its annotation (read-only, or
 * destructive with its confirmation class and AW-24 category), its permission
 * family, its flag, and whether this build ships it (`live`) or it is a
 * registration point for a family that has not landed (`planned`). No sign-in
 * needed: nothing leaves the machine.
 */

function annotation(entry: FleetToolCatalogueEntry): string {
    if (entry.readOnly) return chalk.green('read-only');
    return `${entry.destructive ? chalk.red('destructive') : 'act'} · ${entry.confirmationClass} · ${entry.category}`;
}

export const toolsCommand = new Command('tools')
    .description('The fleet tool catalogue an Agent, the MCP server and this CLI share')
    .option('--family <family>', 'Only one tool family (sessions, services, docker, …)')
    .option('--planned', 'Include tools of families that have not landed yet')
    .option('--json', 'Machine-readable output')
    .action((options: { family?: string; planned?: boolean; json?: boolean }) => {
        const rows = FLEET_TOOL_CATALOGUE.filter(
            (entry) =>
                (options.planned === true || entry.status === 'live') &&
                (!options.family || entry.family === options.family),
        );
        if (options.json) {
            const envelope: FleetCliEnvelope<FleetToolCatalogueEntry[]> = { ok: true, data: rows };
            process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
            process.exit(FLEET_EXIT.ok);
        }
        const table = [['TOOL', 'KIND', 'PERMISSION', 'CLI', 'STATUS']];
        for (const entry of rows) {
            table.push([
                entry.name,
                annotation(entry),
                entry.permissionFamily,
                entry.cli ? `ever-works ${entry.cli}` : '—',
                entry.status === 'live' ? entry.status : chalk.gray(entry.status),
            ]);
        }
        console.log(rows.length === 0 ? chalk.yellow('No tools.') : fleetTable(table));
        process.exit(FLEET_EXIT.ok);
    });

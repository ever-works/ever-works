import { Command } from 'commander';
import chalk from 'chalk';
import type { FleetStatusView } from '@ever-works/contracts';
import { runFleetVerb } from './fleet-client';
import { fleetTable } from './fleet-output';

/**
 * `ever-works fleet status [--json]` (FL-19, spec S1, FR-4) — "how is my
 * fleet?" in one call: every computer I may see, what needs a look, the kill
 * switch, the server time. `--json` prints `{ ok: true, data: FleetStatusView }`.
 */

function percent(value: number | undefined): string {
    return typeof value === 'number' ? `${Math.round(value)}%` : '—';
}

function statusColour(status: string): string {
    if (status === 'online') return chalk.green(status);
    if (status === 'offline') return chalk.gray(status);
    if (status === 'disabled') return chalk.yellow(status);
    return status;
}

export function printFleetStatus(view: FleetStatusView): void {
    if (view.killSwitch.stopped) {
        console.log(chalk.red(`■ All computers are stopped${view.killSwitch.reason ? ` — ${view.killSwitch.reason}` : ''}`));
    } else if (view.killSwitch.unverified) {
        console.log(chalk.yellow('? The fleet stop switch could not be read'));
    }
    if (view.computers.length === 0) {
        console.log(chalk.yellow('You have no computers yet. Add one under Settings → Fleet.'));
    } else {
        const rows = [['COMPUTER', 'STATUS', 'PLATFORM', 'CPU', 'MEM', 'DISK', 'SESSIONS', 'ROLE']];
        for (const computer of view.computers) {
            rows.push([
                computer.name,
                statusColour(computer.status),
                computer.platform ?? '—',
                percent(computer.health?.cpuPercent),
                percent(computer.health?.memPercent),
                percent(computer.health?.diskPercent),
                computer.sessionCount === null ? '—' : String(computer.sessionCount),
                computer.viewerRole,
            ]);
        }
        console.log(fleetTable(rows));
    }
    if (view.needsALook.length > 0) {
        console.log('');
        console.log(chalk.bold('Needs a look'));
        const names = new Map(view.computers.map((computer) => [computer.id, computer.name]));
        for (const item of view.needsALook) {
            const mark = item.severity === 'critical' ? chalk.red('●') : item.severity === 'warn' ? chalk.yellow('●') : chalk.gray('●');
            console.log(`${mark} ${names.get(item.nodeId) ?? item.nodeId}: ${item.title} ${chalk.gray(item.detail)}`);
        }
    }
    if (view.needsALookPartial) console.log(chalk.gray('(some checks did not answer; the list may be incomplete)'));
}

export const statusCommand = new Command('status')
    .description('How is my fleet: computers, what needs a look, the stop switch')
    .option('--json', 'Machine-readable output: { ok, data }')
    .action(async (options: { json?: boolean }) => {
        await runFleetVerb<FleetStatusView>(options.json === true, { method: 'GET', path: '/fleet/status' }, printFleetStatus);
    });

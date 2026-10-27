import { Command } from 'commander';
import chalk from 'chalk';
import { FLEET_OPERATION_STATES, type FleetOperationView } from '@ever-works/contracts';
import { resolveFleetNodeId, runFleetVerb } from './fleet-client';
import { fleetUsage, printFleetList } from './fleet-output';

/**
 * `ever-works fleet operations get|list` (FL-19, spec FR-14; alias
 * `fleet operation`) — the long operations a `--no-wait` verb answered with
 * an id: running, done, failed, cancelled or interrupted (an interrupted one
 * never reads done — CONTRACTS §3.3). `cancel` is FL-19 P2.
 */

function printOperation(view: FleetOperationView): void {
    const state =
        view.state === 'done'
            ? chalk.green(view.state)
            : view.state === 'running'
              ? chalk.cyan(view.state)
              : chalk.yellow(view.state);
    console.log(`${view.id}  ${state}  ${view.family}/${view.verb}  ${chalk.gray(view.startedAt)}`);
    if (view.error) console.log(chalk.red(`✗ ${view.error.code} — ${view.error.hint}`));
    if (view.result !== undefined) console.log(JSON.stringify(view.result, null, 2));
}

const get = new Command('get')
    .description('One operation: state, progress, result or error')
    .argument('<id>', 'The operation id a verb answered with')
    .option('--json', 'Machine-readable output')
    .action(async (id: string, options: { json?: boolean }) => {
        const json = options.json === true;
        if (!id || id.length > 100)
            fleetUsage(json, '<id> is the operation id a verb answered with', 'id');
        await runFleetVerb<FleetOperationView>(
            json,
            { method: 'GET', path: `/fleet/operations/${encodeURIComponent(id)}` },
            printOperation,
        );
    });

const list = new Command('list')
    .description('My recent long operations, newest first (kept one hour after they end)')
    .option('--state <state>', FLEET_OPERATION_STATES.join(' | '))
    .option('--on <computer>', 'Only this computer (id or name)')
    .option('--limit <n>', 'Max operations (1–100)', '20')
    .option('--json', 'Machine-readable output')
    .action(async (options: { state?: string; on?: string; limit?: string; json?: boolean }) => {
        const json = options.json === true;
        if (
            options.state &&
            !(FLEET_OPERATION_STATES as readonly string[]).includes(options.state)
        ) {
            fleetUsage(json, `--state is ${FLEET_OPERATION_STATES.join(', ')}`, 'state');
        }
        const nodeId = options.on ? await resolveFleetNodeId(json, options.on) : undefined;
        await runFleetVerb<FleetOperationView[]>(
            json,
            {
                method: 'GET',
                path: '/fleet/operations',
                query: { state: options.state, nodeId, limit: options.limit },
            },
            (operations) =>
                printFleetList(
                    operations,
                    [
                        { key: 'id', label: 'OPERATION' },
                        { key: 'state', label: 'STATE' },
                        { key: 'family', label: 'FAMILY' },
                        { key: 'verb', label: 'VERB' },
                        { key: 'startedAt', label: 'STARTED' },
                    ],
                    'No operations.',
                ),
        );
    });

export const operationsCommand = new Command('operations')
    .alias('operation')
    .description('Long operations on my computers: get, list')
    .addCommand(get)
    .addCommand(list);

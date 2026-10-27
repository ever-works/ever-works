import { Command } from 'commander';
import type { FleetCommandView } from '@ever-works/contracts';
import { runFleetVerb } from './fleet-client';
import { FLEET_CLI_UUID, fleetUsage, printFleetList } from './fleet-output';

/**
 * `ever-works fleet commands list|get` (FL-19 T-10; FL-12's `fleet_commands_list`
 * / `fleet_commands_get`) — the reads beside FL-12's `fleet commands run`.
 */

export const commandsListCommand = new Command('list')
    .description('My recent commands on my computers')
    .option('--json', 'Machine-readable output')
    .action(async (options: { json?: boolean }) => {
        await runFleetVerb<unknown>(
            options.json === true,
            { method: 'GET', path: '/fleet/commands' },
            (data) =>
                printFleetList(
                    data,
                    [
                        { key: 'id', label: 'COMMAND' },
                        { key: 'commandLine', label: 'LINE' },
                        { key: 'state', label: 'STATE' },
                        { key: 'createdAt', label: 'STARTED' },
                    ],
                    'No commands.',
                ),
        );
    });

export const commandsGetCommand = new Command('get')
    .description('One command: its runs on each computer and their output')
    .argument('<id>', 'Command id')
    .option('--json', 'Machine-readable output')
    .action(async (id: string, options: { json?: boolean }) => {
        const json = options.json === true;
        if (!FLEET_CLI_UUID.test(id)) fleetUsage(json, '<id> must be a command id', 'id');
        await runFleetVerb<FleetCommandView>(
            json,
            { method: 'GET', path: `/fleet/commands/${id}` },
            (command) =>
                printFleetList(
                    command,
                    [
                        { key: 'nodeName', label: 'COMPUTER' },
                        { key: 'state', label: 'STATE' },
                        { key: 'exitCode', label: 'EXIT' },
                    ],
                    'No runs.',
                ),
        );
    });

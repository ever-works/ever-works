import { Command } from 'commander';
import chalk from 'chalk';
import type { FleetSessionView } from '@ever-works/contracts';
import { runFleetVerb } from '../fleet-client';
import { FLEET_CLI_UUID, fleetUsage } from '../fleet-output';

/**
 * `ever-works fleet sessions read <id> [--json]` (FL-19 T-10; FL-04's
 * `fleet_sessions_read`) — one session with its last screen.
 */
export const readCommand = new Command('read')
    .description('One session: state, computer, and its last screen')
    .argument('<id>', 'Session id')
    .option('--json', 'Machine-readable output')
    .action(async (id: string, options: { json?: boolean }) => {
        const json = options.json === true;
        if (!FLEET_CLI_UUID.test(id)) fleetUsage(json, '<id> must be a session id', 'id');
        await runFleetVerb<FleetSessionView & { screen?: string | null }>(
            json,
            { method: 'GET', path: `/fleet/sessions/${id}` },
            (session) => {
                console.log(`${chalk.bold(session.title)}  ${session.state}  ${chalk.gray(session.id)}`);
                if (typeof session.screen === 'string' && session.screen.length > 0) console.log(session.screen);
            },
        );
    });

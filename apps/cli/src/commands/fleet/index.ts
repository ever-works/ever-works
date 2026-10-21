import { Command } from 'commander';
import { checkoutsCommand } from './checkout';

/**
 * `ever-works fleet` — the Fleet command group (CONTRACTS §11.3). FL-14 adds
 * `fleet checkouts`; FL-19 completes the group with the other families.
 */
export const fleetCommand = new Command('fleet')
    .description('Your computers: checkouts and more')
    .addCommand(checkoutsCommand);

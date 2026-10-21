import { Command } from 'commander';
import { commandsCommand } from './command';
import { attachCommand } from './session/attach';
import { listCommand } from './session/list';

/**
 * `ever-works fleet` (FL-04 P2, plan §9) — your computers from the terminal.
 * This epic ships `fleet session list` and `fleet session attach`; FL-19 adds
 * the rest of `ever-works fleet session <verb>`.
 */
export const fleetSessionCommand = new Command('session')
    .description('Sessions on your computers (list, attach)')
    .addCommand(listCommand)
    .addCommand(attachCommand);

/**
 * `ever-works fleet commands run` (FL-12, CONTRACTS §11.3) — one command on
 * several computers (alias `fleet command`).
 */
export const fleetCommand = new Command('fleet')
    .description('Your computers')
    .addCommand(fleetSessionCommand)
    .addCommand(commandsCommand);

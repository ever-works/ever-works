import { Command } from 'commander';
import { commandsCommand } from './command';

/**
 * `ever-works fleet …` — the Fleet CLI group (CONTRACTS §11.3: `ever-works
 * fleet <family> <verb> [--json]`). FL-19 owns the group and its full
 * catalogue; Commands on computers (FL-12) ships its first verb,
 * `fleet commands run`. Other families add their subcommand here.
 */
export const fleetCommand = new Command('fleet')
    .description('Fleet: your computers (commands)')
    .addCommand(commandsCommand);

export function registerFleetCommands(program: Command): void {
    program.addCommand(fleetCommand);
}

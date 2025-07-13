import { Command, CommandRunner } from 'nest-commander';
import { CreateSubCommand } from './create.subcommand';
import { ListSubCommand } from './list.subcommand';

@Command({
    name: 'directory',
    description: 'Directory management commands',
    subCommands: [CreateSubCommand, ListSubCommand],
})
export class DirectoryCommand extends CommandRunner {
    async run(): Promise<void> {
        console.log('Available directory commands:');
        console.log('  create     - Create a new directory');
        console.log('  list       - List all directories');
        console.log('\nUse "directory <command> --help" for more information about a command.');
    }
}

import { Command, CommandRunner } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { SetupSubCommand } from './setup.subcommand';
import { ShowSubCommand } from './show.subcommand';
import { TestSubCommand } from './test.subcommand';

@Injectable()
@Command({
    name: 'config',
    description: 'Configuration management commands',
    subCommands: [SetupSubCommand, ShowSubCommand, TestSubCommand],
})
export class ConfigCommand extends CommandRunner {
    async run(): Promise<void> {
        console.log('Available config commands:');
        console.log('  setup  - Setup Ever Works CLI configuration');
        console.log('  show   - Show current configuration');
        console.log('  test   - Test configuration');
        console.log('\nUse "config <command> --help" for more information about a command.');
    }
}

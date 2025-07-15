import { Command, CommandRunner } from 'nest-commander';
import { SetupSubCommand } from './setup.subcommand';
import { ShowSubCommand } from './show.subcommand';
import { TestSubCommand } from './test.subcommand';
import { SetSubCommand } from './set.subcommand';
import { UnsetSubCommand } from './unset.subcommand';
import { SwitchAiSubCommand } from './switch-ai.subcommand';

@Command({
    name: 'config',
    description: 'Configuration management commands',
    subCommands: [
        SetupSubCommand,
        ShowSubCommand,
        TestSubCommand,
        SetSubCommand,
        UnsetSubCommand,
        SwitchAiSubCommand,
    ],
})
export class ConfigCommand extends CommandRunner {
    async run(): Promise<void> {
        console.log('Available config commands:');
        console.log('  setup      - Setup Ever Works CLI configuration');
        console.log('  show       - Show current configuration');
        console.log('  test       - Test configuration connectivity');
        console.log('  set        - Set a configuration value');
        console.log('  unset      - Remove a configuration value');
        console.log('  switch-ai  - Switch between configured AI providers');
        console.log('\nUse "config <command> --help" for more information about a command.');
    }
}

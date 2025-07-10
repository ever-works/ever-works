import { Command, CommandRunner, SubCommand } from 'nest-commander';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
@Command({
    name: 'config',
    description: 'Configuration management commands',
    subCommands: ['config:setup', 'config:show', 'config:test'],
})
export class ConfigCommand extends CommandRunner {
    private readonly logger = new Logger(ConfigCommand.name);

    async run(): Promise<void> {
        console.log('Available config commands:');
        console.log('  setup  - Setup Ever Works CLI configuration');
        console.log('  show   - Show current configuration');
        console.log('  test   - Test configuration');
        console.log('\nUse "config <command> --help" for more information about a command.');
    }
}

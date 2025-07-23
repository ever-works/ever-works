import { DirectoryCommand } from './directory.command';
import { DirectoryPromptService } from './directory-prompt.service';
import { ConfigCheckService } from './config-check.service';

export const DirectoryCommands = [
    // Commands
    ...DirectoryCommand.registerWithSubCommands(),

    // Services
    DirectoryPromptService,
    ConfigCheckService,
];

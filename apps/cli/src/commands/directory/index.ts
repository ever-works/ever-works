import { DirectoryCommand } from './directory.command';
import { CreateSubCommand } from './create.subcommand';
import { ListSubCommand } from './list.subcommand';
import { DirectoryPromptService } from './directory-prompt.service';

export const DirectoryCommands = [
    // Commands
    DirectoryCommand,
    CreateSubCommand,
    ListSubCommand,

    // Services
    DirectoryPromptService,
];

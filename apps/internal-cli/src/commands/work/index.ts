import { WorkCommand } from './work.command';
import { WorkPromptService } from './work-prompt.service';
import { ConfigCheckService } from './config-check.service';

export const WorkCommands = [
    // Commands
    ...WorkCommand.registerWithSubCommands(),

    // Services
    WorkPromptService,
    ConfigCheckService,
];

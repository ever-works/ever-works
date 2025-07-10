import { ConfigCommand } from './config.command';
import { SetupSubCommand } from './setup.subcommand';
import { ShowSubCommand } from './show.subcommand';
import { TestSubCommand } from './test.subcommand';
import { SetSubCommand } from './set.subcommand';
import { UnsetSubCommand } from './unset.subcommand';
import { SwitchAiSubCommand } from './switch-ai.subcommand';

// AI Providers
import { AiProviderRegistryService } from './ai-providers/ai-provider-registry.service';

// Prompt Services
import { GitHubGitPromptService } from './prompts/github-git-prompt.service';
import { DeploymentPromptService } from './prompts/deployment-prompt.service';
import { AiProviderPromptService } from './prompts/ai-provider-prompt.service';
import { SearchServicePromptService } from './prompts/search-service-prompt.service';

export const ConfigCommands = [
    // Commands
    ConfigCommand,
    SetupSubCommand,
    ShowSubCommand,
    TestSubCommand,
    SetSubCommand,
    UnsetSubCommand,
    SwitchAiSubCommand,

    // Services
    AiProviderRegistryService,
    GitHubGitPromptService,
    DeploymentPromptService,
    AiProviderPromptService,
    SearchServicePromptService,
];

import { ConfigCommand } from './config.command';

// AI Providers
import { AiProviderRegistryService } from './ai-providers/ai-provider-registry.service';

// Prompt Services
import { GitHubGitPromptService } from './prompts/github-git-prompt.service';
import { DeploymentPromptService } from './prompts/deployment-prompt.service';
import { AiProviderPromptService } from './prompts/ai-provider-prompt.service';
import { SearchServicePromptService } from './prompts/search-service-prompt.service';

export const ConfigCommands = [
    // Commands
    ...ConfigCommand.registerWithSubCommands(),

    // Services
    AiProviderRegistryService,
    GitHubGitPromptService,
    DeploymentPromptService,
    AiProviderPromptService,
    SearchServicePromptService,
];

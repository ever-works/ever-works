import { Module } from '@nestjs/common';
import { AppService } from './app.service';
import { DatabaseConfigurations } from '@packages/agent';

// Commands
import { SetupCommand } from './commands/setup.command';

// Services
import { ConfigService } from './config/config.service';
import { AiProviderRegistryService } from './ai-providers/ai-provider-registry.service';

// Prompt Services
import { GitHubGitPromptService } from './prompts/github-git-prompt.service';
import { DeploymentPromptService } from './prompts/deployment-prompt.service';
import { AiProviderPromptService } from './prompts/ai-provider-prompt.service';
import { SearchServicePromptService } from './prompts/search-service-prompt.service';

@Module({
    imports: [DatabaseConfigurations.cli()],
    providers: [
        AppService,
        // Commands
        SetupCommand,
        // Core Services
        ConfigService,
        AiProviderRegistryService,
        // Prompt Services
        GitHubGitPromptService,
        DeploymentPromptService,
        AiProviderPromptService,
        SearchServicePromptService,
    ],
    controllers: [],
})
export class AppModule {}

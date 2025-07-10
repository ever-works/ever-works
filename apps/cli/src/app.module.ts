import { Module } from '@nestjs/common';
import { AppService } from './app.service';
import { DatabaseConfigurations, AiService } from '@packages/agent';

// Config Module
import { ConfigModule } from './config/config.module';

// Commands
import { ConfigCommand } from './commands/config/config.command';
import { SetupSubCommand } from './commands/config/setup.subcommand';
import { ShowSubCommand } from './commands/config/show.subcommand';
import { TestSubCommand } from './commands/config/test.subcommand';
import { SetSubCommand } from './commands/config/set.subcommand';
import { UnsetSubCommand } from './commands/config/unset.subcommand';
import { SwitchAiSubCommand } from './commands/config/switch-ai.subcommand';

// Services
import { ConfigService } from './config/config.service';
import { AiProviderRegistryService } from './ai-providers/ai-provider-registry.service';

// Prompt Services
import { GitHubGitPromptService } from './prompts/github-git-prompt.service';
import { DeploymentPromptService } from './prompts/deployment-prompt.service';
import { AiProviderPromptService } from './prompts/ai-provider-prompt.service';
import { SearchServicePromptService } from './prompts/search-service-prompt.service';

@Module({
    imports: [DatabaseConfigurations.cli(), ConfigModule],
    providers: [
        AppService,
        // Commands
        ConfigCommand,
        SetupSubCommand,
        ShowSubCommand,
        TestSubCommand,
        SetSubCommand,
        UnsetSubCommand,
        SwitchAiSubCommand,
        // Core Services
        ConfigService,
        AiProviderRegistryService,
        AiService,
        // Prompt Services
        GitHubGitPromptService,
        DeploymentPromptService,
        AiProviderPromptService,
        SearchServicePromptService,
    ],
    controllers: [],
})
export class AppModule {}

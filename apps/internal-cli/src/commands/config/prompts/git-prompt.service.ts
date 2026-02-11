import { Injectable } from '@nestjs/common';
import { BasePromptService } from '@ever-works/cli-shared';
import { GitFacadeService } from '@ever-works/agent/facades';

export interface GitConfig {
    provider: string;
    gitToken: string;
    gitOwner: string;
    gitName: string;
    gitEmail: string;
}

@Injectable()
export class GitPromptService extends BasePromptService {
    constructor(private readonly gitFacade: GitFacadeService) {
        super();
    }

    async promptGitConfig(existingConfig?: any): Promise<GitConfig> {
        this.displaySectionHeader('Git Provider Configuration');
        this.displayInfo('Configure your git provider access and Git identity');

        // Select provider
        const providers = this.gitFacade.getAvailableProviders();
        let provider: string;

        if (providers.length > 1) {
            const choices = providers.map((p) => ({
                name: `${p.name}${p.description ? ` - ${p.description}` : ''}`,
                value: p.id,
            }));
            provider = await this.promptSelect(
                'Select a git provider:',
                choices,
                existingConfig?.GIT_PROVIDER || providers[0].id,
            );
        } else if (providers.length === 1) {
            provider = providers[0].id;
            this.displayInfo(`Using git provider: ${providers[0].name}`);
        } else {
            provider = 'github';
            this.displayInfo('No git providers registered, defaulting to github');
        }

        const providerInfo = providers.find((p) => p.id === provider);
        if (providerInfo?.homepage) {
            this.displayInfo(`Get your Personal Access Token from: ${providerInfo.homepage}`);
        }
        this.displayInfo('Required scopes: repo, user, admin:org (if using organizations)');

        // Token with validation
        let gitToken: string;
        while (true) {
            try {
                gitToken = await this.promptPassword(
                    'Enter your API token (Personal Access Token):',
                );

                const validation = this.validateApiKeyWithProvider(gitToken, provider);
                if (validation !== true) {
                    this.displayError(validation as string);
                    continue;
                }

                // Test the token via facade
                this.displayInfo('Testing API token...');
                const isValid = await this.testGitToken(provider, gitToken);
                if (!isValid) {
                    this.displayError('API token is invalid or lacks required permissions');
                    this.displayInfo(
                        'Please check your token and ensure it has the required scopes',
                    );
                    continue;
                }

                this.displaySuccess('API token validated successfully');
                break;
            } catch (error) {
                this.displayError('Failed to validate API token. Please try again.');
            }
        }

        // Owner
        const gitOwner = await this.promptRequiredText(
            'Enter your git username/organization:',
            existingConfig?.GIT_OWNER,
            this.validateGitUsername.bind(this),
        );

        // Git identity
        const gitName = await this.promptRequiredText(
            'Enter your Git name (for commits):',
            existingConfig?.GIT_NAME,
            this.validateGitName.bind(this),
        );

        const gitEmail = await this.promptRequiredText(
            'Enter your Git email (for commits):',
            existingConfig?.GIT_EMAIL,
            this.validateEmail.bind(this),
        );

        this.displaySuccess('Git provider configuration completed');

        return {
            provider,
            gitToken,
            gitOwner,
            gitName,
            gitEmail,
        };
    }

    private async testGitToken(providerId: string, token: string): Promise<boolean> {
        try {
            await this.gitFacade.getUser({ providerId, token });
            return true;
        } catch {
            return false;
        }
    }
}

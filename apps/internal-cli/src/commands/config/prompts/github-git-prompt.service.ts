import { Injectable } from '@nestjs/common';
import { BasePromptService } from '@packages/cli-shared';

export interface GitHubGitConfig {
    githubApiKey: string;
    githubOwner: string;
    gitName: string;
    gitEmail: string;
}

@Injectable()
export class GitHubGitPromptService extends BasePromptService {
    async promptGitHubGitConfig(existingConfig?: any): Promise<GitHubGitConfig> {
        this.displaySectionHeader('GitHub & Git Configuration');
        this.displayInfo('Configure your GitHub API access and Git identity');

        // GitHub API Key with validation
        this.displayInfo('Get your Personal Access Token from: https://github.com/settings/tokens');
        this.displayInfo('Required scopes: repo, user, admin:org (if using organizations)');

        let githubApiKey: string;
        while (true) {
            try {
                githubApiKey = await this.promptPassword(
                    'Enter your GitHub API Key (Personal Access Token):',
                );

                const validation = this.validateApiKeyWithProvider(githubApiKey, 'GitHub');
                if (validation !== true) {
                    this.displayError(validation as string);
                    continue;
                }

                // Test the API key by making a simple API call
                this.displayInfo('Testing GitHub API key...');
                const isValid = await this.testGitHubApiKey(githubApiKey);
                if (!isValid) {
                    this.displayError('GitHub API key is invalid or lacks required permissions');
                    this.displayInfo(
                        'Please check your token and ensure it has the required scopes',
                    );
                    continue;
                }

                this.displaySuccess('GitHub API key validated successfully');
                break;
            } catch (error) {
                this.displayError('Failed to validate GitHub API key. Please try again.');
            }
        }

        // GitHub Username/Organization with validation
        const githubOwner = await this.promptRequiredText(
            'Enter your GitHub username/organization:',
            existingConfig?.GITHUB_OWNER,
            this.validateGitHubUsername.bind(this),
        );

        // Git Name with validation
        const gitName = await this.promptRequiredText(
            'Enter your Git name (for commits):',
            existingConfig?.GIT_NAME,
            this.validateGitName.bind(this),
        );

        // Git Email with validation
        const gitEmail = await this.promptRequiredText(
            'Enter your Git email (for commits):',
            existingConfig?.GIT_EMAIL,
            this.validateEmail.bind(this),
        );

        this.displaySuccess('GitHub & Git configuration completed');

        return {
            githubApiKey,
            githubOwner,
            gitName,
            gitEmail,
        };
    }

    private async testGitHubApiKey(apiKey: string): Promise<boolean> {
        try {
            const response = await fetch('https://api.github.com/user', {
                headers: {
                    Authorization: `token ${apiKey}`,
                    'User-Agent': 'ever-works-cli',
                },
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}

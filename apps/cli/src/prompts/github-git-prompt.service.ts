import { Injectable } from '@nestjs/common';
import { BasePromptService } from './base-prompt.service';

export interface GitHubGitConfig {
    githubApiKey: string;
    githubOwner: string;
    gitName: string;
    gitEmail: string;
}

@Injectable()
export class GitHubGitPromptService extends BasePromptService {
    async promptGitHubGitConfig(): Promise<GitHubGitConfig> {
        this.displaySectionHeader('GitHub & Git Configuration');
        this.displayInfo('Configure your GitHub API access and Git identity');

        const githubApiKey = await this.promptPassword(
            'githubApiKey',
            'Enter your GitHub API Key (Personal Access Token):'
        );

        const githubOwner = await this.promptRequiredText(
            'githubOwner',
            'Enter your GitHub username/organization:'
        );

        const gitName = await this.promptRequiredText(
            'gitName',
            'Enter your Git name (for commits):'
        );

        const gitEmail = await this.promptRequiredText(
            'gitEmail',
            'Enter your Git email (for commits):'
        );

        this.displaySuccess('GitHub & Git configuration completed');

        return {
            githubApiKey,
            githubOwner,
            gitName,
            gitEmail,
        };
    }
}

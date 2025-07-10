import { Injectable } from '@nestjs/common';
import { BasePromptService } from './base-prompt.service';

export interface DeploymentConfig {
    provider: 'vercel' | 'ignore';
    vercelToken?: string;
}

@Injectable()
export class DeploymentPromptService extends BasePromptService {
    async promptDeploymentConfig(): Promise<DeploymentConfig> {
        this.displaySectionHeader('Deployment Provider Configuration');
        this.displayInfo('Configure your deployment provider (you can add more providers later)');

        const provider = await this.promptSelect(
            'deploymentProvider',
            'Select a deployment provider:',
            [
                { name: 'Vercel', value: 'vercel' as const },
                { name: 'Skip deployment configuration', value: 'ignore' as const },
            ]
        );

        let vercelToken: string | undefined;

        if (provider === 'vercel') {
            this.displayInfo('You can get your Vercel token from: https://vercel.com/account/tokens');
            vercelToken = await this.promptPassword(
                'vercelToken',
                'Enter your Vercel token:'
            );
        }

        if (provider !== 'ignore') {
            this.displaySuccess(`${provider} deployment configuration completed`);
        } else {
            this.displayInfo('Deployment configuration skipped');
        }

        return {
            provider,
            vercelToken,
        };
    }
}

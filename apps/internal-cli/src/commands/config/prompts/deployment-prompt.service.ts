import { Injectable } from '@nestjs/common';
import { BasePromptService } from '@packages/cli-shared';
import { DeployFacadeService } from '@ever-works/agent/facades';

export interface DeploymentConfig {
    provider: string | 'ignore';
    token?: string;
}

@Injectable()
export class DeploymentPromptService extends BasePromptService {
    constructor(private readonly deployFacade: DeployFacadeService) {
        super();
    }

    async promptDeploymentConfig(existingConfig?: any): Promise<DeploymentConfig> {
        this.displaySectionHeader('Deployment Provider Configuration');
        this.displayInfo('Configure your deployment provider (you can add more providers later)');

        // Build provider choices dynamically
        const providers = this.deployFacade.getAvailableProviders();
        const choices: { name: string; value: string }[] = providers.map((p) => ({
            name: p.name,
            value: p.id,
        }));
        choices.push({ name: 'Skip deployment configuration', value: 'ignore' });

        let defaultProvider = 'ignore';
        if (existingConfig?.DEPLOY_PROVIDER) {
            defaultProvider = existingConfig.DEPLOY_PROVIDER;
        } else if (existingConfig?.DEPLOY_TOKEN && providers.length > 0) {
            defaultProvider = providers[0].id;
        }

        const provider = await this.promptSelect(
            'Select a deployment provider:',
            choices,
            defaultProvider,
        );

        let token: string | undefined;

        if (provider !== 'ignore') {
            const providerInfo = providers.find((p) => p.id === provider);
            if (providerInfo?.homepage) {
                this.displayInfo(`You can get your token from: ${providerInfo.homepage}`);
            }

            while (true) {
                try {
                    token = await this.promptPassword('Enter your deployment token:');
                    token = token?.trim();

                    const validation = this.validateApiKeyWithProvider(token, 'deployment');
                    if (validation !== true) {
                        this.displayError(validation as string);
                        continue;
                    }

                    // Accept token without provider-specific validation during setup
                    // (no directoryId available). Validation happens in `config test` or deploy.
                    this.displaySuccess('Deployment token saved');
                    break;
                } catch (error) {
                    this.displayError('Failed to validate token. Please try again.');
                }
            }
        }

        if (provider !== 'ignore') {
            this.displaySuccess(`${provider} deployment configuration completed`);
        } else {
            this.displayInfo('Deployment configuration skipped');
        }

        return {
            provider,
            token,
        };
    }
}

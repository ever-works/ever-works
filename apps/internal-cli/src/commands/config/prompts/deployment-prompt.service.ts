import { Injectable } from '@nestjs/common';
import { BasePromptService } from '@packages/cli-shared';

export interface DeploymentConfig {
    provider: 'vercel' | 'ignore';
    token?: string;
}

@Injectable()
export class DeploymentPromptService extends BasePromptService {
    async promptDeploymentConfig(existingConfig?: any): Promise<DeploymentConfig> {
        this.displaySectionHeader('Deployment Provider Configuration');
        this.displayInfo('Configure your deployment provider (you can add more providers later)');

        let defaultProvider: 'vercel' | 'ignore' = 'ignore';
        if (existingConfig?.DEPLOY_TOKEN) {
            defaultProvider = 'vercel';
        }

        const provider = await this.promptSelect(
            'Select a deployment provider:',
            [
                { name: 'Vercel', value: 'vercel' as const },
                { name: 'Skip deployment configuration', value: 'ignore' as const },
            ],
            defaultProvider,
        );

        let token: string | undefined;

        if (provider === 'vercel') {
            this.displayInfo('You can get your token from: https://vercel.com/account/tokens');

            while (true) {
                try {
                    token = await this.promptPassword('Enter your deployment token:');
                    token = token?.trim();

                    const validation = this.validateApiKeyWithProvider(token, 'deployment');
                    if (validation !== true) {
                        this.displayError(validation as string);
                        continue;
                    }

                    this.displayInfo('Testing deployment token...');
                    const isValid = await this.testDeployToken(token);
                    if (!isValid) {
                        this.displayError('Token validation failed');
                        this.displayInfo(
                            'This could be due to network issues or API endpoint changes',
                        );

                        const action = await this.promptSelect('What would you like to do?', [
                            {
                                name: "Continue with this token (I know it's valid)",
                                value: 'continue',
                            },
                            { name: 'Re-enter the token', value: 'retry' },
                            { name: 'Skip deployment configuration', value: 'skip' },
                        ]);

                        if (action === 'skip') {
                            return { provider: 'ignore', token: undefined };
                        } else if (action === 'retry') {
                            continue;
                        }
                    }

                    this.displaySuccess('Deployment token validated successfully');
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

    private async testDeployToken(token: string): Promise<boolean> {
        try {
            const response = await fetch('https://api.vercel.com/v2/user', {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });

            if (response.ok) {
                return true;
            }

            const projectsResponse = await fetch('https://api.vercel.com/v9/projects', {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });

            return projectsResponse.ok;
        } catch (error) {
            return false;
        }
    }
}

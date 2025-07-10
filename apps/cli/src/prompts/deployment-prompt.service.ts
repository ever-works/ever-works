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

        const provider = await this.promptSelect('Select a deployment provider:', [
            { name: 'Vercel', value: 'vercel' as const },
            { name: 'Skip deployment configuration', value: 'ignore' as const },
        ]);

        let vercelToken: string | undefined;

        if (provider === 'vercel') {
            this.displayInfo(
                'You can get your Vercel token from: https://vercel.com/account/tokens',
            );

            while (true) {
                try {
                    vercelToken = await this.promptPassword('Enter your Vercel token:');

                    const validation = this.validateApiKey(vercelToken, 'Vercel');
                    if (validation !== true) {
                        this.displayError(validation as string);
                        continue;
                    }

                    // Test the Vercel token
                    this.displayInfo('Testing Vercel token...');
                    const isValid = await this.testVercelToken(vercelToken);
                    if (!isValid) {
                        this.displayError('Vercel token validation failed');
                        this.displayInfo(
                            'This could be due to network issues or API endpoint changes',
                        );

                        const action = await this.promptSelect('What would you like to do?', [
                            {
                                name: "Continue with this token (I know it's valid)",
                                value: 'continue',
                            },
                            { name: 'Re-enter the token', value: 'retry' },
                            { name: 'Skip Vercel configuration', value: 'skip' },
                        ]);

                        if (action === 'skip') {
                            return { provider: 'ignore', vercelToken: undefined };
                        } else if (action === 'retry') {
                            continue;
                        }
                        // If 'continue', we proceed with the token
                    }

                    this.displaySuccess('Vercel token validated successfully');
                    break;
                } catch (error) {
                    this.displayError('Failed to validate Vercel token. Please try again.');
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
            vercelToken,
        };
    }

    private async testVercelToken(token: string): Promise<boolean> {
        try {
            // Test with the Vercel user endpoint
            const response = await fetch('https://api.vercel.com/v2/user', {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });

            if (response.ok) {
                return true;
            }

            // Log the error for debugging
            const errorText = await response.text();
            console.error(`Vercel API error (${response.status}):`, errorText);

            // Try alternative endpoint - projects list (simpler endpoint)
            const projectsResponse = await fetch('https://api.vercel.com/v9/projects', {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });

            if (projectsResponse.ok) {
                return true;
            }

            const projectsError = await projectsResponse.text();
            console.error(`Vercel projects API error (${projectsResponse.status}):`, projectsError);

            return false;
        } catch (error) {
            console.error('Vercel token test network error:', error);
            return false;
        }
    }
}

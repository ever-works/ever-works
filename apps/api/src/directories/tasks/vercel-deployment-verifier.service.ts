import { Injectable, Logger } from '@nestjs/common';
import { DirectoryRepository } from '@packages/agent/database';
import { Directory } from '@packages/agent/entities';

type CancelVerification = () => void;

type GetProjectsReadyState =
    | 'BUILDING'
    | 'ERROR'
    | 'INITIALIZING'
    | 'QUEUED'
    | 'READY'
    | 'CANCELED'
    | 'TIMEOUT';

@Injectable()
export class VercelDeploymentVerifierService {
    private readonly logger = new Logger(VercelDeploymentVerifierService.name);
    private queue: Map<string, CancelVerification> = new Map();

    constructor(private readonly repository: DirectoryRepository) {}

    async startVerification(directory: Directory, vercelToken: string) {
        this.logger.log(`Starting verification for directory ${directory.id}`);

        this.cancelVerification(directory.id);

        this.queue.set(directory.id, await this.verifyDeployment(directory, vercelToken));
    }

    async validateToken(vercelToken: string) {
        const vercel = await this.createVercelSDK(vercelToken);
        try {
            await vercel.user.getAuthUser();
            return true;
        } catch (error) {
            return false;
        }
    }

    private cancelVerification(directoryId: string) {
        const cancelVerification = this.queue.get(directoryId);
        cancelVerification?.();
    }

    private async verifyDeployment(directory: Directory, vercelToken: string) {
        const vercel = await this.createVercelSDK(vercelToken);

        const FETCH_LIMIT = 18; // 2 minutes (POLL_INTERVAL * FETCH_LIMIT)
        const POLL_INTERVAL = 10 * 1000; // 10 seconds
        const TIMEOUT = 13 * 60 * 1000; // 12 minutes

        const startedAt = Date.now();
        const intervalId = { value: null as NodeJS.Timeout | null };

        // Record start time and update status
        this.repository.update(directory.id, {
            deploymentStartedAt: new Date(startedAt),
            deploymentState: 'INITIALIZING',
        });

        let getProjectTries = 0;
        let inVerification = false;

        const cleanup = (state?: GetProjectsReadyState) => {
            this.logger.log(
                `Cleaning up verification for directory ${directory.id} - ${state || 'UNKNOWN'}`,
            );

            if (intervalId.value) {
                clearInterval(intervalId.value);
            }
            this.queue.delete(directory.id);

            if (state) {
                this.repository.update(directory.id, {
                    deploymentState: state,
                });
            }
        };

        intervalId.value = setInterval(async () => {
            if (inVerification) {
                return;
            }

            inVerification = true;
            this.logger.log(`Checking deployment status for directory ${directory.id}`);

            try {
                const response = await vercel.projects.getProjects({
                    limit: '100',
                    search: directory.slug,
                });

                // Find the project
                const project = response.projects.find((p) => p.name.includes(directory.slug));
                if (!project) {
                    getProjectTries++;
                    if (getProjectTries > FETCH_LIMIT) {
                        cleanup('TIMEOUT');
                    }
                    return;
                }

                const projectDomains = await vercel.projects.getProjectDomains({
                    idOrName: project.id,
                });

                const customDomain =
                    projectDomains.domains.find((d) => !d.name.endsWith('.vercel.app')) ||
                    projectDomains.domains.find((d) => d.name.endsWith('.vercel.app'));

                // Find the deployment that was created after we started verification
                const latestDeployment = project.latestDeployments.find((d) => {
                    return d.createdAt > startedAt;
                });

                // Update directory with production domain
                if (customDomain?.name) {
                    await this.repository.update(directory.id, {
                        website: `https://${customDomain.name}`,
                    });
                }

                if (!latestDeployment) {
                    getProjectTries++;
                    if (getProjectTries > FETCH_LIMIT) {
                        cleanup('TIMEOUT');
                    }
                    return;
                }

                // Update directory with deployment url if no custom domain
                if (!customDomain?.name && latestDeployment?.url) {
                    await this.repository.update(directory.id, {
                        website: latestDeployment.url,
                    });
                }

                this.logger.log(
                    `Deployment for directory ${directory.id} is ${latestDeployment?.readyState}`,
                );

                if (['READY', 'ERROR', 'CANCELED'].includes(latestDeployment?.readyState)) {
                    cleanup(latestDeployment?.readyState);
                } else if (Date.now() - startedAt > TIMEOUT) {
                    cleanup('TIMEOUT');
                } else {
                    await this.repository.update(directory.id, {
                        deploymentState: latestDeployment?.readyState,
                    });
                }
            } catch (error) {
                this.logger.error(`Failed to get deployment for directory ${directory.id}:`, error);
                cleanup('ERROR');
            } finally {
                inVerification = false;
            }
        }, POLL_INTERVAL);

        return () => cleanup('CANCELED');
    }

    private async createVercelSDK(token: string) {
        const { Vercel } = await import('@vercel/sdk');

        return new Vercel({ bearerToken: token });
    }
}

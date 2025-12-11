import { Injectable, Logger } from '@nestjs/common';
import { DirectoryRepository } from '@packages/agent/database';
import { VercelService } from '@packages/agent/deploy';
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

    constructor(
        private readonly repository: DirectoryRepository,
        private readonly vercelService: VercelService,
    ) {}

    async startVerification(directory: Directory, vercelToken: string, vercelTeamScope?: string) {
        this.logger.log(`Starting verification for directory ${directory.id}`);

        this.cancelVerification(directory.id);

        this.queue.set(
            directory.id,
            await this.verifyDeployment(directory, vercelToken, vercelTeamScope),
        );
    }

    private cancelVerification(directoryId: string) {
        const cancelVerification = this.queue.get(directoryId);
        cancelVerification?.();
    }

    private async verifyDeployment(
        directory: Directory,
        vercelToken: string,
        vercelTeamScope?: string,
    ) {
        const vercel = await this.vercelService.createVercelSDK(vercelToken);

        const FETCH_LIMIT = 18; // 3 minutes (POLL_INTERVAL * FETCH_LIMIT)
        const POLL_INTERVAL = 10 * 1000; // 10 seconds
        const TIMEOUT = 13 * 60 * 1000; // 13 minutes

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
                    slug: vercelTeamScope,
                });

                // Find the project
                const project = response.projects.find((p) =>
                    p.name.includes(directory.getWebsiteRepo()),
                );
                if (!project) {
                    getProjectTries++;
                    if (getProjectTries > FETCH_LIMIT) {
                        cleanup('TIMEOUT');
                    }
                    return;
                }

                const projectDomains = await vercel.projects.getProjectDomains({
                    idOrName: project.id,
                    slug: vercelTeamScope,
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

    async lookupExistingDeployment(
        directory: Directory,
        vercelToken: string,
    ): Promise<{ found: boolean; website?: string; deploymentState?: GetProjectsReadyState }> {
        const vercel = await this.vercelService.createVercelSDK(vercelToken);

        try {
            const teamsResponse = await vercel.teams.getTeams({});
            const scopes = [
                undefined, // personal account
                ...(teamsResponse?.teams || []).map((t) => t?.slug).filter(Boolean),
            ];

            for (const scope of scopes) {
                const project = await this.findProject(vercel, directory, scope);
                if (!project) {
                    continue;
                }

                const { website, deploymentState } = await this.extractDeploymentData(
                    vercel,
                    project.id,
                    project.slug,
                );

                if (website || deploymentState) {
                    await this.repository.update(directory.id, {
                        website: website ?? undefined,
                        deploymentState: deploymentState ?? directory.deploymentState,
                    });
                }

                return {
                    found: true,
                    website,
                    deploymentState: deploymentState ?? null,
                };
            }

            return { found: false };
        } catch (error) {
            this.logger.error(
                `Failed to lookup existing deployment for directory ${directory.id}:`,
                error,
            );
            return { found: false };
        }
    }

    private async findProject(vercel: any, directory: Directory, teamScope?: string) {
        const projects = await vercel.projects.getProjects({
            limit: '100',
            search: directory.slug,
            slug: teamScope,
        });

        return projects.projects.find((p) => p.name.includes(directory.getWebsiteRepo())) || null;
    }

    private async extractDeploymentData(vercel: any, projectId: string, teamScope?: string) {
        const projectDomains = await vercel.projects.getProjectDomains({
            idOrName: projectId,
            slug: teamScope,
        });

        const customDomain =
            projectDomains.domains.find((d) => !d.name.endsWith('.vercel.app')) ||
            projectDomains.domains.find((d) => d.name.endsWith('.vercel.app'));

        const latestDeploymentResponse = await vercel.deployments.getDeployments({
            projectId,
            limit: 1,
            slug: teamScope,
        });

        const latestDeployment = latestDeploymentResponse.deployments?.[0];

        const website =
            customDomain?.name && customDomain.name.length > 0
                ? `https://${customDomain.name}`
                : latestDeployment?.url
                  ? `https://${latestDeployment.url}`
                  : undefined;

        return {
            website,
            deploymentState: latestDeployment?.readyState as GetProjectsReadyState | undefined,
        };
    }
}

import { Injectable, Logger } from '@nestjs/common';
import { DeployFacadeService } from '@ever-works/agent/facades';
import { WorkRepository } from '@ever-works/agent/database';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import { Work } from '@ever-works/agent/entities';
import type { IDeploymentPlugin } from '@ever-works/plugin';

type CancelVerification = () => void;

type DeploymentReadyState =
    | 'BUILDING'
    | 'ERROR'
    | 'INITIALIZING'
    | 'QUEUED'
    | 'READY'
    | 'CANCELED'
    | 'TIMEOUT';

/**
 * DeploymentVerifierService monitors deployment progress and updates work status.
 *
 * It uses the plugin system to check deployment status with the configured provider.
 */
@Injectable()
export class DeploymentVerifierService {
    private readonly logger = new Logger(DeploymentVerifierService.name);
    private queue: Map<string, CancelVerification> = new Map();

    constructor(
        private readonly repository: WorkRepository,
        private readonly deployFacade: DeployFacadeService,
        private readonly pluginRegistry: PluginRegistryService,
    ) {}

    /**
     * Start verification for a work deployment
     */
    async startVerification(work: Work, userId: string, teamScope?: string) {
        this.logger.log(`Starting verification for work ${work.id}`);

        this.cancelVerification(work.id);

        this.queue.set(work.id, await this.verifyDeployment(work, userId, teamScope));
    }

    private cancelVerification(workId: string) {
        const cancelVerification = this.queue.get(workId);
        cancelVerification?.();
    }

    private async verifyDeployment(
        work: Work,
        userId: string,
        teamScope?: string,
    ): Promise<CancelVerification> {
        const FETCH_LIMIT = 18; // 3 minutes (POLL_INTERVAL * FETCH_LIMIT)
        const POLL_INTERVAL = 10 * 1000; // 10 seconds
        const TIMEOUT = 13 * 60 * 1000; // 13 minutes

        const startedAt = Date.now();
        const intervalId = { value: null as NodeJS.Timeout | null };

        // Record start time and update status
        this.repository.update(work.id, {
            deploymentStartedAt: new Date(startedAt),
            deploymentState: 'INITIALIZING',
        });

        let fetchTries = 0;
        let inVerification = false;

        const cleanup = (state?: DeploymentReadyState) => {
            this.logger.log(
                `Cleaning up verification for work ${work.id} - ${state || 'UNKNOWN'}`,
            );

            if (intervalId.value) {
                clearInterval(intervalId.value);
            }
            this.queue.delete(work.id);

            if (state) {
                this.repository.update(work.id, {
                    deploymentState: state,
                });
            }
        };

        intervalId.value = setInterval(async () => {
            if (inVerification) {
                return;
            }

            inVerification = true;
            this.logger.log(`Checking deployment status for work ${work.id}`);

            try {
                // Use the plugin to lookup deployment
                const result = await this.deployFacade.lookupExistingDeployment(
                    work.getWebsiteRepo(),
                    {
                        userId,
                        workId: work.id,
                    },
                );

                if (!result.found) {
                    fetchTries++;
                    if (fetchTries > FETCH_LIMIT) {
                        cleanup('TIMEOUT');
                    }
                    return;
                }

                // Update website URL if found
                if (result.website) {
                    await this.repository.update(work.id, {
                        website: result.website,
                    });
                }

                // Check deployment state
                const state = result.deploymentState as DeploymentReadyState | undefined;

                this.logger.log(
                    `Deployment for work ${work.id} is ${state || 'UNKNOWN'}`,
                );

                if (state && ['READY', 'ERROR', 'CANCELED'].includes(state)) {
                    cleanup(state);
                } else if (Date.now() - startedAt > TIMEOUT) {
                    cleanup('TIMEOUT');
                } else if (state) {
                    await this.repository.update(work.id, {
                        deploymentState: state,
                    });
                }
            } catch (error) {
                this.logger.error(`Failed to get deployment for work ${work.id}:`, error);
                cleanup('ERROR');
            } finally {
                inVerification = false;
            }
        }, POLL_INTERVAL);

        return () => cleanup('CANCELED');
    }

    /**
     * Lookup existing deployment for a work
     */
    async lookupExistingDeployment(
        work: Work,
        userId: string,
    ): Promise<{
        found: boolean;
        website?: string;
        deploymentState?: string;
    }> {
        try {
            const result = await this.deployFacade.lookupExistingDeployment(
                work.getWebsiteRepo(),
                {
                    userId,
                    workId: work.id,
                },
            );

            if (result.found && (result.website || result.deploymentState)) {
                await this.repository.update(work.id, {
                    website: result.website ?? undefined,
                    deploymentState: result.deploymentState ?? work.deploymentState,
                });
            }

            return result;
        } catch (error) {
            this.logger.error(
                `Failed to lookup existing deployment for work ${work.id}:`,
                error,
            );
            return { found: false };
        }
    }
}

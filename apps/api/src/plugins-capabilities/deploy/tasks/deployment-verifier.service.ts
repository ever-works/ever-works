import { Injectable, Logger } from '@nestjs/common';
import { DeployFacadeService } from '@ever-works/agent/facades';
import { DirectoryRepository } from '@ever-works/agent/database';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import { Directory } from '@ever-works/agent/entities';
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
 * DeploymentVerifierService monitors deployment progress and updates directory status.
 *
 * It uses the plugin system to check deployment status with the configured provider.
 */
@Injectable()
export class DeploymentVerifierService {
    private readonly logger = new Logger(DeploymentVerifierService.name);
    private queue: Map<string, CancelVerification> = new Map();

    constructor(
        private readonly repository: DirectoryRepository,
        private readonly deployFacade: DeployFacadeService,
        private readonly pluginRegistry: PluginRegistryService,
    ) {}

    /**
     * Start verification for a directory deployment
     */
    async startVerification(directory: Directory, userId: string, teamScope?: string) {
        this.logger.log(`Starting verification for directory ${directory.id}`);

        this.cancelVerification(directory.id);

        this.queue.set(directory.id, await this.verifyDeployment(directory, userId, teamScope));
    }

    private cancelVerification(directoryId: string) {
        const cancelVerification = this.queue.get(directoryId);
        cancelVerification?.();
    }

    private async verifyDeployment(
        directory: Directory,
        userId: string,
        teamScope?: string,
    ): Promise<CancelVerification> {
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

        let fetchTries = 0;
        let inVerification = false;

        const cleanup = (state?: DeploymentReadyState) => {
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
                // Use the plugin to lookup deployment
                const result = await this.deployFacade.lookupExistingDeployment(
                    directory.getWebsiteRepo(),
                    {
                        userId,
                        directoryId: directory.id,
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
                    await this.repository.update(directory.id, {
                        website: result.website,
                    });
                }

                // Check deployment state
                const state = result.deploymentState as DeploymentReadyState | undefined;

                this.logger.log(
                    `Deployment for directory ${directory.id} is ${state || 'UNKNOWN'}`,
                );

                if (state && ['READY', 'ERROR', 'CANCELED'].includes(state)) {
                    cleanup(state);
                } else if (Date.now() - startedAt > TIMEOUT) {
                    cleanup('TIMEOUT');
                } else if (state) {
                    await this.repository.update(directory.id, {
                        deploymentState: state,
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

    /**
     * Lookup existing deployment for a directory
     */
    async lookupExistingDeployment(
        directory: Directory,
        userId: string,
    ): Promise<{
        found: boolean;
        website?: string;
        deploymentState?: string;
    }> {
        try {
            const result = await this.deployFacade.lookupExistingDeployment(
                directory.getWebsiteRepo(),
                {
                    userId,
                    directoryId: directory.id,
                },
            );

            if (result.found && (result.website || result.deploymentState)) {
                await this.repository.update(directory.id, {
                    website: result.website ?? undefined,
                    deploymentState: result.deploymentState ?? directory.deploymentState,
                });
            }

            return result;
        } catch (error) {
            this.logger.error(
                `Failed to lookup existing deployment for directory ${directory.id}:`,
                error,
            );
            return { found: false };
        }
    }
}

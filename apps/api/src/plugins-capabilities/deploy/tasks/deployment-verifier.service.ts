import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DeployFacadeService } from '@ever-works/agent/facades';
import { WorkRepository } from '@ever-works/agent/database';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import { Work } from '@ever-works/agent/entities';
import { DeploymentCompletedEvent, DeploymentFailedEvent } from '@ever-works/agent/events';
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
        private readonly eventEmitter: EventEmitter2,
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
        let lastWebsiteUrl: string | undefined;

        // Record start time and update status
        this.repository.update(work.id, {
            deploymentStartedAt: new Date(startedAt),
            deploymentState: 'INITIALIZING',
        });

        let fetchTries = 0;
        let inVerification = false;

        const cleanup = (state?: DeploymentReadyState, error?: string) => {
            this.logger.log(`Cleaning up verification for work ${work.id} - ${state || 'UNKNOWN'}`);

            if (intervalId.value) {
                clearInterval(intervalId.value);
            }
            this.queue.delete(work.id);

            if (state) {
                this.repository.update(work.id, {
                    deploymentState: state,
                });
                this.emitTerminalEvent(work, userId, state, lastWebsiteUrl, error);
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
                    lastWebsiteUrl = result.website;
                    await this.repository.update(work.id, {
                        website: result.website,
                    });
                }

                // Check deployment state
                const state = result.deploymentState as DeploymentReadyState | undefined;

                this.logger.log(`Deployment for work ${work.id} is ${state || 'UNKNOWN'}`);

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
                cleanup('ERROR', error instanceof Error ? error.message : String(error));
            } finally {
                inVerification = false;
            }
        }, POLL_INTERVAL);

        return () => cleanup('CANCELED');
    }

    /**
     * Emit a `DeploymentCompletedEvent` or `DeploymentFailedEvent` once
     * the verifier reaches a terminal state. The `ActivityLogListener` in
     * apps/api translates these into activity-log entries; downstream
     * consumers (Sentry breadcrumbs, metrics) can subscribe without
     * touching this service.
     *
     * Event emission is best-effort: if no plugin can be resolved (the
     * work was deleted, the deploy provider is gone) we just log and
     * move on — terminal cleanup must always succeed.
     */
    private emitTerminalEvent(
        work: Work,
        userId: string,
        state: DeploymentReadyState,
        url?: string,
        error?: string,
    ): void {
        const providerId = work.deployProvider;
        if (!providerId) return;

        const registered = this.pluginRegistry.get(providerId);
        const plugin = registered?.plugin as IDeploymentPlugin | undefined;
        const providerName = plugin?.providerName ?? plugin?.name ?? providerId;

        const payload = { work, userId, providerId, providerName };

        if (state === 'READY') {
            this.eventEmitter.emit(
                DeploymentCompletedEvent.EVENT_NAME,
                new DeploymentCompletedEvent({ ...payload, url }),
            );
        } else {
            this.eventEmitter.emit(
                DeploymentFailedEvent.EVENT_NAME,
                new DeploymentFailedEvent({
                    ...payload,
                    terminalState:
                        state === 'ERROR' || state === 'TIMEOUT' || state === 'CANCELED'
                            ? state
                            : 'UNKNOWN',
                    error,
                }),
            );
        }
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
            const result = await this.deployFacade.lookupExistingDeployment(work.getWebsiteRepo(), {
                userId,
                workId: work.id,
            });

            if (result.found && (result.website || result.deploymentState)) {
                await this.repository.update(work.id, {
                    website: result.website ?? undefined,
                    deploymentState: result.deploymentState ?? work.deploymentState,
                });
            }

            return result;
        } catch (error) {
            this.logger.error(`Failed to lookup existing deployment for work ${work.id}:`, error);
            return { found: false };
        }
    }
}

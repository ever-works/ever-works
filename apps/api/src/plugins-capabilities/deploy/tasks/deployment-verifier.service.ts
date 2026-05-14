import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DeployFacadeService } from '@ever-works/agent/facades';
import { WorkRepository, WorkDeploymentRepository } from '@ever-works/agent/database';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import { Work, DeploymentEnvironment } from '@ever-works/agent/entities';
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
        private readonly deploymentRepository: WorkDeploymentRepository,
        private readonly deployFacade: DeployFacadeService,
        private readonly pluginRegistry: PluginRegistryService,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    /**
     * Start verification for a work deployment.
     *
     * `deploymentId` references the WorkDeployment history row. When provided,
     * verification updates that row alongside Work.deploymentState (the latter
     * only when environment=production, preserving the EW-610 UI contract).
     */
    async startVerification(
        work: Work,
        userId: string,
        teamScope?: string,
        deploymentId?: string,
    ) {
        this.logger.log(`Starting verification for work ${work.id}`);

        this.cancelVerification(work.id);

        this.queue.set(
            work.id,
            await this.verifyDeployment(work, userId, teamScope, deploymentId),
        );
    }

    private cancelVerification(workId: string) {
        const cancelVerification = this.queue.get(workId);
        cancelVerification?.();
    }

    private async verifyDeployment(
        work: Work,
        userId: string,
        teamScope?: string,
        deploymentId?: string,
    ): Promise<CancelVerification> {
        const FETCH_LIMIT = 18; // 3 minutes (POLL_INTERVAL * FETCH_LIMIT)
        const POLL_INTERVAL = 10 * 1000; // 10 seconds
        const TIMEOUT = 13 * 60 * 1000; // 13 minutes

        const deployment = deploymentId
            ? await this.deploymentRepository.findById(deploymentId)
            : null;
        const isProduction =
            !deployment || deployment.environment === DeploymentEnvironment.PRODUCTION;

        const startedAt = Date.now();
        const intervalId = { value: null as NodeJS.Timeout | null };
        let lastWebsiteUrl: string | undefined;
        // Idempotency guard. `cleanup` can be reached more than once for
        // the same verification run — `startVerification()` invokes the
        // returned cancel closure while an in-flight poll callback is
        // still finishing, or the interval can resolve ERROR/TIMEOUT
        // moments before the external cancel fires. Without this flag,
        // each invocation re-emits a terminal event, producing
        // conflicting activity-log entries (e.g. `CANCELED` followed by
        // `READY`).
        let terminated = false;

        if (isProduction) {
            this.repository.update(work.id, {
                deploymentStartedAt: new Date(startedAt),
                deploymentState: 'INITIALIZING',
            });
        }

        let fetchTries = 0;
        let inVerification = false;

        const cleanup = (state?: DeploymentReadyState, error?: string) => {
            if (terminated) {
                this.logger.debug(
                    `Skipping duplicate cleanup for work ${work.id} (already terminal)`,
                );
                return;
            }
            if (state) {
                terminated = true;
            }

            this.logger.log(`Cleaning up verification for work ${work.id} - ${state || 'UNKNOWN'}`);

            if (intervalId.value) {
                clearInterval(intervalId.value);
                intervalId.value = null;
            }
            this.queue.delete(work.id);

            if (state) {
                if (isProduction) {
                    this.repository.update(work.id, { deploymentState: state });
                }
                if (deploymentId) {
                    this.deploymentRepository
                        .markTerminal(deploymentId, state, {
                            website: lastWebsiteUrl,
                            lastError: error,
                        })
                        .catch((err) =>
                            this.logger.warn(
                                `Failed to mark deployment ${deploymentId} terminal: ${err?.message}`,
                            ),
                        );
                }
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

                if (result.website) {
                    lastWebsiteUrl = result.website;
                    if (isProduction) {
                        await this.repository.update(work.id, { website: result.website });
                    }
                    if (deploymentId) {
                        await this.deploymentRepository.update(deploymentId, {
                            website: result.website,
                        });
                    }
                }

                const state = result.deploymentState as DeploymentReadyState | undefined;

                this.logger.log(`Deployment for work ${work.id} is ${state || 'UNKNOWN'}`);

                if (state && ['READY', 'ERROR', 'CANCELED'].includes(state)) {
                    cleanup(state);
                } else if (Date.now() - startedAt > TIMEOUT) {
                    cleanup('TIMEOUT');
                } else if (state) {
                    if (isProduction) {
                        await this.repository.update(work.id, { deploymentState: state });
                    }
                    if (deploymentId) {
                        await this.deploymentRepository.update(deploymentId, { state });
                    }
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

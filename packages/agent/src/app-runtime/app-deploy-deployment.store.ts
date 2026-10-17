import { Injectable, Logger, Optional } from '@nestjs/common';

import { WorkDeploymentRepository } from '../database/repositories/work-deployment.repository';
import type { WorkDeployment } from '../entities/work-deployment.entity';
import type {
    AppDeployDeploymentStore,
    AppDeployRowDraft,
    AppDeployRowFacts,
} from './app-deploy-request.service';

/**
 * APW-06 T16 — `APP_DEPLOY_DEPLOYMENT_STORE`, over the repository that already
 * owns `work_deployments`.
 *
 * ## Why an adapter and not `{ useExisting: WorkDeploymentRepository }`
 *
 * Three of the port's four members do not exist on the repository, and the one
 * that does means something slightly different:
 *
 *   - `create` must answer `{ id }` from a `AppDeployRowDraft`. The repository's
 *     `create` takes `Partial<WorkDeployment>` and answers the whole entity.
 *     Those are compatible by luck rather than by contract, and the draft
 *     carries `appRender` as a document this file is responsible for keeping
 *     **secret-free** — which is a decision, not a field copy;
 *   - `markSuperseded` must MERGE `supersededBy` into `appRender` rather than
 *     replace it (`tasks.md:1155`). A `useExisting` alias would have no member
 *     to do it with, and `update()` would overwrite the render facts of a row
 *     that is being replaced — losing the namespace and the spec commit of the
 *     Deployment whose place was taken;
 *   - `markDispatchFailed` is the other half of "propagates dispatch errors (the
 *     row would strand)". Without it a row created moments before a dispatch
 *     failure sits at `INITIALIZING` forever, holding the deploy lock until it
 *     goes stale 7 260 s later.
 *
 * ## `findById` narrows, and that is the point
 *
 * The queue decision reads five fields. Handing the service the whole entity
 * would let a later change start reading `website`, `lastError` or a relation
 * off a row it only holds to decide "is this the same Build queued twice?".
 *
 * ## Every method resolves
 *
 * The three optional members are best-effort by contract: a failed supersede or
 * a failed dispatch-failure write must not turn an answered request into a 500,
 * because by then the caller already has a `deploymentId` and a status to
 * return. They log and resolve. `create` is the exception — a row that was not
 * created is not a Deployment, and the service's own guard reports it.
 */
@Injectable()
export class AppDeployDeploymentStoreAdapter implements AppDeployDeploymentStore {
    private readonly logger = new Logger(AppDeployDeploymentStoreAdapter.name);

    constructor(
        // `@Optional()` for the same reason every collaborator on this path is:
        // the module graph must compile in a worker context that has no
        // DataSource, and an absent repository is a named refusal rather than a
        // boot failure.
        @Optional() private readonly deployments?: WorkDeploymentRepository,
    ) {}

    /**
     * §2.2 step 4 — insert the row.
     *
     * `triggerSource` is the pre-existing two-value enum every Work kind uses and
     * `appTrigger` is FR-23's own source; both are written, and the draft decides
     * each. `startedAt` is left to the repository, which stamps it.
     */
    async create(draft: AppDeployRowDraft): Promise<{ id: string }> {
        if (!this.deployments) {
            throw new Error(
                'App Deployment store unavailable: no WorkDeploymentRepository is bound, so the ' +
                    'Deployment row cannot be created.',
            );
        }

        const row: Partial<WorkDeployment> = {
            id: draft.id,
            workId: draft.workId,
            state: draft.state,
            provider: draft.provider,
            triggerSource: draft.triggerSource as WorkDeployment['triggerSource'],
            appTrigger: draft.appTrigger,
            buildId: draft.buildId,
            appTarget: draft.appTarget,
            appRender: draft.appRender,
        };
        if (draft.commitSha) row.commitSha = draft.commitSha;
        if (draft.branch) row.branch = draft.branch;
        if (draft.triggeredByUserId) row.triggeredByUserId = draft.triggeredByUserId;

        const created = await this.deployments.create(row);
        // The draft mints its own id so the row and the deploy lock it claims
        // carry one identity (§2.2 steps 3–4). Answering the STORED id anyway,
        // because a repository that ignored the id we passed must not be
        // papered over by echoing what we sent.
        return { id: created.id };
    }

    /** The five fields the queue decision reads — see the class docstring. */
    async findById(deploymentId: string): Promise<AppDeployRowFacts | null> {
        if (!this.deployments) return null;

        const row = await this.deployments.findById(deploymentId);
        if (!row) return null;

        return {
            id: row.id,
            state: row.state ?? null,
            buildId: row.buildId ?? null,
            commitSha: row.commitSha ?? null,
            appTrigger: row.appTrigger ?? null,
        };
    }

    /**
     * `tasks.md:1155` — mark the replaced row `SUPERSEDED`, MERGING
     * `supersededBy` into `appRender`.
     *
     * The merge is read-then-write rather than a JSON operator: `appRender` is
     * `simple-json` (text on every driver — see the migration's header), so
     * there is no in-database merge to use, and the two Deployments involved are
     * serialised by the deploy lock, so there is no concurrent writer to lose a
     * field to.
     */
    /**
     * APW-06 T71 (A0.7, 2026-10-17) — the orchestrator's wider view of this token
     * (`AppDeployOrchestratorDeploymentStore.update`, §5.6 steps 4–7): one patch of the
     * Deployment row per phase. Without it the worker's `patchDeployment` was a no-op, so a
     * Deployment stayed `QUEUED` whatever the cluster did.
     *
     * `appRender` is MERGED onto the stored bag (each phase adds a key; the request's own
     * `preconditions`/`specCommitSha` facts must survive), timestamps arrive as ISO strings over
     * the internal channel and are stored as dates, and a `READY` row records its primary URL in
     * `website` — the column the Deploy tab already shows.
     */
    async update(
        workId: string,
        deploymentId: string,
        patch: {
            state?: string | null;
            startedAt?: Date | string | null;
            completedAt?: Date | string | null;
            lastError?: string | null;
            componentStatuses?: unknown;
            smokeResult?: unknown;
            appRender?: Record<string, unknown>;
        },
    ): Promise<void> {
        if (!this.deployments) {
            throw new Error(
                'App Deployment store unavailable: no WorkDeploymentRepository is bound, so the ' +
                    'Deployment row cannot be updated.',
            );
        }

        const fields: Partial<WorkDeployment> = {};
        if (patch?.state) fields.state = String(patch.state);
        const startedAt = toDate(patch?.startedAt);
        if (startedAt) fields.startedAt = startedAt;
        const completedAt = toDate(patch?.completedAt);
        if (completedAt) fields.completedAt = completedAt;
        if (patch && 'lastError' in patch) fields.lastError = patch.lastError ?? null;
        if (patch && 'componentStatuses' in patch) {
            fields.componentStatuses = Array.isArray(patch.componentStatuses)
                ? (patch.componentStatuses as Record<string, unknown>[])
                : null;
        }
        if (patch && 'smokeResult' in patch) {
            fields.smokeResult =
                patch.smokeResult && typeof patch.smokeResult === 'object'
                    ? (patch.smokeResult as Record<string, unknown>)
                    : null;
        }

        if (patch?.appRender && typeof patch.appRender === 'object') {
            const row = await this.deployments.findById(deploymentId);
            if (row && row.workId && workId && row.workId !== workId) {
                throw new Error(
                    `Deployment ${deploymentId} does not belong to Work ${workId}; not updated.`,
                );
            }
            fields.appRender = { ...(row?.appRender ?? {}), ...patch.appRender };

            const hosts = (patch.appRender as { hosts?: { primary?: unknown } }).hosts;
            const primary = typeof hosts?.primary === 'string' ? hosts.primary.trim() : '';
            if (fields.state === 'READY' && primary) fields.website = `https://${primary}`;
        }

        if (Object.keys(fields).length === 0) return;
        await this.deployments.update(deploymentId, fields);
    }

    async markSuperseded(deploymentId: string, supersededBy: string): Promise<void> {
        if (!this.deployments) return;

        try {
            const row = await this.deployments.findById(deploymentId);
            if (!row) return;

            await this.deployments.update(deploymentId, {
                state: 'SUPERSEDED',
                completedAt: new Date(),
                appRender: { ...(row.appRender ?? {}), supersededBy },
            });
        } catch (error) {
            // Best effort by contract: the caller already has an answer for the
            // member, and a superseded row that kept its state is visibly wrong
            // rather than silently lost.
            this.logger.warn(
                `Could not mark Deployment ${deploymentId} superseded by ${supersededBy}: ` +
                    (error instanceof Error ? error.message : String(error)),
            );
        }
    }

    /**
     * The other half of "propagates dispatch errors (the row would strand)".
     *
     * `ERROR` with the code in `lastError`, so the Deploy tab says what happened
     * rather than showing a Deployment that has been initialising for two hours.
     * The message is the dispatcher's own and never carries a value: it is a
     * refusal code and a sentence, which is all `dispatchAppDeploy` produces.
     */
    async markDispatchFailed(deploymentId: string, code: string, message: string): Promise<void> {
        if (!this.deployments) return;

        try {
            await this.deployments.markTerminal(deploymentId, 'ERROR', {
                lastError: `${code}: ${message}`,
            });
        } catch (error) {
            this.logger.warn(
                `Could not mark Deployment ${deploymentId} dispatch-failed (${code}): ` +
                    (error instanceof Error ? error.message : String(error)),
            );
        }
    }
}

function toDate(value: Date | string | null | undefined): Date | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date;
}

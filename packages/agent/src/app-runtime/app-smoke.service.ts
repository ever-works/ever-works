/**
 * APW-06 T70 — **`AppSmokeService`**: the `app-smoke` job's body, plan §5.7 (`plan.md:856-864`) and
 * §9.10's closing paragraph (`plan.md:1597-1599`).
 *
 * > **`app-smoke`** loads the current Deployment, runs in-cluster smoke through `runAppJob` with
 * > `AppJobRunRequest { runner: 'smoke', checks }`, then public smoke through
 * > `AppPublicSmokeService`, writes `smokeResult` on that Deployment and emits
 * > `app.smoke.passed|failed`. **It never rolls back.**
 *
 * ## Why it is its own service rather than a branch of the orchestrator
 *
 * §5.7 says the same services are called **in-process** inside `app-deploy` "so a failure can roll
 * back within one job" — and that is T25's path (`AppDeployOrchestrator.run`). This service is the
 * *on-demand* one behind FR-36/FR-37's **Run smoke tests** and APW-04's verification loop: it runs
 * **after** a Deployment is live, on a Work that is already serving, so there is nothing to roll
 * back to and it must not touch a workload. It shares T23's `AppPublicSmokeService` with the
 * orchestrator rather than re-implementing the window, the classifications or the retry cadence.
 *
 * ## The four things it writes, and the one it does not
 *
 * - `work_deployments.smokeResult` (§7.1) — the two halves and the instant they were observed, so
 *   the Deploy tab and the events read one shape.
 * - `app.smoke.passed` | `app.smoke.failed` through T28's sink, with **names only** (Constitution
 *   VII; §9.4:1306-1307's payload).
 * - nothing else. No runtime-state write, no Activity row of its own, no `deployApp`, no
 *   `scaleApp`, no rollback.
 *
 * ## The live image and the checks
 *
 * The in-cluster half needs the **live** image and the App spec's smoke checks. Both come from the
 * same places the rest of the runtime reads them: the image from the current Deployment's recorded
 * `appRender.image.reference` (§5.8), the checks from T22's spec read through T60's token — the same
 * one read `app-lifecycle-ops.service.ts` documents in its header. A Deployment with no recorded
 * image is refused (`image_unavailable`) rather than run with a guessed tag.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
    AppJobResult,
    AppJobRunRequest,
    AppSmokeInput,
    CheckResult,
} from '@ever-works/plugin';

import {
    AppRuntimeFacadeService,
    type AppRuntimeAccessResult,
    type AppRuntimeClusterAccess,
} from '../facades/app-runtime.facade';
import { WorkDeploymentRepository } from '../database/repositories/work-deployment.repository';
import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';
import { AppHostsService, appHostUrl } from './app-hosts.service';
import {
    AppPublicSmokeService,
    publicSmokeWindowSeconds,
    type AppPublicSmokeRun,
} from './app-public-smoke.service';
import { APP_RUNTIME_EVENT_SINK, type AppRuntimeEventSink } from './ports';
import {
    APP_VERIFICATION_SPEC_SOURCE,
    type AppVerificationSpec,
    type AppVerificationSpecRequest,
    type AppVerificationSpecSource,
} from './app-verification-target.service';
import { bindMember } from './app-lifecycle-ops.service';

/* -------------------------------------------------------------------------- *
 * Vocabulary
 * -------------------------------------------------------------------------- */

/** The `runAppJob` name an on-demand smoke run carries (§5.7's `runner: 'smoke'`). */
export const APP_SMOKE_RUNNER_JOB_NAME = 'smoke' as const;

/** The environment a "current Deployment" is the latest of (§7.1's `environment` column). */
export const APP_SMOKE_DEPLOYMENT_ENVIRONMENT = 'production' as const;

/** No Deployment row could be loaded, so there is nothing to smoke-test. */
export const APP_SMOKE_CODE_DEPLOYMENT_NOT_FOUND = 'deployment_not_found' as const;

/** No plugin and credential could be assembled for this Work (T20's own refusal codes). */
export const APP_SMOKE_CODE_FACADE_UNAVAILABLE = 'facade_unavailable' as const;

/** The resolved plugin does not implement the member this half needs. */
export const APP_SMOKE_CODE_UNSUPPORTED_ON_TARGET = 'op_unsupported_on_target' as const;

/** The App spec could not be read, so the checks and the image are unknowable. */
export const APP_SMOKE_CODE_SPEC_UNAVAILABLE = 'spec_unavailable' as const;

/** The Deployment recorded no image, so no Job can be rendered for the live version. */
export const APP_SMOKE_CODE_IMAGE_UNAVAILABLE = 'image_unavailable' as const;

/** R-15 — a smoke run against a deleting App Work is refused. */
export const APP_SMOKE_CODE_APP_WORK_DELETING = 'app_work_deleting' as const;

/** The public address could not be resolved, so the public half cannot run. */
export const APP_SMOKE_CODE_PUBLIC_URL_UNAVAILABLE = 'public_url_unavailable' as const;

/* -------------------------------------------------------------------------- *
 * Request and result
 * -------------------------------------------------------------------------- */

/** What the `app-smoke` task carries (§9.2:1246): ids only, never a value. */
export interface AppSmokeRequest {
    workId: string;
    deploymentId?: string | null;
    /** `manual` · `deploy` · `health-poll` … — reported, never branched on. */
    trigger?: string | null;
    userId?: string | null;
}

/** The `work_deployments.smokeResult` value this service writes (§7.1). */
export interface AppSmokeRecord {
    inCluster: CheckResult[];
    public: CheckResult[];
    observedAt: string;
}

/** What one smoke run reports. */
export interface AppSmokeRunResult {
    /** `done` — the run completed (passed **or** failed, which is `passed` below); `refused` — it never ran. */
    state: 'done' | 'refused';
    /** A named reason for anything that is not a plain run. */
    code: string | null;
    workId: string;
    deploymentId: string | null;
    /** `true` ⇔ both halves passed. A failed smoke run is still a completed run. */
    passed: boolean;
    record: AppSmokeRecord | null;
    /** T23's own verdict, reported rather than re-derived. */
    publicOutcome: AppPublicSmokeRun['outcome'] | null;
    /** FR-47's input: `true` ⇔ at least one health-relevant public failure. */
    healthRelevant: boolean;
    smokeResultWritten: 'written' | 'unbound' | 'failed';
    events: 'emitted' | 'unbound' | 'failed';
    detail: Record<string, unknown> | null;
}

/* -------------------------------------------------------------------------- *
 * Provisional seams — every one of them is another owner's
 * -------------------------------------------------------------------------- */

// ── provisional — APW-06 T16, the Deployment row ─────────────────────────────
//
// `WorkDeploymentRepository` **does** exist (`packages/agent/src/database/repositories/
// work-deployment.repository.ts`), and the worker provides it as a proxy (it is a `remoteMap`
// entry), so this file injects the class itself rather than declaring a token for it. The view
// below is the narrow reading §5.7 needs: the row, and the one column it writes.

/** One `work_deployments` row as a smoke run reads and writes it (§7.1). */
export interface AppSmokeDeploymentView {
    id: string;
    workId?: string | null;
    state?: string | null;
    buildId?: string | null;
    /** The Build's commit, or the spec commit under `build.strategy: image` (§5.8). */
    commitSha?: string | null;
    appRender?: Record<string, unknown> | null;
    smokeResult?: unknown;
}

/** The repository methods this service calls, at the signatures the repository really has. */
export interface AppSmokeDeploymentStore {
    findById?(deploymentId: string): Promise<AppSmokeDeploymentView | null>;
    findLatest?(workId: string, environment: string): Promise<AppSmokeDeploymentView | null>;
    /** `work-deployment.repository.ts:132` — `update(id, fields)`. */
    update?(deploymentId: string, fields: { smokeResult?: unknown }): Promise<unknown> | void;
}

/** The runtime-state row, as the R-15 guard reads it (T17's, through T58's token). */
export interface AppSmokeStateView {
    deletionRequestedAt?: Date | string | number | null;
    namespace?: string | null;
}

/** T17's `WorkAppRuntimeStateRepository`, as this service consumes it. */
export interface AppSmokeStateStore {
    getOrCreate?(workId: string): Promise<AppSmokeStateView | null | undefined>;
}

// ── provisional — APW-06 T17, the runtime-state token ────────────────────────
//
// Imported, never redeclared. See `app-lifecycle-ops.service.ts` for the rule.

/* -------------------------------------------------------------------------- *
 * The service
 * -------------------------------------------------------------------------- */

/** A trimmed string, or `''`. */
function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** `error.message` when there is one, `String(error)` otherwise, one line and bounded. */
function messageOf(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return String(message || 'unknown error')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
}

/** A method that is present and callable on an `@Optional()` collaborator. */
function hasMember<T>(holder: unknown, name: string): holder is Record<string, T> {
    return !!holder && typeof (holder as Record<string, unknown>)[name] === 'function';
}

/**
 * The two halves of §5.7's run: in-cluster through the plugin's own runner, then the public check
 * through T23's classifier.
 */
@Injectable()
export class AppSmokeService {
    private readonly logger = new Logger(AppSmokeService.name);

    constructor(
        @Optional()
        @Inject(AppRuntimeFacadeService)
        private readonly facade?: AppSmokeAccessResolver,
        @Optional()
        @Inject(WorkDeploymentRepository)
        private readonly deployments?: AppSmokeDeploymentStore,
        @Optional()
        private readonly publicSmoke?: AppPublicSmokeService,
        @Optional()
        @Inject(AppHostsService)
        private readonly hosts?: AppSmokeHostSource,
        @Optional()
        @Inject(APP_VERIFICATION_SPEC_SOURCE)
        private readonly specs?: AppVerificationSpecSource,
        @Optional()
        @Inject(APP_RUNTIME_EVENT_SINK)
        private readonly events?: AppRuntimeEventSink,
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly states?: AppSmokeStateStore,
    ) {}

    /**
     * One smoke run, in §5.7's order.
     *
     * Never throws and **never rolls back**: every failure is a named `code`, and a run that
     * completed with a red check is `state: 'done'` with `passed: false` — which is the whole point
     * of an on-demand smoke run on a live app.
     */
    async run(request: AppSmokeRequest): Promise<AppSmokeRunResult> {
        const workId = text(request?.workId);
        const requestedId = text(request?.deploymentId) || null;

        if (!workId) {
            return this.refuse(null, APP_SMOKE_CODE_DEPLOYMENT_NOT_FOUND, workId, requestedId, {
                reason: 'no workId was carried',
            });
        }

        // ── R-15 — nothing is dialled for an App Work that is being deleted ────────────────
        const state = await this.readState(workId);
        if (state?.deletionRequestedAt) {
            return this.refuse(null, APP_SMOKE_CODE_APP_WORK_DELETING, workId, requestedId, {
                deletionRequestedAt: String(state.deletionRequestedAt),
            });
        }

        // ── 1 · the current Deployment ─────────────────────────────────────────────────────
        const deployment = await this.loadDeployment(workId, requestedId);
        if (!deployment?.id) {
            return this.refuse(null, APP_SMOKE_CODE_DEPLOYMENT_NOT_FOUND, workId, requestedId, {
                requested: requestedId,
            });
        }
        const deploymentId = text(deployment.id);

        // ── 2 · the plugin and the credential (R-5) ────────────────────────────────────────
        const access = await this.access(workId);
        if (access.refusal) {
            return this.refuse(null, access.refusal, workId, deploymentId, access.detail);
        }

        const image = this.liveImage(deployment);
        if (!image) {
            return this.refuse(null, APP_SMOKE_CODE_IMAGE_UNAVAILABLE, workId, deploymentId, {
                member: 'runAppJob',
            });
        }

        const spec = await this.readSpec(workId, access.access, state, deployment);
        if (!spec) {
            return this.refuse(null, APP_SMOKE_CODE_SPEC_UNAVAILABLE, workId, deploymentId, {
                member: 'readVerificationSpec',
            });
        }

        const checks = smokeChecksOf(spec);
        const runAppJob = access.access.runAppJob;
        if (typeof runAppJob !== 'function') {
            return this.refuse(null, APP_SMOKE_CODE_UNSUPPORTED_ON_TARGET, workId, deploymentId, {
                member: 'runAppJob',
            });
        }

        // ── 3 · the in-cluster half ────────────────────────────────────────────────────────
        let job: AppJobResult | null = null;
        let inCluster: CheckResult[] = [];
        try {
            const jobRequest: AppJobRunRequest = {
                name: APP_SMOKE_RUNNER_JOB_NAME,
                image,
                runner: 'smoke',
                checks,
            };
            job = await runAppJob(access.access.ref, access.access.credential, jobRequest);
            inCluster = checkResultsOf(job, checks);
        } catch (error) {
            this.logger.warn(
                `The in-cluster smoke run for work ${workId} failed: ${messageOf(error)}`,
            );
            // A refused runner is a red check, not a thrown run: FR-36's report is the point.
            inCluster = [
                {
                    name: APP_SMOKE_RUNNER_JOB_NAME,
                    status: 'failed',
                    classification: 'unreachable',
                    found: messageOf(error),
                },
            ];
        }

        // ── 4 · the public half (T23's service, the same one §5.6 uses) ────────────────────
        const urls = await this.publicUrls(workId, state);
        if (urls.length === 0) {
            return this.refuse(null, APP_SMOKE_CODE_PUBLIC_URL_UNAVAILABLE, workId, deploymentId, {
                member: 'resolveHosts',
            });
        }

        let publicRun: AppPublicSmokeRun | null = null;
        try {
            publicRun = await this.runPublicSmoke({
                workId,
                urls,
                checks,
                inCluster,
            });
        } catch (error) {
            this.logger.warn(`The public smoke run for work ${workId} failed: ${messageOf(error)}`);
            publicRun = null;
        }

        // ── 5 · the record, the events, and nothing else ───────────────────────────────────
        const observedAt = new Date().toISOString();
        const record: AppSmokeRecord = {
            inCluster,
            public: [...(publicRun?.checks ?? [])],
            observedAt,
        };
        const passed =
            inCluster.every((check) => check.status !== 'failed') && publicRun?.passed === true;

        const written = await this.writeSmokeResult(deploymentId, record);
        const events = await this.emit(passed ? 'app.smoke.passed' : 'app.smoke.failed', {
            workId,
            userId: text(request?.userId) || null,
            deploymentId,
            target: access.access.target,
            names: [
                ...record.inCluster.map((check) => String(check.name ?? '')),
                ...record.public.map((check) => String(check.name ?? '')),
            ].filter(Boolean),
        });

        return {
            state: 'done',
            code: passed ? null : 'smoke_failed',
            workId,
            deploymentId,
            passed,
            record,
            publicOutcome: publicRun?.outcome ?? null,
            healthRelevant: publicRun?.healthRelevant === true,
            smokeResultWritten: written,
            events,
            detail: {
                trigger: text(request?.trigger) || null,
                checks: checks.length,
                inCluster: record.inCluster.length,
                public: record.public.length,
                attempts: publicRun?.attempts ?? 0,
                windowSeconds: publicRun?.windowSeconds ?? 0,
                jobStatus: text(job?.status) || null,
            },
        };
    }

    /* ---------------------------------------------------------------------- *
     * The reads
     * ---------------------------------------------------------------------- */

    private async loadDeployment(
        workId: string,
        deploymentId: string | null,
    ): Promise<AppSmokeDeploymentView | null> {
        const store = this.deployments;
        try {
            if (deploymentId) {
                if (!hasMember<AppSmokeDeploymentStore['findById']>(store, 'findById')) {
                    return null;
                }
                const row = await store.findById(deploymentId);
                // A row that belongs to another Work is not this Work's current Deployment.
                if (row && text(row.workId) && text(row.workId) !== workId) {
                    return null;
                }
                return row ?? null;
            }

            if (!hasMember<AppSmokeDeploymentStore['findLatest']>(store, 'findLatest')) {
                return null;
            }
            return (await store.findLatest(workId, APP_SMOKE_DEPLOYMENT_ENVIRONMENT)) ?? null;
        } catch (error) {
            this.logger.warn(
                `The Deployment for work ${workId} could not be read: ${messageOf(error)}`,
            );
            return null;
        }
    }

    private async readState(workId: string): Promise<AppSmokeStateView | null> {
        if (!hasMember<AppSmokeStateStore['getOrCreate']>(this.states, 'getOrCreate')) {
            return null;
        }
        try {
            return (await this.states.getOrCreate(workId)) ?? null;
        } catch (error) {
            // The row is the R-15 guard's only source. An unreadable row is not a licence to run:
            // it is reported and the caller sees a refusal from the guard that needs it.
            this.logger.warn(
                `The runtime state for work ${workId} could not be read: ${messageOf(error)}`,
            );
            return null;
        }
    }

    private async access(workId: string): Promise<{
        refusal: string | null;
        detail: Record<string, unknown> | null;
        access: AppSmokeAccess;
    }> {
        if (
            !hasMember<AppSmokeAccessResolver['resolveClusterAccess']>(
                this.facade,
                'resolveClusterAccess',
            )
        ) {
            return {
                refusal: APP_SMOKE_CODE_FACADE_UNAVAILABLE,
                detail: { member: 'resolveClusterAccess' },
                access: null as unknown as AppSmokeAccess,
            };
        }

        let resolved: AppRuntimeAccessResult;
        try {
            resolved = await this.facade.resolveClusterAccess(workId);
        } catch (error) {
            return {
                refusal: APP_SMOKE_CODE_FACADE_UNAVAILABLE,
                detail: { message: messageOf(error) },
                access: null as unknown as AppSmokeAccess,
            };
        }

        if (resolved?.outcome === 'refused') {
            return {
                refusal: text(resolved.refusal) || APP_SMOKE_CODE_FACADE_UNAVAILABLE,
                detail: { facade: 'refused' },
                access: null as unknown as AppSmokeAccess,
            };
        }

        const cluster = resolved?.access as AppRuntimeClusterAccess;
        if (!cluster?.ref) {
            return {
                refusal: APP_SMOKE_CODE_FACADE_UNAVAILABLE,
                detail: { facade: 'no access' },
                access: null as unknown as AppSmokeAccess,
            };
        }

        return {
            refusal: null,
            detail: null,
            access: {
                target: cluster.target,
                ref: cluster.ref,
                credential: cluster.credential,
                runAppJob: bindMember<
                    (
                        ref: AppSmokeAccess['ref'],
                        credential: string,
                        job: AppJobRunRequest,
                    ) => Promise<AppJobResult>
                >(cluster.plugin, 'runAppJob'),
            },
        };
    }

    /** The live spec, through the one spec read the worker binds — see the lifecycle service's header. */
    private async readSpec(
        workId: string,
        access: AppSmokeAccess,
        state: AppSmokeStateView | null,
        deployment: AppSmokeDeploymentView,
    ): Promise<AppVerificationSpec | null> {
        if (
            !hasMember<AppVerificationSpecSource['readVerificationSpec']>(
                this.specs,
                'readVerificationSpec',
            )
        ) {
            return null;
        }

        const namespace = text(state?.namespace) || text(access.ref?.namespace);
        if (!namespace) {
            return null;
        }

        const request: AppVerificationSpecRequest = {
            workId,
            namespace,
            provisioningId: text(deployment.id) || workId,
            attempt: 1,
            specCommitSha: text(deployment.commitSha) || null,
            buildId: text(deployment.buildId) || null,
            imageDigest: null,
            ttlMinutes: 1,
        };

        try {
            const spec = await this.specs.readVerificationSpec(request);
            return spec?.input ? spec : null;
        } catch (error) {
            this.logger.warn(
                `The App spec for work ${workId} could not be read: ${messageOf(error)}`,
            );
            return null;
        }
    }

    /** The public URLs, primary first — §4.11's published address, or a derived one. */
    private async publicUrls(workId: string, state: AppSmokeStateView | null): Promise<string[]> {
        if (hasMember<AppSmokeHostSource['resolveHosts']>(this.hosts, 'resolveHosts')) {
            try {
                const hosts = await this.hosts.resolveHosts(workId);
                const primary =
                    text(hosts?.primaryUrl) ||
                    appHostUrl(text(hosts?.primary) || null, null, 'managed');
                if (primary) {
                    return [primary];
                }
            } catch (error) {
                this.logger.warn(
                    `The published hosts for work ${workId} could not be read: ${messageOf(error)}`,
                );
            }
        }

        const address = (
            state as unknown as { ingressAddress?: { ip?: string; hostname?: string } } | null
        )?.ingressAddress;
        const derived = appHostUrl(
            text(address?.hostname) || text(address?.ip) || null,
            null,
            'managed',
        );

        return derived ? [derived] : [];
    }

    /** The public half, through T23's service and its own window/classification rules. */
    private async runPublicSmoke(input: {
        workId: string;
        urls: string[];
        checks: AppSmokeInput[];
        inCluster: CheckResult[];
    }): Promise<AppPublicSmokeRun | null> {
        if (!hasMember<AppPublicSmokeService['run']>(this.publicSmoke, 'run')) {
            return null;
        }

        return this.publicSmoke.run({
            workId: input.workId,
            urls: input.urls,
            checks: input.checks,
            windowSeconds: publicSmokeWindowSeconds(false),
            isFirstDeploymentOnCluster: false,
            inCluster: input.inCluster,
        });
    }

    /* ---------------------------------------------------------------------- *
     * The two writes
     * ---------------------------------------------------------------------- */

    private async writeSmokeResult(
        deploymentId: string,
        record: AppSmokeRecord,
    ): Promise<'written' | 'unbound' | 'failed'> {
        if (!hasMember<AppSmokeDeploymentStore['update']>(this.deployments, 'update')) {
            return 'unbound';
        }
        try {
            await this.deployments.update(deploymentId, { smokeResult: record });
            return 'written';
        } catch (error) {
            this.logger.warn(
                `The smoke result for deployment ${deploymentId} could not be written: ${messageOf(error)}`,
            );
            return 'failed';
        }
    }

    private async emit(
        name: string,
        payload: Record<string, unknown>,
    ): Promise<'emitted' | 'unbound' | 'failed'> {
        if (!hasMember<AppRuntimeEventSink['emit']>(this.events, 'emit')) {
            return 'unbound';
        }
        try {
            await this.events.emit({ name, payload });
            return 'emitted';
        } catch (error) {
            this.logger.warn(`The ${name} event could not be emitted: ${messageOf(error)}`);
            return 'failed';
        }
    }

    /** The live image: T72's recorded reference, or the row's own recorded render facts (§5.8). */
    private liveImage(deployment: AppSmokeDeploymentView): string | null {
        const image = deployment?.appRender?.image as { reference?: unknown } | undefined;
        return text(image?.reference) || null;
    }

    private refuse(
        record: AppSmokeRecord | null,
        code: string,
        workId: string,
        deploymentId: string | null,
        detail: Record<string, unknown> | null,
    ): AppSmokeRunResult {
        return {
            state: 'refused',
            code,
            workId,
            deploymentId,
            passed: false,
            record,
            publicOutcome: null,
            healthRelevant: false,
            smokeResultWritten: 'unbound',
            events: 'unbound',
            detail,
        };
    }
}

/* -------------------------------------------------------------------------- *
 * Shapes and pure helpers
 * -------------------------------------------------------------------------- */

/** The plugin member §5.7's in-cluster half calls, already bound to the resolved plugin (R-5). */
export interface AppSmokeAccess {
    target: 'your-cluster' | 'ever-works-apps';
    ref: AppRuntimeClusterAccess['ref'];
    credential: string;
    runAppJob?: (
        ref: AppRuntimeClusterAccess['ref'],
        credential: string,
        job: AppJobRunRequest,
    ) => Promise<AppJobResult>;
}

/** T20's facade, as this service consumes it. */
export interface AppSmokeAccessResolver {
    resolveClusterAccess(workId: string): Promise<AppRuntimeAccessResult>;
}

/** T26's `AppHostsService`, as the public half consumes it. */
export interface AppSmokeHostSource {
    resolveHosts(
        workId: string,
    ): Promise<{ primary: string | null; primaryUrl?: string | null } | null>;
}

/** The App spec's smoke checks, as the runner is handed them (§5.7's `checks`). */
export function smokeChecksOf(spec: AppVerificationSpec): AppSmokeInput[] {
    return [...(spec?.input?.smoke ?? [])].map((check) => ({ ...check }));
}

/**
 * The in-cluster results, from the runner's own answer.
 *
 * The plugin's `AppJobResult` carries **one** `http` finding for the run (§4.8:475) and the
 * `runner: 'smoke'` mode runs the declared checks behind it. So the finding is reported as the
 * run's result, named after the check it belongs to when the plugin says which, and a Job that
 * reported no HTTP finding at all is reported by its own `status` — never as a pass by default.
 */
export function checkResultsOf(job: AppJobResult | null, checks: AppSmokeInput[]): CheckResult[] {
    const finding = job?.http;
    if (finding) {
        return [
            {
                ...finding,
                name: text(finding.name) || text(checks?.[0]?.name) || APP_SMOKE_RUNNER_JOB_NAME,
            },
        ];
    }

    const status = text(job?.status);
    return [
        {
            name: APP_SMOKE_RUNNER_JOB_NAME,
            status: status === 'succeeded' ? 'passed' : 'failed',
            // A Job that timed out never reached the app: the one classification that says so.
            ...(status === 'timeout' ? { classification: 'unreachable' as const } : {}),
        },
    ];
}

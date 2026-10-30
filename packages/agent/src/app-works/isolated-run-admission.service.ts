import { Logger } from '@nestjs/common';
import {
    FLEET_NODE_NON_LEASABLE_STATUSES,
    isAppWorkKind,
    nodeSatisfiesCapabilities,
    type AppRunContainmentAllowance,
    type AppWorkRunContainment,
    type FleetNodeStatus,
    type TaskRunContainmentView,
} from '@ever-works/contracts';

import { resolveTaskRepository, type TaskRepositoryWork } from '../tasks-domain/task-repository';
import {
    resolveTaskDispatchAgentIds,
    type TaskAgentAssigneeReader,
} from '../tasks-domain/task-dispatch-agents';
import {
    isAppWorkRunAdmitted,
    type AppWorkRunAdmission,
    type AppWorkRunAdmissionGate,
    type AppWorkRunAdmissionInput,
    type AppWorkRunContainmentRecorder,
    type AppWorkRunPlacementPreview,
    type AppWorkTaskContainmentReader,
} from './isolated-run-admission';
import {
    applyAppRunContainmentAllowance,
    isNodeContainmentAllowed,
    isolatedHomeDowngradeReason,
    normalizeAppRunContainmentAllowances,
    readAgentRunContainmentRecord,
    toAppWorkRunContainment,
    type AgentRunContainmentRecord,
    type FleetNodeContainmentFacts,
} from './run-containment';

/**
 * APW-08 T12 + T48 — the facts behind isolated-run admission, gathered from platform rows only,
 * and the three ports the API binds over them:
 *
 * - {@link AppWorkRunAdmissionGate} — site 1 of T12 (`TaskTransitionService.dispatchAgentRun`);
 * - {@link AppWorkRunContainmentRecorder} — T48's reconciler hook (what a Fleet run got);
 * - {@link AppWorkTaskContainmentReader} — T48 / T27's Cost view (the record and the holds).
 *
 * Plus the per-Work allowance store behind `POST /api/works/:id/app-runs/allow-containment`.
 *
 * Structural reads (the `AppWorkRunClassifierService` posture), so a spec passes plain doubles and
 * the agent package names no API-side service. The API's `@Global()` `TasksModule` builds it over
 * the Work / Task / run / Fleet repositories, `FleetPushCredentialService.describeScope` (the
 * mint's own precondition) and the fleet-aware dispatcher's `previewPlacement`.
 *
 * ## Fail closed, fact by fact
 *
 * A fact that cannot be read becomes the value that refuses: a placement that cannot be computed
 * is `'unknown'` (→ cloud → `noIsolatedRuntime` unless the cloud runtime is isolated), a node
 * report that cannot be read is an unknown containment (→ `needs_input`), a push-credential
 * lookup that throws is "cannot mint" (→ `noPushCredential`). The one read that fails OPEN is the
 * Work's kind, exactly like T11's FR-9 check: an unreadable Work must not refuse ordinary Tasks on
 * every other kind, and the cloud worker's pre-flight (site 2) and the cloud finalize (T17) still
 * stand behind it.
 */

/** What the gate reads of a Work. */
export interface AdmissionWork extends TaskRepositoryWork {
    readonly id: string;
    readonly userId: string;
    readonly kind?: string | null;
    readonly appRunContainmentAllowances?: unknown;
}

/** What the gate reads of a Fleet node. */
export interface AdmissionNode {
    readonly id: string;
    readonly userId: string;
    readonly name?: string | null;
    readonly status?: FleetNodeStatus | string | null;
    readonly capabilities?: readonly string[] | null;
}

export interface IsolatedRunAdmissionReads {
    works: {
        findById(id: string): Promise<AdmissionWork | null>;
        /** The ownership-scoped App Work write (`WorkRepository.updateAppWorkColumns`). */
        updateAppWorkColumns?(
            id: string,
            userId: string,
            patch: { appRunContainmentAllowances: AppRunContainmentAllowance[] },
        ): Promise<boolean>;
    };
    tasks?: {
        findById(id: string): Promise<{ id: string; workId?: string | null } | null>;
    };
    runs?: {
        recordContainment?(runId: string, record: AgentRunContainmentRecord): Promise<void>;
        findRecentForTask?(
            taskId: string,
            limit: number,
        ): Promise<Array<{ id: string; agentId?: string | null; containment?: unknown }>>;
    };
    assignees?: TaskAgentAssigneeReader;
    fleet?: {
        /** The owner's enrolled nodes. */
        nodesForUser(userId: string): Promise<AdmissionNode[]>;
        nodeById?(nodeId: string): Promise<AdmissionNode | null>;
        /** The node the Agent is pinned to (Agent ↔ node affinity), or null. */
        pinnedNodeFor?(userId: string, agentId: string): Promise<string | null>;
        /** The node's latest RAW containment report (an `agent-task` result block), or null. */
        latestContainment(userId: string, nodeId: string): Promise<unknown>;
    };
    /** GAP-15: can the platform mint a push credential for `owner/repo` for this user? */
    pushCredential?(userId: string, owner: string, repo: string): Promise<boolean>;
    /** The pipeline plugin a CLOUD Task run executes through, or null (none — the default). */
    cloudPipeline?(agent: {
        id: string;
        userId: string;
    }): Promise<{ enforcesRuntimeNetworking?: boolean } | null>;
    /** The Agent's resolved Environment networking mode. */
    environmentNetworking?(agentId: string): Promise<'limited' | 'unrestricted' | null>;
    /** The routing adapter's placement for a dispatch of `agentId` on `task` (read path only). */
    placementFor?(input: {
        task: AppWorkRunAdmissionInput['task'];
        agentId: string;
    }): Promise<AppWorkRunPlacementPreview>;
    now?(): Date;
}

/** How long a POSITIVE push-credential answer is trusted. A negative one is never cached. */
export const APP_WORK_PUSH_CREDENTIAL_CACHE_MS = 10 * 60_000;
/** Runs of a Task read for its latest containment record. */
const CONTAINMENT_RUNS_SCAN = 20;

export type AppRunContainmentAllowanceResult =
    | { status: 'ok'; allowances: AppRunContainmentAllowance[] }
    | { status: 'notAppWork' }
    | { status: 'notFound' }
    | { status: 'unavailable' };

export class IsolatedRunAdmissionService
    implements AppWorkRunAdmissionGate, AppWorkRunContainmentRecorder, AppWorkTaskContainmentReader
{
    private readonly logger = new Logger(IsolatedRunAdmissionService.name);
    /** GAP-15 — `(workId, owner/repo)` → when the positive answer expires. */
    private readonly pushCredentialCache = new Map<string, number>();

    constructor(private readonly reads: IsolatedRunAdmissionReads) {}

    // ── Site 1 ───────────────────────────────────────────────────────────

    async admit(input: AppWorkRunAdmissionInput): Promise<AppWorkRunAdmission | null> {
        const work = await this.readWork(input.task.workId);
        if (!work || !isAppWorkKind(work.kind)) return null;

        if (input.placement.placement === 'fleet') {
            const repository = resolveTaskRepository(work);
            const pushCredential = repository
                ? {
                      owner: repository.owner,
                      repo: repository.repo,
                      available: await this.canMintPush(
                          work.id,
                          input.task.userId,
                          repository.owner,
                          repository.repo,
                      ),
                  }
                : null;
            const fleetCandidates = await this.fleetCandidates(
                input.task.userId,
                input.agent.id,
                input.placement,
                work,
            );
            return isAppWorkRunAdmitted(input.task, {
                placement: 'fleet',
                pushCredential,
                fleetCandidates,
            });
        }

        // 'cloud' / 'unknown': the Environment is read only when the pipeline could admit at all.
        const pipeline = await this.safe('cloud pipeline', null, () =>
            this.reads.cloudPipeline ? this.reads.cloudPipeline(input.agent) : null,
        );
        const environmentNetworking =
            pipeline?.enforcesRuntimeNetworking === true && this.reads.environmentNetworking
                ? await this.safe('environment', null, () =>
                      this.reads.environmentNetworking!(input.agent.id),
                  )
                : null;
        return isAppWorkRunAdmitted(input.task, {
            placement: input.placement.placement,
            pipeline,
            environmentNetworking,
        });
    }

    // ── T48: the reconciler's record ─────────────────────────────────────

    async recordRunContainment(input: {
        taskId: string;
        runId: string;
        userId: string;
        nodeId: string | null;
        rawContainment: unknown;
    }): Promise<boolean> {
        if (!this.reads.runs?.recordContainment || !this.reads.tasks) return false;
        const containment = toAppWorkRunContainment(input.rawContainment);
        if (!containment) return false;
        try {
            const task = await this.reads.tasks.findById(input.taskId);
            const work = await this.readWork(task?.workId);
            // A non-App Task is left exactly as it was: nothing is written for it.
            if (!work || !isAppWorkKind(work.kind)) return false;
            await this.reads.runs.recordContainment(input.runId, {
                ...containment,
                nodeId: input.nodeId,
                reportedAt: this.now().toISOString(),
            });
            return true;
        } catch (err) {
            this.logger.warn(
                `Run ${input.runId}: the containment record could not be written (${describe(err)}).`,
            );
            return false;
        }
    }

    // ── T48 / T27: the Cost view ─────────────────────────────────────────

    async describeForTask(task: {
        id: string;
        userId: string;
        workId?: string | null;
        agentId?: string | null;
        tenantId?: string | null;
        organizationId?: string | null;
    }): Promise<{
        containment: TaskRunContainmentView | null;
        containmentHolds: TaskRunContainmentView[];
    } | null> {
        const work = await this.readWork(task.workId);
        if (!work || !isAppWorkKind(work.kind)) return null;
        const allowances = normalizeAppRunContainmentAllowances(work.appRunContainmentAllowances);

        const runs = this.reads.runs?.findRecentForTask
            ? await this.safe('task runs', [], () =>
                  this.reads.runs!.findRecentForTask!(task.id, CONTAINMENT_RUNS_SCAN),
              )
            : [];
        let containment: TaskRunContainmentView | null = null;
        for (const run of runs) {
            const record = readAgentRunContainmentRecord(run.containment);
            if (!record) continue;
            containment = {
                ...stripRecord(record),
                runId: run.id,
                nodeId: record.nodeId,
                nodeName: await this.nodeName(record.nodeId),
                reportedAt: record.reportedAt,
                reported: true,
                allowedByOwner: isNodeContainmentAllowed(allowances, record.nodeId),
            };
            break;
        }

        // The holds: what the NEXT dispatch would decide for this Task's Agent, minus the push
        // credential (a different refusal with its own copy). Same candidates, same predicate.
        const agentId =
            runs.find((run) => run.agentId)?.agentId ??
            (await this.safe('agent assignees', [] as string[], () =>
                resolveTaskDispatchAgentIds(
                    { id: task.id, agentId: task.agentId ?? null },
                    this.reads.assignees,
                ),
            ))[0] ??
            null;
        const containmentHolds: TaskRunContainmentView[] = [];
        if (agentId && this.reads.placementFor) {
            const placement = await this.safe(
                'placement',
                { placement: 'unknown' } as AppWorkRunPlacementPreview,
                () => this.reads.placementFor!({ task, agentId }),
            );
            if (placement.placement === 'fleet' && !placement.halted) {
                const candidates = await this.fleetCandidates(
                    task.userId,
                    agentId,
                    placement,
                    work,
                );
                for (const candidate of candidates) {
                    const held =
                        (!candidate.containment || candidate.containment.needsOwnerAllowance) &&
                        !candidate.allowed;
                    if (!held) continue;
                    containmentHolds.push({
                        ...(candidate.containment ?? UNREPORTED),
                        runId: null,
                        nodeId: candidate.nodeId,
                        nodeName: await this.nodeName(candidate.nodeId),
                        reportedAt: null,
                        reported: candidate.containment !== null,
                        allowedByOwner: false,
                    });
                }
            }
        }
        return { containment, containmentHolds };
    }

    // ── The allowance store (EW-807 pattern) ─────────────────────────────

    /**
     * `POST /api/works/:id/app-runs/allow-containment` — add (`allow`) or withdraw (`!allow`)
     * ONE node's allowance on ONE App Work. The caller has checked edit access to the Work.
     *
     * The node must be the CALLER's own enrolled machine ("Allow on this machine"): an unknown
     * node id, or another account's, is `notFound` (one 404, no existence leak). The allowance is
     * recorded with the `isolated-home` reason the node last reported, so the Task's Cost view can
     * show the downgrade that was accepted (S33).
     */
    async setContainmentAllowance(input: {
        workId: string;
        nodeId: string;
        allow: boolean;
        actorUserId: string;
    }): Promise<AppRunContainmentAllowanceResult> {
        const work = await this.readWork(input.workId);
        if (!work) return { status: 'notFound' };
        if (!isAppWorkKind(work.kind)) return { status: 'notAppWork' };
        if (!this.reads.works.updateAppWorkColumns || !this.reads.fleet?.nodeById) {
            return { status: 'unavailable' };
        }
        const nodeId = input.nodeId.trim();
        const node = nodeId
            ? await this.safe('node', null, () => this.reads.fleet!.nodeById!(nodeId))
            : null;
        if (!node || node.userId !== input.actorUserId) return { status: 'notFound' };

        const current = normalizeAppRunContainmentAllowances(work.appRunContainmentAllowances);
        let acceptedDowngrade: string | null = null;
        if (input.allow) {
            const report = await this.safe('node containment', null, () =>
                this.reads.fleet!.latestContainment(input.actorUserId, nodeId),
            );
            const containment = toAppWorkRunContainment(report);
            acceptedDowngrade = containment
                ? isolatedHomeDowngradeReason(containment)
                : 'this machine had not reported its containment yet';
        }
        const next = applyAppRunContainmentAllowance(current, {
            nodeId,
            allow: input.allow,
            actorUserId: input.actorUserId,
            at: this.now(),
            acceptedDowngrade,
        });
        const written = await this.reads.works.updateAppWorkColumns(work.id, work.userId, {
            appRunContainmentAllowances: next,
        });
        if (!written) return { status: 'notFound' };
        this.logger.log(
            `App Work ${work.id}: containment allowance ${input.allow ? 'granted' : 'withdrawn'} for node ${nodeId} by user ${input.actorUserId}.`,
        );
        return { status: 'ok', allowances: next };
    }

    // ── Facts ────────────────────────────────────────────────────────────

    /**
     * Every node that could lease the run: the pinned node alone, or — unpinned — every enrolled
     * node of the owner in a leasable status that advertises the tags the job will require. Each
     * with its latest report (normalized) and whether this App Work allows its downgrade.
     */
    private async fleetCandidates(
        userId: string,
        agentId: string,
        placement: AppWorkRunPlacementPreview,
        work: AdmissionWork,
    ): Promise<FleetNodeContainmentFacts[]> {
        const fleet = this.reads.fleet;
        if (!fleet) return [];
        const allowances = normalizeAppRunContainmentAllowances(work.appRunContainmentAllowances);
        let nodeIds: string[];
        const pinned =
            placement.targetNodeId ??
            (fleet.pinnedNodeFor
                ? await this.safe('agent affinity', null, () =>
                      fleet.pinnedNodeFor!(userId, agentId),
                  )
                : null);
        if (pinned) {
            nodeIds = [pinned];
        } else {
            const nodes = await this.safe('fleet nodes', null, () => fleet.nodesForUser(userId));
            if (nodes === null) {
                // The node list could not be read: nothing can be shown admissible. One
                // synthetic unknown candidate holds the run (fail closed) — with no node id an
                // owner could allow, which is the honest answer to "we could not look".
                return [{ nodeId: 'unknown', containment: null, allowed: false }];
            }
            nodeIds = nodes
                .filter(
                    (node) =>
                        node.userId === userId &&
                        !FLEET_NODE_NON_LEASABLE_STATUSES.includes(node.status as FleetNodeStatus) &&
                        nodeSatisfiesCapabilities(
                            node.capabilities ?? [],
                            placement.requiredCapabilities ?? [],
                        ),
                )
                .map((node) => node.id);
        }
        const facts: FleetNodeContainmentFacts[] = [];
        for (const nodeId of nodeIds) {
            const raw = await this.safe('node containment', null, () =>
                fleet.latestContainment(userId, nodeId),
            );
            facts.push({
                nodeId,
                containment: toAppWorkRunContainment(raw),
                allowed: isNodeContainmentAllowed(allowances, nodeId),
            });
        }
        return facts;
    }

    /**
     * GAP-15 / FR-75 — can the platform mint a push credential for the Work Repository's owner?
     * A positive answer is cached per `(workId, owner/repo)` — the owner is what FR-75 re-checks
     * on; the repository name rides along so a rename is re-checked too. A negative answer is
     * NEVER cached: the same Task must start the moment the installation is granted (ACC-08-39).
     * No lookup bound = nothing to ask (the planner's own plan-time check stands behind it).
     */
    private async canMintPush(
        workId: string,
        userId: string,
        owner: string,
        repo: string,
    ): Promise<boolean> {
        if (!this.reads.pushCredential) return true;
        const key = `${workId}:${owner.toLowerCase()}/${repo.toLowerCase()}`;
        const now = this.now().getTime();
        const expires = this.pushCredentialCache.get(key);
        if (expires !== undefined && expires > now) return true;
        this.pushCredentialCache.delete(key);
        const available = await this.safe('push credential', false, () =>
            this.reads.pushCredential!(userId, owner, repo),
        );
        if (available) this.pushCredentialCache.set(key, now + APP_WORK_PUSH_CREDENTIAL_CACHE_MS);
        return available;
    }

    private async readWork(workId: string | null | undefined): Promise<AdmissionWork | null> {
        if (!workId) return null;
        try {
            return await this.reads.works.findById(workId);
        } catch (err) {
            this.logger.warn(
                `Work ${workId} could not be read for isolated-run admission (${describe(err)}); treating it as not an App Work.`,
            );
            return null;
        }
    }

    private async nodeName(nodeId: string | null): Promise<string | null> {
        if (!nodeId || !this.reads.fleet?.nodeById) return null;
        const node = await this.safe('node name', null, () => this.reads.fleet!.nodeById!(nodeId));
        return node?.name?.trim() || null;
    }

    private now(): Date {
        return this.reads.now ? this.reads.now() : new Date();
    }

    private async safe<T>(what: string, fallback: T, fn: () => Promise<T> | T): Promise<T> {
        try {
            return await fn();
        } catch (err) {
            this.logger.warn(`Isolated-run admission: ${what} could not be read (${describe(err)}).`);
            return fallback;
        }
    }
}

/** The containment shown for a node that has never reported one (treated as a downgrade). */
const UNREPORTED: AppWorkRunContainment = Object.freeze({
    executionPath: 'ordinary',
    isolatedHome: false,
    downgrades: [],
    needsOwnerAllowance: true,
}) as AppWorkRunContainment;

function stripRecord(record: AgentRunContainmentRecord): AppWorkRunContainment {
    return {
        executionPath: record.executionPath,
        isolatedHome: record.isolatedHome,
        downgrades: record.downgrades,
        needsOwnerAllowance: record.needsOwnerAllowance,
    };
}

function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

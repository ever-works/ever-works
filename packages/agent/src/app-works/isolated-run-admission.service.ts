import { Logger } from '@nestjs/common';
import {
    isAppWorkKind,
    nodeSatisfiesCapabilities,
    type AppRunContainmentAllowance,
    type AppWorkRunContainment,
    type FleetNodeStatus,
    type TaskRunContainmentView,
} from '@ever-works/contracts';

import type { FleetAppWorkLeaseAdmission } from '../fleet/fleet-app-work-lease-admission.port';
import { resolveTaskRepository, type TaskRepositoryWork } from '../tasks-domain/task-repository';
import type { AppChangeTelemetryPayloads } from './app-change.telemetry';
import {
    resolveTaskDispatchAgentIds,
    type TaskAgentAssigneeReader,
} from '../tasks-domain/task-dispatch-agents';
import {
    appWorkRepositorySizeRefusal,
    appWorkRunStageSizeLimitKb,
    describeAppWorkUnreadable,
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
    isNodeContainmentAdmissible,
    isNodeContainmentAllowed,
    isolatedHomeDowngradeReason,
    normalizeAppRunContainmentAllowances,
    readAgentRunContainmentRecord,
    toAppWorkRunContainment,
    UNREADABLE_FLEET_NODE,
    type AgentRunContainmentRecord,
    type FleetNodeContainmentFacts,
} from './run-containment';

/**
 * APW-08 T12 + T48 — the facts behind isolated-run admission, gathered from platform rows only,
 * and the four ports the API binds over them:
 *
 * - {@link AppWorkRunAdmissionGate} — site 1 of T12 (`TaskTransitionService.dispatchAgentRun`)
 *   and the Fleet half of every enqueue (the fleet-aware dispatcher: drained, promoted and
 *   resumed runs);
 * - {@link FleetAppWorkLeaseAdmission} — the LEASE: the node that takes an App Work job;
 * - {@link AppWorkRunContainmentRecorder} — T48's reconciler hook (what a Fleet run got);
 * - {@link AppWorkTaskContainmentReader} — T48 / T27's Cost view (the record and the holds).
 *
 * Plus the per-Work allowance store behind `POST /api/works/:id/app-runs/allow-containment`.
 *
 * Structural reads (the `AppWorkRunClassifierService` posture), so a spec passes plain doubles and
 * the agent package names no API-side service.
 *
 * ## Fail closed, fact by fact
 *
 * A fact that cannot be read becomes the value that refuses: a placement that cannot be computed
 * is `'unknown'` (→ cloud → `noIsolatedRuntime` unless the cloud runtime is isolated), a node
 * report that cannot be read is an unknown containment (→ `needs_input`), a node list that cannot
 * be read holds the run, a push-credential lookup that throws is "cannot mint" (→
 * `noPushCredential`), and — review of #3040, decision: fail CLOSED as T12 says — a Work (or a
 * Task) that cannot be read is `work-unreadable`, retryable, never an admission.
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
        /**
         * Review of #3040 (minor 7) — the ownership-scoped compare-and-set of the allowance column
         * (`WorkRepository.casAppRunContainmentAllowances`): writes `next` only while the column
         * still holds `previous` (the value this caller read), so two concurrent allowances for
         * different nodes can never lose one. Answers whether the row was written.
         */
        casAppRunContainmentAllowances?(
            id: string,
            userId: string,
            previous: unknown,
            next: AppRunContainmentAllowance[],
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
        /** The owner's enrolled nodes, any status. */
        nodesForUser(userId: string): Promise<AdmissionNode[]>;
        nodeById?(nodeId: string): Promise<AdmissionNode | null>;
        /** The node the Agent is pinned to (Agent ↔ node affinity), or null. */
        pinnedNodeFor?(userId: string, agentId: string): Promise<string | null>;
        /** The node's latest RAW containment report (an `agent-task` result block), or null. */
        latestContainment(userId: string, nodeId: string): Promise<unknown>;
    };
    /** GAP-15: can the platform mint a push credential for `owner/repo` for this user? */
    pushCredential?(userId: string, owner: string, repo: string): Promise<boolean>;
    /**
     * APW-08 T53 (FR-72) — the Work Repository's provider-reported size in KB (APW-01 Inspect's
     * reading), or null when it cannot be measured. Asked ONLY while the checkout stage has a
     * limit in the shared table; today it has none, so it is never called.
     */
    repositorySizeKb?(
        userId: string,
        owner: string,
        repo: string,
        work: AdmissionWork,
    ): Promise<number | null>;
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
/** Review of #3040 (minor 8) — the most nodes one admission (or Cost view) scans. */
export const APP_WORK_FLEET_CANDIDATES_MAX = 50;
/** Review of #3040 (minor 7) — attempts of the allowance compare-and-set before giving up. */
const ALLOWANCE_CAS_ATTEMPTS = 4;

export type AppRunContainmentAllowanceResult =
    | { status: 'ok'; allowances: AppRunContainmentAllowance[] }
    | { status: 'notAppWork' }
    | { status: 'notFound' }
    | { status: 'unavailable' }
    | { status: 'conflict' };

/** The Work as one admission read it: none, an App Work (or not), or unreadable (fail closed). */
type WorkRead =
    | { kind: 'none' }
    | { kind: 'work'; work: AdmissionWork | null }
    | { kind: 'unreadable'; workId: string | null };

/** The candidate set: the owner's enrolled count (null = unknown) and each candidate's facts. */
interface FleetCandidates {
    enrolled: number | null;
    facts: FleetNodeContainmentFacts[];
}

export class IsolatedRunAdmissionService
    implements
        AppWorkRunAdmissionGate,
        FleetAppWorkLeaseAdmission,
        AppWorkRunContainmentRecorder,
        AppWorkTaskContainmentReader
{
    private readonly logger = new Logger(IsolatedRunAdmissionService.name);
    /** GAP-15 — `(userId, workId, owner/repo)` → when the positive answer expires. */
    private readonly pushCredentialCache = new Map<string, number>();

    constructor(private readonly reads: IsolatedRunAdmissionReads) {}

    // ── Site 1, and the Fleet half of every enqueue ──────────────────────

    async admit(input: AppWorkRunAdmissionInput): Promise<AppWorkRunAdmission | null> {
        const read = await this.readWorkFor(input);
        if (read.kind === 'unreadable') {
            return {
                admitted: false,
                outcome: 'refused',
                code: 'work-unreadable',
                message: describeAppWorkUnreadable(read.workId),
            };
        }
        if (read.kind === 'none' || !read.work || !isAppWorkKind(read.work.kind)) return null;
        const work = read.work;

        // APW-08 T53 (FR-72, S35) — before anything else is asked: a repository the checkout stage
        // would refuse runs nowhere, whatever the placement.
        const tooLarge = await this.repositorySizeRefusal(work, input.task.userId);
        if (tooLarge) return tooLarge;

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
            const candidates = await this.fleetCandidates(
                input.task.userId,
                input.agent.id,
                input.placement,
                work,
            );
            return withWorkId(
                isAppWorkRunAdmitted(input.task, {
                    placement: 'fleet',
                    pushCredential,
                    fleetCandidates: candidates.facts,
                    ...(candidates.enrolled === null
                        ? {}
                        : { fleetEnrolledNodes: candidates.enrolled }),
                }),
                work.id,
            );
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
        return withWorkId(
            isAppWorkRunAdmitted(input.task, {
                placement: input.placement.placement,
                pipeline,
                environmentNetworking,
            }),
            work.id,
        );
    }

    // ── The lease: the node that actually takes the job ─────────────────

    /**
     * Review of #3040 (MAJOR 2) — may THIS node lease this App Work job? Its own latest report
     * (isolated home, no `isolated-home` downgrade) or the owner's allowance for it on that Work.
     * Everything that cannot be read refuses: the job stays queued for an admissible node.
     */
    async admitsLease(input: {
        userId: string;
        nodeId: string;
        workId: string;
        jobId: string;
    }): Promise<boolean> {
        try {
            const work = await this.reads.works.findById(input.workId);
            if (!work) return false;
            // A Work that is no longer an App Work has no containment rule to apply.
            if (!isAppWorkKind(work.kind)) return true;
            if (!this.reads.fleet) return false;
            const allowances = normalizeAppRunContainmentAllowances(
                work.appRunContainmentAllowances,
            );
            const raw = await this.reads.fleet.latestContainment(input.userId, input.nodeId);
            return isNodeContainmentAdmissible({
                containment: toAppWorkRunContainment(raw),
                allowed: isNodeContainmentAllowed(allowances, input.nodeId),
            });
        } catch (err) {
            this.logger.warn(
                `Lease of App Work job ${input.jobId} by node ${input.nodeId} refused — admission could not be read (${describe(err)}).`,
            );
            return false;
        }
    }

    /**
     * APW-08 T43 (plan §8.1, XC-06) — the `app.change.run_admitted` payload for a node that just
     * WON an App Work job: the containment it runs under, and whether it runs only because the
     * owner allowed a downgrade there. `null` when there is nothing honest to report (no Task id
     * on the job, the Work gone or no longer an App Work). Never throws.
     */
    async runAdmittedPayload(input: {
        userId: string;
        nodeId: string;
        workId: string;
        taskId: string | null;
    }): Promise<AppChangeTelemetryPayloads['app.change.run_admitted'] | null> {
        if (!input.taskId) return null;
        try {
            const work = await this.reads.works.findById(input.workId);
            if (!work || !isAppWorkKind(work.kind)) return null;
            const raw = this.reads.fleet
                ? await this.reads.fleet.latestContainment(input.userId, input.nodeId)
                : null;
            const containment = toAppWorkRunContainment(raw);
            return {
                workId: input.workId,
                taskId: input.taskId,
                placement: 'fleet',
                containmentPath: containment?.executionPath ?? 'unknown',
                isolatedHome: containment?.isolatedHome === true,
                // Admissible on its own report, or only because the owner allowed it there.
                downgraded: !isNodeContainmentAdmissible({ containment, allowed: false }),
            };
        } catch (err) {
            this.logger.warn(
                `run_admitted for App Work ${input.workId} on node ${input.nodeId} could not be described (${describe(err)}).`,
            );
            return null;
        }
    }

    // ── T48: the reconciler's record ─────────────────────────────────────

    async recordRunContainment(input: {
        taskId: string;
        runId: string;
        userId: string;
        workId: string;
        nodeId: string | null;
        rawContainment: unknown;
    }): Promise<boolean> {
        if (!this.reads.runs?.recordContainment || !input.workId) return false;
        const containment = toAppWorkRunContainment(input.rawContainment);
        if (!containment) return false;
        try {
            // The job payload's `appWorkId` is platform-written (the dispatcher stamps it after
            // admitting the run), so nothing is read here: a non-App completion never reaches it.
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
        viewerUserId?: string | null;
    }): Promise<{
        containment: TaskRunContainmentView | null;
        containmentHolds: TaskRunContainmentView[];
    } | null> {
        // One Work read decides; a non-App Task costs nothing more (review of #3040, minor 8).
        if (!task.workId) return null;
        let work: AdmissionWork | null;
        try {
            work = await this.reads.works.findById(task.workId);
        } catch {
            return null;
        }
        if (!work || !isAppWorkKind(work.kind)) return null;
        const allowances = normalizeAppRunContainmentAllowances(work.appRunContainmentAllowances);
        const viewer = task.viewerUserId ?? null;

        const runs = this.reads.runs?.findRecentForTask
            ? await this.safe('task runs', [], () =>
                  this.reads.runs!.findRecentForTask!(task.id, CONTAINMENT_RUNS_SCAN),
              )
            : [];
        let containment: TaskRunContainmentView | null = null;
        for (const run of runs) {
            const record = readAgentRunContainmentRecord(run.containment);
            if (!record) continue;
            const node = await this.node(record.nodeId);
            containment = {
                ...stripRecord(record),
                runId: run.id,
                nodeId: record.nodeId,
                nodeName: node?.name?.trim() || null,
                reportedAt: record.reportedAt,
                reported: true,
                allowedByOwner: isNodeContainmentAllowed(allowances, record.nodeId),
                acceptedDowngrade:
                    allowances.find((entry) => entry.nodeId === record.nodeId)?.acceptedDowngrade ??
                    null,
                viewerOwnsNode: !!node && !!viewer && node.userId === viewer,
            };
            break;
        }

        // The holds: the candidate nodes the NEXT dispatch would not hand this Task's run to,
        // minus the push credential (a different refusal with its own copy). Same candidates.
        const agentId =
            runs.find((run) => run.agentId)?.agentId ??
            (
                await this.safe('agent assignees', [] as string[], () =>
                    resolveTaskDispatchAgentIds(
                        { id: task.id, agentId: task.agentId ?? null },
                        this.reads.assignees,
                    ),
                )
            )[0] ??
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
                for (const candidate of candidates.facts) {
                    if (isNodeContainmentAdmissible(candidate)) continue;
                    const unreadable = candidate.nodeId === UNREADABLE_FLEET_NODE;
                    const node = unreadable ? null : await this.node(candidate.nodeId);
                    containmentHolds.push({
                        ...(candidate.containment ?? UNREPORTED),
                        runId: null,
                        // The synthetic "node list unreadable" hold names nothing to allow.
                        nodeId: unreadable ? null : candidate.nodeId,
                        nodeName: node?.name?.trim() || null,
                        reportedAt: null,
                        reported: candidate.containment !== null,
                        allowedByOwner: false,
                        viewerOwnsNode: !!node && !!viewer && node.userId === viewer,
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
     * node id, or another account's, is `notFound` (one 404, no existence leak) — so an editor can
     * neither allow nor withdraw another editor's machine. The allowance is recorded with the
     * `isolated-home` reason the node last reported, so the Cost view can show what was accepted.
     *
     * Atomic (review of #3040, minor 7): a compare-and-set on the value this call read, retried on
     * a lost race with a fresh read, so concurrent allowances for different nodes both land.
     */
    async setContainmentAllowance(input: {
        workId: string;
        nodeId: string;
        allow: boolean;
        actorUserId: string;
    }): Promise<AppRunContainmentAllowanceResult> {
        if (!this.reads.works.casAppRunContainmentAllowances || !this.reads.fleet?.nodeById) {
            return { status: 'unavailable' };
        }
        const nodeId = input.nodeId.trim();
        const node = nodeId
            ? await this.safe('node', null, () => this.reads.fleet!.nodeById!(nodeId))
            : null;

        let acceptedDowngrade: string | null = null;
        let acceptedRead = false;
        for (let attempt = 0; attempt < ALLOWANCE_CAS_ATTEMPTS; attempt += 1) {
            const work = await this.reads.works.findById(input.workId);
            if (!work) return { status: 'notFound' };
            if (!isAppWorkKind(work.kind)) return { status: 'notAppWork' };
            if (!node || node.userId !== input.actorUserId) return { status: 'notFound' };

            if (input.allow && !acceptedRead) {
                const report = await this.safe('node containment', null, () =>
                    this.reads.fleet!.latestContainment(input.actorUserId, nodeId),
                );
                const containment = toAppWorkRunContainment(report);
                acceptedDowngrade = containment
                    ? isolatedHomeDowngradeReason(containment)
                    : 'this machine had not reported its containment yet';
                acceptedRead = true;
            }
            const previous = work.appRunContainmentAllowances ?? null;
            const next = applyAppRunContainmentAllowance(
                normalizeAppRunContainmentAllowances(previous),
                {
                    nodeId,
                    allow: input.allow,
                    actorUserId: input.actorUserId,
                    at: this.now(),
                    acceptedDowngrade,
                },
            );
            const written = await this.reads.works.casAppRunContainmentAllowances(
                work.id,
                work.userId,
                previous,
                next,
            );
            if (written) {
                this.logger.log(
                    `App Work ${work.id}: containment allowance ${input.allow ? 'granted' : 'withdrawn'} for node ${nodeId} by user ${input.actorUserId}.`,
                );
                return { status: 'ok', allowances: next };
            }
            // Lost the race (another allowance landed in between): read again and re-apply.
        }
        this.logger.warn(
            `App Work ${input.workId}: containment allowance for node ${nodeId} not written after ${ALLOWANCE_CAS_ATTEMPTS} attempts (concurrent changes).`,
        );
        return { status: 'conflict' };
    }

    // ── Facts ────────────────────────────────────────────────────────────

    /**
     * The Work this admission is about. Prefetched by the caller (site 1 reads it ONCE per
     * dispatch), else read here; a Task whose Work is not known (the dispatcher's scope lookup came
     * back empty) is read first. Any read that throws is `unreadable` — fail CLOSED.
     */
    private async readWorkFor(input: AppWorkRunAdmissionInput): Promise<WorkRead> {
        if (input.work !== undefined) {
            return { kind: 'work', work: (input.work as AdmissionWork | null) ?? null };
        }
        let workId = input.task.workId;
        if (workId === undefined) {
            if (!this.reads.tasks) return { kind: 'unreadable', workId: null };
            try {
                const task = await this.reads.tasks.findById(input.task.id);
                workId = task?.workId ?? null;
            } catch (err) {
                this.logger.warn(
                    `Task ${input.task.id} could not be read for isolated-run admission (${describe(err)}).`,
                );
                return { kind: 'unreadable', workId: null };
            }
        }
        if (!workId) return { kind: 'none' };
        try {
            return { kind: 'work', work: await this.reads.works.findById(workId) };
        } catch (err) {
            this.logger.warn(
                `Work ${workId} could not be read for isolated-run admission (${describe(err)}); refusing (fail closed).`,
            );
            return { kind: 'unreadable', workId };
        }
    }

    /**
     * Every node that could lease the run: the pinned node alone, or — unpinned — every enrolled
     * node of the owner that advertises the tags the job will require, in any status that can
     * lease again (review of #3040: a `paused` or `enrolling` node can lease later, so it counts;
     * a `disabled` node cannot, so it does not — an owner whose only admissible node is disabled
     * gets `noEligibleNode`, not an admitted run that waits out the SLA). Capped at
     * {@link APP_WORK_FLEET_CANDIDATES_MAX} in a deterministic order — the nodes able to lease now
     * first (`online`, then `offline`, `paused`, `enrolling`), then by id — so the same Fleet
     * always yields the same candidate set. Each with its latest report (normalized) and whether
     * this App Work allows its downgrade.
     */
    private async fleetCandidates(
        userId: string,
        agentId: string,
        placement: AppWorkRunPlacementPreview,
        work: AdmissionWork,
    ): Promise<FleetCandidates> {
        const fleet = this.reads.fleet;
        if (!fleet) return { enrolled: null, facts: [] };
        const allowances = normalizeAppRunContainmentAllowances(work.appRunContainmentAllowances);
        const nodes = await this.safe('fleet nodes', null as AdmissionNode[] | null, () =>
            fleet.nodesForUser(userId),
        );
        if (nodes === null) {
            // The node list could not be read: nothing can be shown admissible. One synthetic
            // unknown candidate holds the run (fail closed), naming nothing an owner could allow.
            return {
                enrolled: null,
                facts: [{ nodeId: UNREADABLE_FLEET_NODE, containment: null, allowed: false }],
            };
        }
        const owned = nodes.filter((node) => node.userId === userId);
        const pinned =
            placement.targetNodeId ??
            (fleet.pinnedNodeFor
                ? await this.safe('agent affinity', null, () =>
                      fleet.pinnedNodeFor!(userId, agentId),
                  )
                : null);
        // A pinned run is judged on its node alone and never falls back to another one; a pin to a
        // DISABLED node is no candidate either (CodeRabbit on #3041), so the run is held
        // (`noEligibleNode`), not admitted to wait for a lease that cannot come.
        const pinnedDisabled =
            !!pinned && owned.some((node) => node.id === pinned && node.status === 'disabled');
        const nodeIds = pinned
            ? pinnedDisabled
                ? []
                : [pinned]
            : owned
                  .filter(
                      (node) =>
                          node.status !== 'disabled' &&
                          nodeSatisfiesCapabilities(
                              node.capabilities ?? [],
                              placement.requiredCapabilities ?? [],
                          ),
                  )
                  .sort(
                      (a, b) =>
                          candidateStatusRank(a.status) - candidateStatusRank(b.status) ||
                          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
                  )
                  .slice(0, APP_WORK_FLEET_CANDIDATES_MAX)
                  .map((node) => node.id);
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
        return { enrolled: owned.length, facts };
    }

    /**
     * APW-08 T53 (FR-72, S35, ACC-08-36) — the refusal for a Work Repository larger than the shared
     * table allows at the run's checkout stage, or `null`. Reads NOTHING while that stage has no
     * limit (today), so adding the check costs no provider call. With a limit, a size that cannot
     * be read — no repository coordinates, no read bound, or a failed read — is unmeasurable and
     * refused, as the table's own rule says (fail closed).
     */
    private async repositorySizeRefusal(
        work: AdmissionWork,
        userId: string,
    ): Promise<AppWorkRunAdmission | null> {
        if (appWorkRunStageSizeLimitKb() === undefined) return null;
        const repository = resolveTaskRepository(work);
        const sizeKb =
            repository && this.reads.repositorySizeKb
                ? await this.safe('repository size', null as number | null, () =>
                      this.reads.repositorySizeKb!(userId, repository.owner, repository.repo, work),
                  )
                : null;
        return appWorkRepositorySizeRefusal({ sizeKb });
    }

    /**
     * GAP-15 / FR-75 — can the platform mint a push credential for the Work Repository's owner?
     * A positive answer is cached per `(userId, workId, owner/repo)`: `describeScope` is per USER
     * (the installation must be one this user controls), so one member's yes never admits
     * another member's Task (review of #3040, minor 4); the owner is what FR-75 re-checks on, and
     * the repository name rides along so a rename is re-checked too. A negative answer is NEVER
     * cached: the same Task must start the moment the installation is granted (ACC-08-39). No
     * lookup bound = nothing to ask (the planner's own plan-time check stands behind it).
     */
    private async canMintPush(
        workId: string,
        userId: string,
        owner: string,
        repo: string,
    ): Promise<boolean> {
        if (!this.reads.pushCredential) return true;
        const key = `${userId}:${workId}:${owner.toLowerCase()}/${repo.toLowerCase()}`;
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

    private async node(nodeId: string | null): Promise<AdmissionNode | null> {
        if (!nodeId || !this.reads.fleet?.nodeById) return null;
        return this.safe('node', null, () => this.reads.fleet!.nodeById!(nodeId));
    }

    private now(): Date {
        return this.reads.now ? this.reads.now() : new Date();
    }

    private async safe<T>(what: string, fallback: T, fn: () => Promise<T> | T): Promise<T> {
        try {
            return await fn();
        } catch (err) {
            this.logger.warn(
                `Isolated-run admission: ${what} could not be read (${describe(err)}).`,
            );
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

/** An admission names the App Work it admitted (the job's `appWorkId` marker); refusals as-is. */
function withWorkId(admission: AppWorkRunAdmission, workId: string): AppWorkRunAdmission {
    return admission.admitted === true ? { ...admission, workId } : admission;
}

/**
 * The candidate order before the cap: nodes that can lease now first. An unknown status sorts
 * last but still counts (it is not `disabled`).
 */
const CANDIDATE_STATUS_ORDER: readonly string[] = ['online', 'offline', 'paused', 'enrolling'];

function candidateStatusRank(status: string | null | undefined): number {
    const rank = CANDIDATE_STATUS_ORDER.indexOf(String(status ?? ''));
    return rank === -1 ? CANDIDATE_STATUS_ORDER.length : rank;
}

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

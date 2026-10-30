import type { AppWorkRunContainment, TaskRunContainmentView } from '@ever-works/contracts';

import {
    admitFleetContainment,
    isFleetContainmentHeld,
    type FleetNodeContainmentFacts,
} from './run-containment';

/**
 * APW-08 T12 (FR-12, FR-70, FR-75; ACC-08-08, ACC-08-34, ACC-08-39) — isolated-run admission.
 *
 * An agent run on an App Work Task executes only (a) on a Fleet node the owner enrolled, or (b) in
 * an isolated run environment that receives no platform secret and restricts network access to the
 * repository host and package registries. With neither, the run does not start (S15).
 *
 * ## Where the placement comes from (APW08-G11)
 *
 * `TaskTransitionService.dispatchAgentRun` does not decide where a run goes: placement is decided
 * later, inside `dispatcher.enqueue`, by the fleet routing adapter reading the tenant's job-runtime
 * config. So the predicate takes an explicit {@link AppWorkRunPlacement}, produced by THAT adapter
 * (`AgentTaskExecuteDispatcher.previewPlacement`, the same router call `enqueue` makes), and it is
 * evaluated at TWO sites:
 *
 * 1. `dispatchAgentRun`, ahead of `RunDispatchGateService` — the refusal site FR-12 needs, before
 *    a run row exists. It is NOT a middleware of `DEFAULT_RUN_ADMISSION_CHAIN` (Resolution R-17):
 *    the chain PARKS (a wait), this REFUSES. An admitted run then passes the unchanged chain, so a
 *    paused Agent's App Work run is still parked `agent-paused`, not refused.
 * 2. The cloud worker's pre-flight (`agent-task-execute`), before provisioning — so a router that
 *    falls back from Fleet to cloud between (1) and (2), or a drained / resumed run that reached
 *    the worker without passing (1), cannot start a run the predicate refuses.
 *
 * `'unknown'` is treated as `'cloud'`: the predicate fails closed.
 *
 * ## The two admissible branches
 *
 * - **Fleet** — admitted while every node that could take the run reports `isolatedHome === true`
 *   and no `isolated-home` downgrade (T48's `admitFleetContainment`), or the owner allowed that
 *   node's downgrade; a downgrade is `needs_input`, not a refusal. And before a Fleet run of the
 *   App Work is admitted, the platform must be able to mint a push credential for the Work
 *   Repository's owner (GAP-15, FR-75), or it is refused with the S28 copy naming that owner.
 * - **Isolated cloud** — the resolved pipeline plugin declares
 *   `IPipelinePlugin.enforcesRuntimeNetworking === true` (APW-04, CONTRACTS §3) AND the Agent's
 *   resolved Environment is `limited`. The flag lives on the plugin; no plugin id appears in core
 *   (Constitution II).
 *
 * 🛑 A leaf: contracts types and the T48 leaf only. `TaskTransitionService` reads
 * {@link APP_WORK_RUN_ADMISSION} in a parameter decorator, and the cloud worker imports the
 * pre-flight, so neither may pull a service graph in through this file.
 */

/** Where the run will execute, as the routing adapter answers it. `'unknown'` reads as `'cloud'`. */
export type AppWorkRunPlacement = 'fleet' | 'cloud' | 'unknown';

/** The refusal codes (plan §4's error contract, spec copy keys under `appRules`). */
export const APP_WORK_RUN_REFUSAL_CODES = [
    'noIsolatedRuntime',
    'noPushCredential',
    'containmentDowngrade',
] as const;
export type AppWorkRunRefusalCode = (typeof APP_WORK_RUN_REFUSAL_CODES)[number];

/** The plan inputs the predicate reads — every fact explicit, nothing looked up here. */
export interface AppWorkRunAdmissionPlan {
    placement: AppWorkRunPlacement;
    /** Cloud branch: the pipeline plugin the run would execute through; `null` = none. */
    pipeline?: { readonly enforcesRuntimeNetworking?: boolean } | null;
    /** Cloud branch: the Agent's resolved Environment networking mode; `null` = none assigned. */
    environmentNetworking?: 'limited' | 'unrestricted' | null;
    /** Fleet branch: every node that could take the run, with its latest report and allowance. */
    fleetCandidates?: readonly FleetNodeContainmentFacts[];
    /**
     * Fleet branch (GAP-15): can the platform mint a push credential for the Work Repository's
     * owner? `null` = the App Work has no repository the question can be asked of (refused).
     */
    pushCredential?: { owner: string; repo: string; available: boolean } | null;
}

/** The predicate's answer: admitted, refused (FR-12 / FR-75), or held for the owner (FR-70). */
export type AppWorkRunAdmission =
    | { admitted: true; branch: 'fleet' | 'isolated-cloud' }
    | {
          admitted: false;
          outcome: 'refused';
          code: 'noIsolatedRuntime';
          message: string;
      }
    | {
          admitted: false;
          outcome: 'refused';
          code: 'noPushCredential';
          owner: string;
          repo: string;
          message: string;
      }
    | {
          admitted: false;
          outcome: 'needs_input';
          code: 'containmentDowngrade';
          nodeId: string;
          containment: AppWorkRunContainment | null;
          message: string;
      };

/** Every refusal of {@link AppWorkRunAdmission} (`refused` or `needs_input`). */
export type AppWorkRunRefusal = Exclude<AppWorkRunAdmission, { admitted: true }>;

/**
 * Type guard for a refusal. Explicit rather than `!admission.admitted` because the agent package
 * compiles some specs with `strictNullChecks: false`, where a boolean-literal discriminant does
 * not narrow.
 */
export function isAppWorkRunRefusal(
    admission: AppWorkRunAdmission | null | undefined,
): admission is AppWorkRunRefusal {
    return !!admission && admission.admitted === false;
}

/** S15 / `appRules.noIsolatedRuntime`. */
export const APP_WORK_NO_ISOLATED_RUNTIME_MESSAGE =
    "This app's code can only run on one of your machines or in an isolated sandbox, and none is set up.";

/** S33 / `appRules.containmentDowngrade`. */
export const APP_WORK_CONTAINMENT_DOWNGRADE_MESSAGE =
    'This machine runs app changes without an isolated home. Allow it once, or run this Task in an isolated sandbox.';

/** S28 / `appRules.noPushCredential`, naming the Work Repository and its owner. */
export function describeAppWorkNoPushCredential(owner: string, repo: string): string {
    return `Ever Works can't push to ${owner}/${repo} from your machines. Install the Ever Works GitHub App on ${owner}.`;
}

/**
 * The predicate (T12): `isAppWorkRunAdmitted(task, plan)`.
 *
 * `task` is carried for the caller's logging and future rules; the decision reads `plan` only, so
 * it is pure and every input is visible in a spec. The caller has already established that the
 * Task is on an App Work and that the run is not a review run (a review run is not a change).
 */
export function isAppWorkRunAdmitted(
    _task: { id: string; workId?: string | null },
    plan: AppWorkRunAdmissionPlan,
): AppWorkRunAdmission {
    if (plan.placement === 'fleet') {
        // GAP-15 / FR-75 first: an owner who allows a downgraded node still could not get a push
        // out of it, so the refusal the owner must fix on GitHub is the one shown.
        const push = plan.pushCredential;
        if (!push || !push.available) {
            const owner = push?.owner ?? '';
            const repo = push?.repo ?? '';
            return {
                admitted: false,
                outcome: 'refused',
                code: 'noPushCredential',
                owner,
                repo,
                message: describeAppWorkNoPushCredential(owner || 'this owner', repo || 'this app'),
            };
        }
        const containment = admitFleetContainment(plan.fleetCandidates ?? []);
        if (isFleetContainmentHeld(containment)) {
            return {
                admitted: false,
                outcome: 'needs_input',
                code: 'containmentDowngrade',
                nodeId: containment.nodeId,
                containment: containment.containment,
                message: APP_WORK_CONTAINMENT_DOWNGRADE_MESSAGE,
            };
        }
        return { admitted: true, branch: 'fleet' };
    }
    // 'cloud' and 'unknown' — the same branch: fail closed.
    if (
        plan.pipeline?.enforcesRuntimeNetworking === true &&
        plan.environmentNetworking === 'limited'
    ) {
        return { admitted: true, branch: 'isolated-cloud' };
    }
    return {
        admitted: false,
        outcome: 'refused',
        code: 'noIsolatedRuntime',
        message: APP_WORK_NO_ISOLATED_RUNTIME_MESSAGE,
    };
}

/**
 * The dispatch `error` for a refusal: the stable code, then the member-facing copy — the shape
 * T11's FR-9 refusal uses (`no_commit_permission: …`), so a reader matches the code by prefix and
 * the board shows the sentence.
 */
export function describeAppWorkRunRefusal(admission: AppWorkRunRefusal): string {
    return `${admission.code}: ${admission.message}`;
}

// ── Site 2: the cloud worker's pre-flight ────────────────────────────────────

/**
 * What the cloud executor (`agent-task-execute`, the platform's in-process tool loop on a shared
 * worker) is, as the predicate's cloud branch reads it: NOT a pipeline plugin, and it enforces no
 * network policy. It holds platform credentials and reaches the network unfiltered, which is
 * exactly the place FR-12 says an App Work run must not execute.
 */
export const CLOUD_TASK_EXECUTOR_RUNTIME = Object.freeze({
    enforcesRuntimeNetworking: false,
} as const);

/**
 * T12 site 2 — the cloud worker asks this before it provisions anything. `null` = go on; a
 * string = the run's failure reason (`noIsolatedRuntime: …`).
 *
 * The worker IS the placement (`'cloud'`) and its runtime is {@link CLOUD_TASK_EXECUTOR_RUNTIME},
 * so every App Work run that reaches it is refused — however it got there (a router fallback, a
 * drained or resumed run, a dispatch path that skipped site 1). A review run is not a change and
 * passes, exactly as at site 1; every other kind passes untouched.
 */
export function appWorkCloudRunRefusal(input: {
    taskId: string;
    workId?: string | null;
    isAppWork: boolean;
    reviewRun: boolean;
}): string | null {
    if (!input.isAppWork || input.reviewRun) return null;
    const admission = isAppWorkRunAdmitted(
        { id: input.taskId, workId: input.workId ?? null },
        { placement: 'cloud', pipeline: CLOUD_TASK_EXECUTOR_RUNTIME, environmentNetworking: null },
    );
    return isAppWorkRunRefusal(admission) ? describeAppWorkRunRefusal(admission) : null;
}

// ── The port site 1 asks (bound API-side) ────────────────────────────────────

/**
 * The routing adapter's answer for one dispatch, before the job exists
 * (`AgentTaskExecuteDispatcher.previewPlacement`). `halted` = the platform's global stop flag is
 * set: the admission chain will PARK the run (`kill-switch`, a wait — FR-66), so site 1 must not
 * refuse it on a placement nobody could compute.
 */
export interface AppWorkRunPlacementPreview {
    placement: AppWorkRunPlacement;
    halted?: boolean;
    /** Fleet only: the node the job is pinned to (Agent ↔ node affinity), null = any eligible. */
    targetNodeId?: string | null;
    /** Fleet only: the capability tags the job will require (a node must advertise every one). */
    requiredCapabilities?: readonly string[];
}

/** What site 1 hands the gate: the Task, the Agent the run is for, and the placement preview. */
export interface AppWorkRunAdmissionInput {
    task: {
        id: string;
        userId: string;
        workId?: string | null;
        tenantId?: string | null;
        organizationId?: string | null;
    };
    agent: { id: string; userId: string; environmentId?: string | null };
    placement: AppWorkRunPlacementPreview;
}

/**
 * The port `TaskTransitionService` asks at site 1 (`@Optional() @Inject(APP_WORK_RUN_ADMISSION)`,
 * appended LAST). Unbound (a unit test, a runtime without the fleet graph) nothing is asked and
 * every dispatch is exactly as before. Bound by the API's `@Global()` `TasksModule`.
 */
export interface AppWorkRunAdmissionGate {
    /** `null` = the Task is not on an App Work (the gate read the Work itself). */
    admit(input: AppWorkRunAdmissionInput): Promise<AppWorkRunAdmission | null>;
}

export const APP_WORK_RUN_ADMISSION = Symbol('APP_WORK_RUN_ADMISSION');

/**
 * T48 — the reconciler's port: record what a Fleet run got on the run, App Work runs only. Bound
 * by the same API module; unbound, the reconciler records nothing (as before T48).
 */
export interface AppWorkRunContainmentRecorder {
    recordRunContainment(input: {
        taskId: string;
        runId: string;
        userId: string;
        nodeId: string | null;
        rawContainment: unknown;
    }): Promise<boolean>;
}

export const APP_WORK_RUN_CONTAINMENT_RECORDER = Symbol('APP_WORK_RUN_CONTAINMENT_RECORDER');

/** T48 / T27 — what `GET /api/tasks/:id/cost` adds for an App Work Task. */
export interface AppWorkTaskContainmentReader {
    describeForTask(task: {
        id: string;
        userId: string;
        workId?: string | null;
        agentId?: string | null;
    }): Promise<{
        containment: TaskRunContainmentView | null;
        containmentHolds: TaskRunContainmentView[];
    } | null>;
}

export const APP_WORK_TASK_CONTAINMENT_READER = Symbol('APP_WORK_TASK_CONTAINMENT_READER');

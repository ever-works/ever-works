/**
 * APW-04 T25 — the App provisioning card's view of `GET /api/works/:id/provisioning`
 * (`apps/api/src/works/work-evolve.controller.ts`), and the pure helpers the card and
 * its spec share. No I/O and no `server-only`: the client card imports it.
 *
 * The API answers the open and recent `app-provision` Tasks (provisioning runs on the
 * Task machinery), so a "step" here is the Task's own status, and the card links to the
 * Task for the run log and the pull request.
 */

/** One provisioning Task, as the route projects it. */
export interface AppProvisioningTaskView {
    taskId: string;
    taskSlug: string;
    title: string;
    /** The Task status (`backlog` · `todo` · `in_progress` · `in_review` · `blocked` · `done` · `cancelled`). */
    status: string;
    agentId: string | null;
    prUrl: string | null;
    prState: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    /** Why the Task was filed (`auto-create` · `manual` · `smoke-failed` · …), when the API could read it. */
    trigger?: string | null;
    /** The Task is held for the Work owner to press Run. */
    awaitingOwner?: boolean;
}

/** The whole read. */
export interface AppProvisioningState {
    active: AppProvisioningTaskView | null;
    recent: AppProvisioningTaskView[];
    canEdit: boolean;
    /** The newest open provisioning Task reacts to an upstream sync that broke the smoke tests. */
    upstreamSmokeBroken?: boolean;
    /** Why nothing was ever started: `blueprintSpec` (the Blueprint wrote the spec) · `autoProvisionOff`. */
    notStartedReason: 'blueprintSpec' | 'autoProvisionOff' | null;
    blueprintId?: string | null;
}

/** The card's one-line headline, as an i18n leaf under `appProvisioning.headline`. */
export type AppProvisioningHeadline =
    | 'notStarted'
    | 'blueprintSpec'
    | 'autoProvisionOff'
    | 'awaitingOwner'
    | 'queued'
    | 'running'
    | 'inReview'
    | 'blocked'
    | 'succeeded'
    | 'cancelled';

/** The statuses in which the card polls. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
    'backlog',
    'todo',
    'in_progress',
    'in_review',
    'blocked',
]);

/** Poll every 5 s while a provisioning Task is open (plan §5, ACC-04-26), never once it is terminal. */
export const APP_PROVISIONING_POLL_MS = 5_000;

/** A provisioning Task that is still open. */
export function isProvisioningActive(task: AppProvisioningTaskView | null | undefined): boolean {
    return !!task && ACTIVE_STATUSES.has(task.status);
}

/** The headline for a state. The newest Task decides once nothing is open. */
export function provisioningHeadline(state: AppProvisioningState | null): AppProvisioningHeadline {
    if (!state) return 'notStarted';
    const task = state.active ?? state.recent[0] ?? null;
    if (!task) {
        if (state.notStartedReason === 'blueprintSpec') return 'blueprintSpec';
        if (state.notStartedReason === 'autoProvisionOff') return 'autoProvisionOff';
        return 'notStarted';
    }
    if (isProvisioningActive(task) && task.awaitingOwner) return 'awaitingOwner';
    switch (task.status) {
        case 'backlog':
        case 'todo':
            return 'queued';
        case 'in_progress':
            return 'running';
        case 'in_review':
            return 'inReview';
        case 'blocked':
            return 'blocked';
        case 'done':
            return 'succeeded';
        case 'cancelled':
            return 'cancelled';
        default:
            return 'running';
    }
}

/** The i18n leaf for a trigger, or `null` for one the card has no copy for. */
export function provisioningTriggerKey(trigger: string | null | undefined): string | null {
    switch (trigger) {
        case 'auto-create':
            return 'autoCreate';
        case 'manual':
            return 'manual';
        case 'smoke-failed':
            return 'smokeFailed';
        case 'target-updated':
            return 'targetUpdated';
        case 'build-failed':
            return 'buildFailed';
        default:
            return null;
    }
}

/** The refusal codes of `POST provision` / `provision/cancel` the card has its own copy for. */
const KNOWN_REFUSALS: ReadonlySet<string> = new Set([
    'alreadyProvisioning',
    'nothingToCancel',
    'cancelRefused',
    'notAppWork',
    'not_found',
]);

/** The i18n leaf (under `appProvisioning.errors`) for a refusal code. */
export function provisioningRefusalKey(code: string | null | undefined): string {
    return code && KNOWN_REFUSALS.has(code)
        ? code.replace(/_(\w)/g, (_m, c) => c.toUpperCase())
        : 'failed';
}

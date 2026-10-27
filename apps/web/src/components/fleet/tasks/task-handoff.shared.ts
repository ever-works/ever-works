import type {
    FleetCheckoutCreateRequest,
    FleetHandoffCandidateAgent,
    FleetHandoffComputer,
    FleetHandoffNodeCheckouts,
    FleetHandoffReason,
    FleetHandoffTask,
    FleetSessionStartRequest,
    FleetTaskHandoffOptions,
} from '@ever-works/contracts';

/**
 * Tasks on computers (FL-15 P1) — the dialog's pure half: which computer it
 * starts on, which checkout choice it offers, what the start request and the
 * checkout create request are. The eligibility itself is the platform's
 * (`judgeFleetHandoffComputer` in `@ever-works/contracts`, the same rules the
 * start path refuses by); this file only reads its verdicts.
 */

/** `fleet.taskHandoff.reasons.<key>` for each closed-set reason (spec FR-2). */
export const HANDOFF_REASON_KEYS: Readonly<Record<FleetHandoffReason, string>> = {
    offline: 'offline',
    'needs-work': 'needsWork',
    'missing-cli': 'missingCli',
    'no-slot': 'noSlot',
    'not-pinned': 'notPinned',
    'kill-switch': 'killSwitch',
    'no-access': 'noAccess',
};

/** `fleet.sessions.providers.<key>` for an Agent CLI. */
export function cliKey(cli: FleetHandoffCandidateAgent['cli']): 'claudeCode' | 'codex' {
    return cli === 'codex' ? 'codex' : 'claudeCode';
}

/**
 * The computer the dialog starts on (FR-3): the pinned one when it is
 * selectable, else the first selectable one (the list arrives ordered:
 * pinned, selectable, online, by name), else none.
 */
export function initialComputerId(computers: readonly FleetHandoffComputer[]): string | null {
    const pinned = computers.find((row) => row.pinned && row.selectable);
    if (pinned) return pinned.nodeId;
    return computers.find((row) => row.selectable)?.nodeId ?? null;
}

/** True when no computer can take the Task (U1: Start disabled, the cloud run offered). */
export function nothingSelectable(computers: readonly FleetHandoffComputer[]): boolean {
    return !computers.some((row) => row.selectable);
}

/** The checkout the person picked. */
export type HandoffCheckoutChoice =
    | { mode: 'worktree'; parentCheckoutId: string }
    | { mode: 'existing'; checkoutId: string }
    | { mode: 'clone' }
    | { mode: 'none' };

/**
 * The choice a computer's checkout step starts on (FR-5, U7). A checkout
 * already on the Task's branch (an earlier session's worktree) is reused as
 * it is — FL-06's Task-branch reuse: a second worktree would get a suffixed
 * branch from FL-14's never-reuse rule and leave the Task's own branch.
 */
export function initialCheckoutChoice(
    step: FleetHandoffNodeCheckouts | undefined,
    task: Pick<FleetHandoffTask, 'repoUrl'> & { branch?: string | null },
): HandoffCheckoutChoice {
    if (!step) return task.repoUrl ? { mode: 'clone' } : { mode: 'none' };
    const onTaskBranch = task.branch
        ? step.matching.find((row) => row.branch === task.branch)
        : undefined;
    if (onTaskBranch) return { mode: 'existing', checkoutId: onTaskBranch.checkoutId };
    const firstMatching = step.matching[0];
    const firstOther = step.others[0];
    switch (step.defaultMode) {
        case 'worktree':
            if (firstMatching)
                return { mode: 'worktree', parentCheckoutId: firstMatching.checkoutId };
            break;
        case 'existing': {
            const existing = firstMatching ?? firstOther;
            if (existing) return { mode: 'existing', checkoutId: existing.checkoutId };
            break;
        }
        case 'clone':
            if (task.repoUrl) return { mode: 'clone' };
            break;
        default:
            break;
    }
    return task.repoUrl ? { mode: 'clone' } : { mode: 'none' };
}

/** Is this choice one the computer's checkout step still offers (the computer changed under it)? */
export function choiceStillOffered(
    choice: HandoffCheckoutChoice,
    step: FleetHandoffNodeCheckouts | undefined,
    task: Pick<FleetHandoffTask, 'repoUrl'>,
): boolean {
    switch (choice.mode) {
        case 'worktree':
            return !!step?.matching.some((row) => row.checkoutId === choice.parentCheckoutId);
        case 'existing':
            return !!(
                step?.matching.some((row) => row.checkoutId === choice.checkoutId) ||
                step?.others.some((row) => row.checkoutId === choice.checkoutId)
            );
        case 'clone':
            return !!task.repoUrl;
        default:
            return true;
    }
}

/**
 * The FL-14 create request a choice needs first (a new worktree on the Task's
 * branch, or a fresh clone), or null when the session starts in an existing
 * checkout or the home folder.
 */
export function checkoutCreateRequest(
    nodeId: string,
    choice: HandoffCheckoutChoice,
    task: Pick<FleetHandoffTask, 'repoUrl' | 'branch'>,
): FleetCheckoutCreateRequest | null {
    if (choice.mode === 'worktree') {
        return {
            nodeId,
            source: { kind: 'worktree', parentCheckoutId: choice.parentCheckoutId },
            ...(task.branch ? { branch: task.branch } : {}),
        };
    }
    if (choice.mode === 'clone' && task.repoUrl) {
        return {
            nodeId,
            source: { kind: 'clone', repoUrl: task.repoUrl },
            ...(task.branch ? { branch: task.branch } : {}),
        };
    }
    return null;
}

/** The FL-04 start request with the Task named (spec FR-6). `checkout` is the folder it starts in. */
export function handoffStartRequest(input: {
    taskId: string;
    agent: Pick<FleetHandoffCandidateAgent, 'id' | 'cli'>;
    firstMessage: string;
    checkout: { id: string; path: string } | null;
}): FleetSessionStartRequest {
    return {
        kind: 'agent',
        provider: input.agent.cli,
        agentId: input.agent.id,
        taskId: input.taskId,
        firstMessage: input.firstMessage,
        cwd: input.checkout?.path ?? '~',
        ...(input.checkout ? { checkoutId: input.checkout.id } : {}),
    };
}

/** The candidate the dialog judges computers for. */
export function selectedAgent(options: FleetTaskHandoffOptions): FleetHandoffCandidateAgent | null {
    return (
        options.agents.find((agent) => agent.id === options.agentId) ?? options.agents[0] ?? null
    );
}

/** How long the dialog waits for the daemon before it says so (spec U9). */
export const HANDOFF_ACK_WAIT_MS = 40_000;

/** How long it waits for a new checkout to become ready. */
export const HANDOFF_CHECKOUT_WAIT_MS = 120_000;

/** Poll interval for both waits. */
export const HANDOFF_POLL_MS = 2_000;

/**
 * Security (prompt-injection hardening) — per-call confirmation predicates
 * for the docked assistant's privileged generated tools.
 *
 * Most privileged writes are gated on every call (`requiresConfirmation`).
 * Two are gated only when the call actually does the privileged thing, so
 * the everyday use stays one step:
 *
 *  - `update_agent` — renaming an agent is cosmetic; changing its model,
 *    capabilities, permissions, targets or cadence changes what it can do.
 *  - `post_task_chat` / `edit_task_chat_message` — a plain comment is just a
 *    comment; an `@mention` wakes an agent (or pings a person) on the
 *    strength of text the assistant wrote, possibly at a tool result's urging.
 */

/** Agent fields that only change how the agent LOOKS. Anything else is privileged. */
const COSMETIC_AGENT_FIELDS = new Set(['name', 'title', 'avatar', 'avatarMode', 'avatarIcon']);

function bodyOf(args: Record<string, unknown>): Record<string, unknown> | null {
    const body = args.body;
    return body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
}

/** True when an agent update touches anything beyond its display fields. */
export function touchesAgentPrivileges(args: Record<string, unknown>): boolean {
    const body = bodyOf(args);
    if (!body) return false;
    return Object.keys(body).some((key) => !COSMETIC_AGENT_FIELDS.has(key));
}

/**
 * The platform's own task-chat mention grammar (`MENTION_RE` in
 * `packages/agent/src/tasks-domain/task-chat.service.ts`): `@slug` anywhere,
 * no word-start requirement — so `x@builder-bot` and an e-mail address
 * count too. Over-asking costs one click; under-asking wakes an agent.
 * Case-insensitive here so an upper-case mention cannot slip past.
 */
const MENTION_RE = /@([a-z0-9-]{1,80})\b/i;

function containsMention(value: unknown, depth = 0): boolean {
    if (depth > 4 || value === null || value === undefined) return false;
    if (typeof value === 'string') return MENTION_RE.test(value);
    if (Array.isArray(value)) return value.some((item) => containsMention(item, depth + 1));
    if (typeof value === 'object') {
        return Object.values(value as Record<string, unknown>).some((item) =>
            containsMention(item, depth + 1),
        );
    }
    return false;
}

/** True when a task-chat post / edit body @mentions someone. */
export function mentionsSomeone(args: Record<string, unknown>): boolean {
    return containsMention(bodyOf(args));
}

// ── Tasks (works-security, 2026-10-18) ──────────────────────────────────────

/**
 * Task body fields the assistant may set without asking: what the Task is
 * about and where it sits. Every field here is descriptive — none of them
 * starts work, decides a gate or names a command.
 */
export const TASK_CREATE_ALLOWED_FIELDS: readonly string[] = Object.freeze([
    'title',
    'description',
    'priority',
    'status',
    'labels',
    'missionId',
    'ideaId',
    'workId',
    'parentTaskId',
    'dueAt',
    'startAt',
    'estimateMinutes',
]);

/** Same as {@link TASK_CREATE_ALLOWED_FIELDS} for an update (the update DTO has no `status`). */
export const TASK_UPDATE_ALLOWED_FIELDS: readonly string[] = Object.freeze([
    'title',
    'description',
    'priority',
    'labels',
    'missionId',
    'ideaId',
    'workId',
    'parentTaskId',
    'dueAt',
    'startAt',
    'estimateMinutes',
]);

/**
 * Task controls: they decide what a run executes or when one starts without a
 * person. `acceptanceChecks` are shell commands a fleet node runs with
 * `shell: true` (`phase: 'setup'` before the model); `agentId` / `scheduledAt`
 * pick who runs and when; `requireAllApprovers: false` turns the `→ done`
 * approver gate off; `extraRepos`, `isolationMode` and `maxGateAttempts` shape
 * the run; `teamId` / `goalId` route the Task into automation. All stay
 * settable from chat, behind the user's confirmation.
 */
export const TASK_PRIVILEGED_FIELDS: readonly string[] = Object.freeze([
    'acceptanceChecks',
    'requireAllApprovers',
    'extraRepos',
    'isolationMode',
    'maxGateAttempts',
    'scheduledAt',
    'agentId',
    'teamId',
    'goalId',
]);

/** Statuses a NEW Task may be filed in without asking (nothing has started). */
const NOT_STARTED_TASK_STATUSES = new Set(['backlog', 'todo']);

/** `create_task`: confirm when the Task would be born already started. */
export function createsStartedTask(args: Record<string, unknown>): boolean {
    const status = bodyOf(args)?.status;
    return (
        status !== undefined && status !== null && !NOT_STARTED_TASK_STATUSES.has(String(status))
    );
}

/**
 * `update_task`: a label write REPLACES the list, and some labels are control
 * signals (`awaiting-owner` holds a Task filed from an untrusted email until
 * its owner starts it; `release:*` forces a recorded human approval). The
 * assistant cannot see which labels a write drops without reading the Task,
 * so a label change is the user's call.
 */
export function changesTaskLabels(args: Record<string, unknown>): boolean {
    return bodyOf(args)?.labels !== undefined;
}

/**
 * Statuses a move into may start work without asking anyone else:
 *  - `in_progress` fans out to every assigned Agent (paid runs);
 *  - `in_review` plans reviewer-agent runs;
 *  - `done` / `cancelled` release dependents, which can restore them to
 *    `in_progress` and start their Agents.
 * `backlog`, `todo` and `blocked` start nothing.
 */
const DISPATCHING_TASK_STATUSES = new Set(['in_progress', 'in_review', 'done', 'cancelled']);

/** `transition_task`: confirm a move that can start runs, or any forced move. */
export function startsTaskWork(args: Record<string, unknown>): boolean {
    const body = bodyOf(args);
    if (!body) return false;
    if (body.force === true) return true;
    const to = body.to ?? body.status;
    return to !== undefined && to !== null && DISPATCHING_TASK_STATUSES.has(String(to));
}

// ── Outbound destinations (works-security, 2026-10-18) ───────────────────────

/** `update_webhook`: confirm when the call moves where (or what) the webhook delivers. */
export function redirectsWebhook(args: Record<string, unknown>): boolean {
    const body = bodyOf(args);
    return Boolean(
        body && (body.url !== undefined || body.events !== undefined || body.secret !== undefined),
    );
}

/** `update_notification_channel`: confirm when the call changes the channel's destination config. */
export function redirectsNotificationChannel(args: Record<string, unknown>): boolean {
    const body = bodyOf(args);
    return Boolean(body && body.config !== undefined);
}

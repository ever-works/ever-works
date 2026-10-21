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

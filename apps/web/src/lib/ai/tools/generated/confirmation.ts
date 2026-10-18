import { getToolName, isToolUIPart, type UIMessage } from 'ai';

/**
 * Security (prompt-injection hardening) — WHO confirmed a gated tool call,
 * and WHAT exactly they confirmed.
 *
 * The confirmation handshake used to trust the model alone: a gated tool ran
 * as soon as the model passed `confirmed: true`. The same turn can contain
 * tool output the user never wrote (an email, an ingested event, a KB
 * document, another person's task-chat message), and text in that output can
 * tell the model to pass `confirmed: true` straight away.
 *
 * A model-supplied `confirmed: true` is therefore honoured only when ALL hold:
 *
 *  1. the assistant message right before the user's latest message showed a
 *     confirmation card (`__confirmationRequired`) for THIS tool;
 *  2. the call's arguments are the card's arguments (the card is what the
 *     user saw — confirming `update_agent` on `a1` does not allow `a2`);
 *  3. the user's latest message — which no tool output can change — is
 *     either the card's Confirm-button message naming that tool AND that
 *     card's call id, or a bare affirmative and nothing else ("yes", "ok",
 *     "go ahead") while exactly one card is waiting;
 *  4. the card has not been used yet in this turn (single use).
 *
 * Anything else re-shows the card, so a refused call costs the user one
 * click, never a dead end.
 */

/** One confirmation card the user was shown. */
export interface PendingConfirmation {
    toolName: string;
    target?: string;
    args: Record<string, unknown>;
    /** The tool call that produced the card — the Confirm button names it. */
    toolCallId?: string;
}

export type UserConfirmationCheck = (toolName: string, args: Record<string, unknown>) => boolean;

/** A typed confirmation longer than this is not a bare affirmative (and is never regex-scanned). */
const MAX_AFFIRMATIVE_LENGTH = 64;

/**
 * The WHOLE message must be one of these, optionally followed by
 * whitespace / `.` / `!`. One trailing character class — no adjacent
 * `\s*` / `[.!]*` / `\s*` runs that backtrack quadratically on long input.
 */
const AFFIRMATIVE_RE = /^\s*(?:yes|y|ok|okay|sure|confirm(?:ed)?|go ahead|do it)[\s.!]*$/i;

/** The Confirm button's text is short; anything longer is not it. */
const MAX_CARD_TEXT_LENGTH = 512;

/**
 * Exactly what `ConfirmCard`'s Confirm button sends:
 * `Yes, I confirm — proceed with <tool>[ for <target>] (confirmed: true, card <toolCallId>).`
 * (the `, card …` part is absent only for cards without a call id).
 */
const CARD_CONFIRM_RE =
    /^\s*Yes, I confirm — proceed with ([A-Za-z][A-Za-z0-9_]{0,79})(?: for ([^\n]{1,200}?))? \(confirmed: true(?:, card ([A-Za-z0-9_-]{1,100}))?\)\.\s*$/;

/** Same sanitizing the Confirm button applies to the call id it embeds. */
export function sanitizeCardId(raw: string | undefined): string {
    return (raw ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
}

/** Mirrors `sanitizeConfirmRef` in `ChatToolResult` so card targets compare equal. */
function sanitizeRef(raw: string | undefined): string {
    if (!raw) return '';
    return raw
        .replace(/\(\s*confirmed\s*:[^)]*\)/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Canonical JSON (sorted keys, `confirmed` dropped at the top level). */
function canonical(value: unknown, top = true): string {
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item, false)).join(',')}]`;
    if (isRecord(value)) {
        const keys = Object.keys(value)
            .filter((key) => !(top && key === 'confirmed') && value[key] !== undefined)
            .sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key], false)}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

function textOf(message: UIMessage): string {
    return message.parts
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join(' ');
}

/** Text of the latest user message (the turn that started this call). */
export function latestUserText(messages: UIMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') return textOf(messages[i]);
    }
    return '';
}

/**
 * The confirmation cards the assistant showed in its message right before
 * the user's latest message — the only cards the latest message can answer.
 */
export function pendingConfirmationsFrom(messages: UIMessage[]): PendingConfirmation[] {
    let i = messages.length - 1;
    while (i >= 0 && messages[i].role !== 'user') i--;
    for (i -= 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role === 'user') return [];
        if (message.role !== 'assistant') continue;
        const pending: PendingConfirmation[] = [];
        for (const part of message.parts) {
            if (!isToolUIPart(part) || part.state !== 'output-available') continue;
            const output = part.output;
            if (!isRecord(output) || output.__confirmationRequired !== true) continue;
            const partTool = getToolName(part);
            // A card only counts for the tool that actually produced it.
            if (!partTool || (output.toolName !== undefined && output.toolName !== partTool))
                continue;
            pending.push({
                toolName: partTool,
                target: typeof output.target === 'string' ? output.target : undefined,
                args: isRecord(output.args) ? output.args : {},
                toolCallId: sanitizeCardId(part.toolCallId) || undefined,
            });
        }
        return pending;
    }
    return [];
}

/**
 * Build the per-turn check. Returns a function the tools call with the
 * name and arguments of a `confirmed: true` call; `true` consumes the
 * matching card.
 */
export function createUserConfirmationCheck(input: {
    latestUserText: string | null | undefined;
    pending: PendingConfirmation[];
}): UserConfirmationCheck {
    const text = (input.latestUserText ?? '').trim();
    const pending = input.pending ?? [];
    if (!text || pending.length === 0) return () => false;

    const card = text.length <= MAX_CARD_TEXT_LENGTH ? CARD_CONFIRM_RE.exec(text) : null;
    const affirmative = !card && text.length <= MAX_AFFIRMATIVE_LENGTH && AFFIRMATIVE_RE.test(text);
    if (!card && !affirmative) return () => false;
    // A bare "yes" is only unambiguous when exactly ONE card is waiting.
    if (affirmative && pending.length !== 1) return () => false;
    const cardTool = card ? card[1] : null;
    const cardTarget = card?.[2] ? sanitizeRef(card[2]) : null;
    const cardId = card?.[3] ?? null;
    // A Confirm text without a call id (older client) is only unambiguous
    // when exactly one card for that tool is waiting.
    if (card && !cardId && pending.filter((entry) => entry.toolName === cardTool).length !== 1) {
        return () => false;
    }

    const used = new Set<number>();
    return (toolName, args) => {
        if (cardTool && cardTool !== toolName) return false;
        const wanted = canonical(args ?? {});
        const index = pending.findIndex(
            (entry, i) =>
                !used.has(i) &&
                entry.toolName === toolName &&
                (cardId === null || entry.toolCallId === cardId) &&
                (cardTarget === null || sanitizeRef(entry.target) === cardTarget) &&
                canonical(entry.args) === wanted,
        );
        if (index < 0) return false;
        used.add(index);
        return true;
    };
}

/** Convenience: the check for a whole UI history (latest user turn + the cards before it). */
export function createUserConfirmationCheckFromMessages(
    messages: UIMessage[],
): UserConfirmationCheck {
    return createUserConfirmationCheck({
        latestUserText: latestUserText(messages),
        pending: pendingConfirmationsFrom(messages),
    });
}

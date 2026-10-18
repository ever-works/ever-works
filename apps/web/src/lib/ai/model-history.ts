import { convertToModelMessages, type ToolSet, type UIMessage } from 'ai';

/**
 * Security (prompt-injection hardening): the UI history replayed to the model
 * on every turn carries earlier tool results (emails, events, KB text …).
 * Converting WITHOUT the tool set sends those results raw; with it, every
 * replayed result goes through its tool's `toModelOutput` — the same
 * nonce-fenced untrusted view the model got the first time.
 *
 * Pass the FULL tool set (not only this turn's active subset): an earlier
 * turn may have used a tool that is gated out of this one.
 */
export async function toModelHistory(messages: UIMessage[], tools: ToolSet) {
    return convertToModelMessages(messages, { tools });
}

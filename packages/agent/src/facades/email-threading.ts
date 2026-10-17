import { randomUUID } from 'node:crypto';
import { normalizeMessageId, parseMessageIdList } from '@ever-works/plugin';

/*
 * EW-P4-3 — RFC threading helpers for outbound email. A LEAF module (only
 * `@ever-works/plugin` and `node:crypto`), so specs that stub the facades
 * barrel can still load the real functions.
 */

/**
 * EW-P4-3 — the RFC threading fields of one message, as stored on
 * `email_messages` (bare ids, see `normalizeMessageId`).
 */
export interface EmailThreadingFields {
    readonly messageIdHeader: string | null;
    readonly inReplyTo: string | null;
    readonly references: string[] | null;
}

/** RFC 5322 field-name: printable ASCII except `:` (and no space). */
const HEADER_NAME = /^[!-9;-~]+$/;

/**
 * EW-P4-3 — the header map that goes to the provider: the caller's headers
 * minus anything that could inject a header (a CR/LF in a name or value, an
 * illegal name), plus a `Message-ID` when the caller set none.
 *
 * The generated id is `<uuid@domain-of-from>` — unique, and on the sending
 * domain as RFC 5322 §3.6.4 recommends — so a reply's `In-Reply-To` can be
 * matched back to this message.
 */
export function buildOutboundHeaders(
    from: string,
    headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
        if (typeof value !== 'string' || !HEADER_NAME.test(name)) continue;
        if (/[\r\n]/.test(value)) continue;
        out[name] = value;
    }
    const hasMessageId = Object.keys(out).some((name) => name.toLowerCase() === 'message-id');
    if (!hasMessageId) {
        const at = from.lastIndexOf('@');
        const domain =
            at === -1
                ? ''
                : from
                      .slice(at + 1)
                      .trim()
                      .replace(/[>\s]/g, '');
        out['Message-ID'] = `<${randomUUID()}@${domain || 'ever.works'}>`;
    }
    return out;
}

/** EW-P4-3 — the threading columns a set of outbound headers implies. */
export function threadingFieldsOf(headers: Readonly<Record<string, string>>): EmailThreadingFields {
    const read = (wanted: string): string | undefined => {
        for (const [name, value] of Object.entries(headers)) {
            if (name.toLowerCase() === wanted) return value;
        }
        return undefined;
    };
    const references = parseMessageIdList(read('references'));
    return {
        messageIdHeader: normalizeMessageId(read('message-id')) ?? null,
        inReplyTo: parseMessageIdList(read('in-reply-to'))[0] ?? null,
        references: references.length > 0 ? references : null,
    };
}

/**
 * EW-P4-3 — the `In-Reply-To` / `References` headers of a reply to `parent`
 * (RFC 5322 §3.6.4): `In-Reply-To` is the parent's id, `References` the
 * parent's `References` (or its `In-Reply-To`) followed by the parent's id.
 * Empty when the parent has no `Message-ID` on record — nothing to thread on.
 */
export function replyHeadersFor(parent: {
    messageIdHeader?: string | null;
    inReplyTo?: string | null;
    references?: readonly string[] | null;
}): Record<string, string> {
    const parentId = normalizeMessageId(parent.messageIdHeader);
    if (!parentId) return {};
    const chain = parent.references?.length
        ? [...parent.references]
        : parent.inReplyTo
          ? [parent.inReplyTo]
          : [];
    const references = parseMessageIdList([...chain, parentId].map((id) => `<${id}>`));
    return {
        'In-Reply-To': `<${parentId}>`,
        References: references.map((id) => `<${id}>`).join(' '),
    };
}

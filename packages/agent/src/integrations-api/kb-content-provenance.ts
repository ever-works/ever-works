/**
 * Works-security lane (integration API gates, finding 2) — who wrote a
 * Knowledge Base document's CURRENT content, when it came through the
 * integration API.
 *
 * An accepted document feeds every later agent prompt, so accepting is the M7
 * review gate. The integration API lets a key relay a person's review decision
 * (`POST /kb/documents/:id/accept` with `X-Act-As-User`); it must not let a key
 * accept content no person stands behind — content the key itself wrote while
 * acting as itself (no `X-Act-As-User`). The document row records its writer
 * only as a user id (`updatedById` = the key's OWNER for a key-only write,
 * indistinguishable from the owner's own edit), so the integration API stamps
 * this marker into the document's free-form `metadata` column on every content
 * write it makes, and the Knowledge Base clears it on every other content write
 * (a person's edit in the app supersedes it). No schema change: `metadata` is
 * the entity's documented extension dict (it already carries `body`).
 *
 * Never read from a request body: only the integration controllers build it,
 * from the authenticated principal.
 */

/** The key under `work_knowledge_documents.metadata`. */
export const KB_LAST_CONTENT_WRITE_KEY = 'lastContentWrite';

export interface KbContentWrite {
    /** Only the integration API stamps the marker today. */
    principal: 'integration';
    integrationKeyId: string;
    integrationKind: string | null;
    /** The person the write was relayed for (`X-Act-As-User`), or `null`: the key acting as itself. */
    actAsUserId: string | null;
    /** ISO timestamp of the write. */
    at: string;
}

/** The marker an integration content write carries. */
export function integrationContentWrite(input: {
    keyId: string;
    integrationKind?: string | null;
    actAsUserId: string | null;
    now?: Date;
}): KbContentWrite {
    return {
        principal: 'integration',
        integrationKeyId: input.keyId,
        integrationKind: input.integrationKind ?? null,
        actAsUserId: input.actAsUserId ?? null,
        at: (input.now ?? new Date()).toISOString(),
    };
}

/** The marker on a document's `metadata`, or `null` (none, or not one this module wrote). */
export function lastContentWriteOf(metadata: unknown): KbContentWrite | null {
    if (!metadata || typeof metadata !== 'object') return null;
    const raw = (metadata as Record<string, unknown>)[KB_LAST_CONTENT_WRITE_KEY];
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as Record<string, unknown>;
    if (entry.principal !== 'integration' || typeof entry.integrationKeyId !== 'string') {
        return null;
    }
    return {
        principal: 'integration',
        integrationKeyId: entry.integrationKeyId,
        integrationKind: typeof entry.integrationKind === 'string' ? entry.integrationKind : null,
        actAsUserId: typeof entry.actAsUserId === 'string' ? entry.actAsUserId : null,
        at: typeof entry.at === 'string' ? entry.at : '',
    };
}

/**
 * Whether a document's current content was written by an integration key
 * acting as ITSELF (no person behind it).
 *
 * The marker decides when present. A document written before the marker
 * existed falls back to the row's own provenance: a key-only create landed
 * `source: 'imported'` + `reviewState: 'proposed'` (a person's upload is
 * `imported` too, but is `accepted` from birth), so that pair still counts as
 * key-authored.
 */
export function isKeyAuthoredContent(doc: {
    metadata?: unknown;
    source?: string | null;
    reviewState?: string | null;
}): boolean {
    const marker = lastContentWriteOf(doc.metadata);
    if (marker) return marker.actAsUserId === null;
    return doc.source === 'imported' && doc.reviewState === 'proposed';
}

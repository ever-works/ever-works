/**
 * Typed PostHog event surface for the Knowledge Base feature.
 *
 * EW-643 Phase 3 — backs spec.md §23 "Telemetry". Every KB user action that
 * the product team needs to measure flows through this module so that:
 *
 *  1. The set of event names is enumerated in ONE place (so the analytics
 *     team's funnel queries don't break the moment someone renames a string
 *     literal in a controller).
 *  2. Properties are statically typed (the compiler refuses payloads with
 *     unknown / missing required fields, eliminating the "dashboard quietly
 *     went blank because a property changed" failure mode).
 *  3. **Body content can never leak.** See the spec's privacy / NN #22 rule:
 *     no KB document body, snippet, or citation excerpt is allowed in any
 *     telemetry event. Every payload here is shapes + counts + identifiers
 *     only. The companion script `scripts/ci/no-kb-body-in-events.sh` runs
 *     as a CI gate and greps the call sites in this file (and the rest of
 *     the codebase) for any property whose key matches a body-ish pattern.
 *
 * Consumers call `emitKbEvent(client, 'kb.document.created', { ... })`.
 * `client` is the PostHog client returned by `getPostHogClient()` (kept as
 * a parameter so this module stays test-friendly — pass a no-op client in
 * unit tests, the real one in production).
 */

export const KB_EVENT_KIND = {
    WORKBENCH_OPENED: 'kb.workbench.opened',
    DOCUMENT_CREATED: 'kb.document.created',
    DOCUMENT_UPDATED: 'kb.document.updated',
    DOCUMENT_DELETED: 'kb.document.deleted',
    DOCUMENT_LOCKED: 'kb.document.locked',
    DOCUMENT_UNLOCKED: 'kb.document.unlocked',
    DOCUMENT_RESTORED: 'kb.document.restored',
    DOCUMENT_LOCK_VIOLATION: 'kb.document.lock_violation',
    UPLOAD_STARTED: 'kb.upload.started',
    UPLOAD_EXTRACTED: 'kb.upload.extracted',
    UPLOAD_TRANSCRIBED: 'kb.upload.transcribed',
    UPLOAD_DEDUPED: 'kb.upload.deduped',
    UPLOAD_TOMBSTONED: 'kb.upload.tombstoned',
    UPLOAD_REVIVED: 'kb.upload.revived',
    SEARCH_EXECUTED: 'kb.search.executed',
    AI_MESSAGE_SENT: 'kb.ai.message_sent',
    CONTEXT_INJECTED: 'kb.context.injected',
    CONTEXT_TRUNCATED: 'kb.context.truncated',
    RECONCILE_COMPLETED: 'kb.reconcile.completed',
} as const;

export type KbEventKind = (typeof KB_EVENT_KIND)[keyof typeof KB_EVENT_KIND];

/**
 * Document class union — mirrors `packages/contracts/src/kb/kb-document-class.ts`
 * but redeclared here so this module stays dependency-free (the monitoring
 * package must not import contracts; it's loaded by API + web + workers).
 */
export type KbDocumentClassTelemetry =
    | 'brand'
    | 'legal'
    | 'glossary'
    | 'style'
    | 'seo'
    | 'personas'
    | 'competitors'
    | 'research'
    | 'output'
    | 'freeform';

export type KbDocumentSource = 'user' | 'upload' | 'agent' | 'inherited' | 'cli' | 'mcp';

/** Coarse MIME family for upload events — picked because page-by-page leakage isn't possible from a category. */
export type KbMimeFamily =
    | 'pdf'
    | 'doc'
    | 'sheet'
    | 'slide'
    | 'image'
    | 'video'
    | 'audio'
    | 'text'
    | 'html'
    | 'other';

export type KbActorType = 'user' | 'agent' | 'cli' | 'mcp' | 'system';

interface KbBase {
    workId: string;
    actorType: KbActorType;
}

export interface KbWorkbenchOpenedProps extends KbBase {
    hasOriginals: boolean;
    hasDocuments: boolean;
}
export interface KbDocumentCreatedProps extends KbBase {
    documentClass: KbDocumentClassTelemetry;
    source: KbDocumentSource;
    tagCount: number;
}
export interface KbDocumentUpdatedProps extends KbBase {
    documentClass: KbDocumentClassTelemetry;
    source: KbDocumentSource;
    bytesDelta: number;
}
export interface KbDocumentDeletedProps extends KbBase {
    documentClass: KbDocumentClassTelemetry;
}
export interface KbDocumentLockedProps extends KbBase {
    documentClass: KbDocumentClassTelemetry;
    lockMode: 'full' | 'additions-only';
}
export type KbDocumentUnlockedProps = KbBase & { documentClass: KbDocumentClassTelemetry };
export interface KbDocumentRestoredProps extends KbBase {
    documentClass: KbDocumentClassTelemetry;
    fromCommitShaPrefix: string;
}
export interface KbDocumentLockViolationProps extends KbBase {
    documentClass: KbDocumentClassTelemetry;
    lockMode: 'full' | 'additions-only';
    detectedBy: 'reconcile' | 'preReceive';
}
export interface KbUploadStartedProps extends KbBase {
    mimeFamily: KbMimeFamily;
    byteSize: number;
}
export interface KbUploadExtractedProps extends KbBase {
    mimeFamily: KbMimeFamily;
    extractionPluginId: string;
    durationBucketMs: 100 | 500 | 1000 | 5000 | 30_000 | 120_000 | 600_000;
    success: boolean;
}
export interface KbUploadTranscribedProps extends KbBase {
    mimeFamily: KbMimeFamily;
    transcriptionProviderId: string;
    durationSecondsBucket: 10 | 60 | 300 | 1800 | 7200;
    success: boolean;
}
export interface KbUploadDedupedProps extends KbBase {
    mimeFamily: KbMimeFamily;
}
export interface KbUploadTombstonedProps extends KbBase {
    mimeFamily: KbMimeFamily;
    graceDays: number;
}
export interface KbUploadRevivedProps extends KbBase {
    mimeFamily: KbMimeFamily;
}
export interface KbSearchExecutedProps extends KbBase {
    hitCount: number;
    usedSemantic: boolean;
    durationBucketMs: 50 | 100 | 250 | 500 | 1000 | 5000;
}
export interface KbAiMessageSentProps extends KbBase {
    mentionCount: number;
    pipelinePluginId: string;
}
export interface KbContextInjectedProps extends KbBase {
    chunkCount: number;
    tokensUsed: number;
    pipelinePluginId: string;
}
export interface KbContextTruncatedProps extends KbBase {
    requestedTokens: number;
    budgetTokens: number;
    droppedClasses: KbDocumentClassTelemetry[];
}
export interface KbReconcileCompletedProps extends KbBase {
    scanned: number;
    driftCount: number;
    violationCount: number;
    orphanCount: number;
    tombstonedCount: number;
    revivedCount: number;
    durationMs: number;
}

export type KbEventPayload =
    | { kind: typeof KB_EVENT_KIND.WORKBENCH_OPENED; props: KbWorkbenchOpenedProps }
    | { kind: typeof KB_EVENT_KIND.DOCUMENT_CREATED; props: KbDocumentCreatedProps }
    | { kind: typeof KB_EVENT_KIND.DOCUMENT_UPDATED; props: KbDocumentUpdatedProps }
    | { kind: typeof KB_EVENT_KIND.DOCUMENT_DELETED; props: KbDocumentDeletedProps }
    | { kind: typeof KB_EVENT_KIND.DOCUMENT_LOCKED; props: KbDocumentLockedProps }
    | { kind: typeof KB_EVENT_KIND.DOCUMENT_UNLOCKED; props: KbDocumentUnlockedProps }
    | { kind: typeof KB_EVENT_KIND.DOCUMENT_RESTORED; props: KbDocumentRestoredProps }
    | { kind: typeof KB_EVENT_KIND.DOCUMENT_LOCK_VIOLATION; props: KbDocumentLockViolationProps }
    | { kind: typeof KB_EVENT_KIND.UPLOAD_STARTED; props: KbUploadStartedProps }
    | { kind: typeof KB_EVENT_KIND.UPLOAD_EXTRACTED; props: KbUploadExtractedProps }
    | { kind: typeof KB_EVENT_KIND.UPLOAD_TRANSCRIBED; props: KbUploadTranscribedProps }
    | { kind: typeof KB_EVENT_KIND.UPLOAD_DEDUPED; props: KbUploadDedupedProps }
    | { kind: typeof KB_EVENT_KIND.UPLOAD_TOMBSTONED; props: KbUploadTombstonedProps }
    | { kind: typeof KB_EVENT_KIND.UPLOAD_REVIVED; props: KbUploadRevivedProps }
    | { kind: typeof KB_EVENT_KIND.SEARCH_EXECUTED; props: KbSearchExecutedProps }
    | { kind: typeof KB_EVENT_KIND.AI_MESSAGE_SENT; props: KbAiMessageSentProps }
    | { kind: typeof KB_EVENT_KIND.CONTEXT_INJECTED; props: KbContextInjectedProps }
    | { kind: typeof KB_EVENT_KIND.CONTEXT_TRUNCATED; props: KbContextTruncatedProps }
    | { kind: typeof KB_EVENT_KIND.RECONCILE_COMPLETED; props: KbReconcileCompletedProps };

/** Minimal PostHog client surface required by the emitter — kept narrow so callers can pass mocks. */
export interface PostHogCaptureClient {
    capture: (input: {
        distinctId: string;
        event: string;
        properties?: Record<string, unknown>;
    }) => void;
}

const FORBIDDEN_KEY_PATTERN =
    /^(body|content|markdown|text|html|excerpt|snippet|chunk|raw|preview)$/i;

/**
 * Defensive guard. PostHog will happily ingest whatever we send, so a single
 * sloppy caller could leak proprietary KB content into a third-party sink.
 * This narrows the door: any property key matching FORBIDDEN_KEY_PATTERN is
 * stripped in dev (with a console.warn) and throws in test (so CI fails
 * loudly). In production the field is stripped silently — surface-area for a
 * runtime throw is too high given how many call sites this serves.
 */
function scrubPayload(
    props: Record<string, unknown>,
    mode: 'dev' | 'prod' | 'test',
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
        if (FORBIDDEN_KEY_PATTERN.test(k)) {
            if (mode === 'test') {
                throw new KbForbiddenPropertyError(k);
            }
            if (mode === 'dev') {
                // eslint-disable-next-line no-console
                console.warn(`kb-events: stripped forbidden property "${k}"`);
            }
            continue;
        }
        out[k] = v;
    }
    return out;
}

function resolveMode(): 'dev' | 'prod' | 'test' {
    if (process.env.NODE_ENV === 'test') return 'test';
    if (process.env.NODE_ENV === 'production') return 'prod';
    return 'dev';
}

/**
 * Sentinel error type used so the outer try-catch in `emitKbEvent` can let
 * the privacy-guard throw escape in `test` mode while still swallowing
 * unrelated runtime failures from the PostHog client. (Greptile P2 on
 * PR #1215: a plain catch made the test-mode throw a silent no-op.)
 */
export class KbForbiddenPropertyError extends Error {
    constructor(public readonly propertyKey: string) {
        super(
            `kb-events: forbidden property "${propertyKey}" — KB body content must not be sent to telemetry`,
        );
        this.name = 'KbForbiddenPropertyError';
    }
}

/**
 * Emit a typed KB event. Returns void; failures inside the PostHog client are
 * swallowed because telemetry must NEVER take down a user-facing request —
 * EXCEPT a `KbForbiddenPropertyError` from the privacy guard, which is
 * deliberately rethrown so `NODE_ENV=test` callers (and the
 * `no-kb-body-in-events.sh` CI gate's accompanying spec) fail loudly.
 */
export function emitKbEvent(
    client: PostHogCaptureClient | null | undefined,
    distinctId: string,
    payload: KbEventPayload,
): void {
    if (!client) return;
    let scrubbed: Record<string, unknown>;
    try {
        scrubbed = scrubPayload(payload.props as unknown as Record<string, unknown>, resolveMode());
    } catch (err) {
        // The privacy guard's throw must surface to tests and CI.
        if (err instanceof KbForbiddenPropertyError) throw err;
        return;
    }
    try {
        client.capture({ distinctId, event: payload.kind, properties: scrubbed });
    } catch {
        // PostHog client failures (network, serialization) are intentionally
        // swallowed — telemetry must not take down a user-facing request.
    }
}

/**
 * For the static CI gate — exposes the list of forbidden property keys so a
 * shell `grep -E` can sweep call sites without parsing TypeScript.
 */
export const KB_EVENTS_FORBIDDEN_PROPERTY_KEYS = [
    'body',
    'content',
    'markdown',
    'text',
    'html',
    'excerpt',
    'snippet',
    'chunk',
    'raw',
    'preview',
] as const;

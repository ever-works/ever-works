import { redactSecrets } from '../utils/secret-scan';

/**
 * Session detail — richer run capture (Feature K).
 *
 * Pure helpers for the tool loop's timeline capture: tool-invocation
 * rows gain redacted `argsPreview` / `resultPreview` + `durationMs`, and
 * the loop writes 'assistant-message' / 'user-message' rows at its turn
 * boundaries. Everything here is bounded and side-effect free — the
 * service owns the (best-effort, try/catch-wrapped) persistence.
 */

/** Byte cap for tool args / result previews (per row). */
export const CAPTURE_PREVIEW_MAX_CHARS = 4096;

/** Byte cap for captured assistant / user message text (per row). */
export const CAPTURE_MESSAGE_MAX_CHARS = 8192;

/**
 * Per-run capture-volume guard: once this many capture rows have been
 * written, message rows stop (one 'capture-truncated' marker row is
 * written instead) and tool rows keep only their pre-existing shape.
 */
export const CAPTURE_MAX_ENTRIES = 200;

/** Cap on the per-run `workspaceMeta.filesTouched` list. */
export const FILES_TOUCHED_CAP = 200;

/** Run-log steps the session-detail timeline is composed from. */
export const TIMELINE_STEPS = [
    'assistant-message',
    'user-message',
    'tool-invocation',
    'capture-truncated',
] as const;

/** Run-log steps that count as "messages" in the detail chips. */
export const MESSAGE_STEPS = ['assistant-message', 'user-message'] as const;

export interface CapturePreview {
    preview: string;
    truncated: boolean;
}

/**
 * Mutable per-tool-loop capture state. Lives on the loop's stack — a
 * re-entered run (red-gate iterate) simply starts a fresh window, which
 * keeps the guard simple and the worst case bounded per attempt.
 */
export interface RunCaptureState {
    entries: number;
    truncatedMarkerWritten: boolean;
    filesTouched: Set<string>;
}

export function createRunCaptureState(): RunCaptureState {
    return { entries: 0, truncatedMarkerWritten: false, filesTouched: new Set() };
}

/**
 * Serialize an arbitrary tool payload to a redacted, size-capped preview
 * string. Returns null for empty payloads so callers can skip the
 * metadata key entirely instead of storing `"null"` / `""`.
 *
 * Redaction runs BEFORE truncation: a secret that straddles the cap
 * boundary must not survive as a recognisable prefix.
 */
export function buildCapturePreview(
    value: unknown,
    maxChars = CAPTURE_PREVIEW_MAX_CHARS,
): CapturePreview | null {
    if (value === undefined || value === null) return null;
    let text: string;
    if (typeof value === 'string') {
        text = value;
    } else {
        try {
            text = JSON.stringify(value);
        } catch {
            // Circular / non-serializable tool payload — capture is
            // best-effort, never a run hazard.
            return { preview: '[unserializable payload]', truncated: false };
        }
    }
    if (text === undefined || text.length === 0) return null;
    const cleaned = redactSecrets(text).cleaned;
    if (cleaned.length <= maxChars) {
        return { preview: cleaned, truncated: false };
    }
    return { preview: `${cleaned.slice(0, maxChars)}…`, truncated: true };
}

/**
 * File paths a successful tool invocation is known to have touched.
 * Only tools whose args carry explicit paths are mapped — nothing is
 * inferred from prose. Returns [] for everything else.
 */
export function extractTouchedFiles(toolName: string, args: unknown): string[] {
    if (!args || typeof args !== 'object') return [];
    const record = args as Record<string, unknown>;
    if (toolName === 'commitToRepo' && Array.isArray(record.files)) {
        return record.files
            .map((f) =>
                f && typeof f === 'object' && typeof (f as { path?: unknown }).path === 'string'
                    ? ((f as { path: string }).path ?? '')
                    : '',
            )
            .filter((p) => p.length > 0);
    }
    if (toolName === 'editAgentFile' && typeof record.name === 'string' && record.name.length > 0) {
        return [record.name];
    }
    return [];
}

import { normalizeFleetAgentTaskTimeline } from '@ever-works/contracts';
import { redactSecrets } from '@ever-works/agent/utils';

/**
 * Self-build slice AP — a fleet run's step records as `agent_run_logs` rows.
 *
 * The Sessions view (`GET /api/agents/runs/:runId/detail`) renders a run's
 * timeline from `agent_run_logs` rows whose `step` is one of
 * `assistant-message` / `user-message` / `tool-invocation` /
 * `capture-truncated`, reading `toolName`, `callId`, `argsPreview`,
 * `durationMs` and `truncated` out of `metadata` — the shape the cloud tool
 * loop writes (`AgentRunService.invokeTool` / `captureMessage`). A fleet
 * run's steps are written in EXACTLY that shape, so the view needs no fleet
 * branch at all: no parallel UI, no second reader.
 *
 * Pure and side-effect free; the reconciler owns the (best-effort) writes.
 * The node's record is untrusted wire data, so it goes through the
 * contract's coercing reader first and every text is run through the
 * platform's own secret scanner again before it is persisted — the node
 * already redacted it, and this is the platform not taking that on trust.
 */

/** Step names a fleet timeline writes; also what the idempotency check counts. */
export const FLEET_TIMELINE_LOG_STEPS = [
    'assistant-message',
    'tool-invocation',
    'capture-truncated',
] as const;

/** Same per-row cap the cloud capture applies to a message row (`CAPTURE_MESSAGE_MAX_CHARS`). */
const MESSAGE_MAX_CHARS = 8192;

/** What the fleet run's evidence was recorded by, on every row it writes. */
const SOURCE = 'fleet-node';

export interface FleetTimelineLogRow {
    level: 'INFO' | 'WARN';
    step: (typeof FLEET_TIMELINE_LOG_STEPS)[number];
    message: string;
    metadata: Record<string, unknown>;
}

/**
 * The rows to append for one completed fleet job's `result`, in timeline
 * order; empty when the node reported no step records (an older node, a
 * node with capture switched off, a job with no model step).
 */
export function fleetModelTimelineLogRows(result: unknown): FleetTimelineLogRow[] {
    const model = asRecord(asRecord(result)?.model);
    if (!model) return [];
    // The platform's scanner runs on the node's FULL strings, before the
    // contract caps them (review): a token straddling a cap would otherwise
    // reach the scanner as a fragment its patterns no longer match.
    const timeline = Array.isArray(model.timeline)
        ? model.timeline.map(scrubWireStep)
        : model.timeline;
    const { steps, dropped } = normalizeFleetAgentTaskTimeline(timeline, model.timelineDropped);
    const rows: FleetTimelineLogRow[] = [];
    for (const step of steps) {
        if (step.kind === 'assistant-message') {
            const text = clean(step.text ?? '', MESSAGE_MAX_CHARS);
            if (!text) continue;
            rows.push({
                level: 'INFO',
                step: 'assistant-message',
                message: text,
                metadata: {
                    role: 'assistant',
                    source: SOURCE,
                    atMs: step.atMs,
                    ...(step.truncated ? { truncated: true } : {}),
                },
            });
            continue;
        }
        const toolName = clean(step.toolName ?? '', 200) || 'unknown';
        const isError = step.status === 'error';
        const argsPreview = step.argsSummary ? clean(step.argsSummary, 4096) : '';
        rows.push({
            level: isError ? 'WARN' : 'INFO',
            step: 'tool-invocation',
            message: `Invoked tool "${toolName}"${isError ? ' (returned error)' : step.status === 'unknown' ? ' (no result observed)' : ''}.`,
            metadata: {
                toolName,
                ...(step.callId ? { callId: step.callId } : {}),
                ...(typeof step.durationMs === 'number' ? { durationMs: step.durationMs } : {}),
                ...(argsPreview ? { argsPreview } : {}),
                ...(step.truncated ? { argsTruncated: true } : {}),
                status: step.status ?? 'unknown',
                source: SOURCE,
                atMs: step.atMs,
            },
        });
    }
    if (dropped > 0) {
        rows.push({
            level: 'INFO',
            step: 'capture-truncated',
            message: `Fleet node timeline cap reached — ${dropped} further step(s) were observed on the node and not recorded.`,
            metadata: { source: SOURCE, dropped },
        });
    }
    return rows;
}

/** One wire step with every text field scanned at full length; anything else passes through. */
function scrubWireStep(entry: unknown): unknown {
    const record = asRecord(entry);
    if (!record) return entry;
    const out: Record<string, unknown> = { ...record };
    for (const key of ['text', 'argsSummary', 'toolName', 'callId'] as const) {
        const value = record[key];
        if (typeof value === 'string') out[key] = redactSecrets(value).cleaned;
    }
    return out;
}

function clean(text: string, maxChars: number): string {
    const cleaned = redactSecrets(text).cleaned.trim();
    return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}…` : cleaned;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

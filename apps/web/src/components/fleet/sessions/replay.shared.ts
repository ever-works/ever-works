import type { FleetSessionDriverSpan, FleetSessionRecordingChunk } from '@ever-works/contracts';

/**
 * Sessions on computers (FL-04 P3) — the player's pure timeline: the stored
 * chunks placed on a clock (ms since the first chunk), what has been printed
 * by a position, the next chunk to play, the driver spans as marks. No React.
 */

export interface TimedChunk {
    seq: number;
    text: string;
    /** ms since the first chunk, on the player's (gap-shortened) clock. */
    atMs: number;
    /** When it was stored (ms since the epoch), or NaN. */
    realMs: number;
}

export const REPLAY_SPEEDS = [1, 2, 4] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** The slider moves in whole seconds; the buttons jump ten. */
export const REPLAY_STEP_MS = 1_000;
export const REPLAY_JUMP_MS = 10_000;

/** A pause longer than this in the recording plays as this long (nobody watches an idle minute). */
export const REPLAY_MAX_GAP_MS = 3_000;

/**
 * Put chunks on the player's clock, oldest first. Long idle gaps are
 * shortened to {@link REPLAY_MAX_GAP_MS} so a session that sat for an hour
 * plays in seconds; the order is the stored `seq`, never the clock.
 */
export function buildTimeline(chunks: readonly FleetSessionRecordingChunk[]): TimedChunk[] {
    const sorted = [...chunks].sort((a, b) => a.seq - b.seq);
    const out: TimedChunk[] = [];
    let clock = 0;
    let previous: number | null = null;
    for (const chunk of sorted) {
        const at = Date.parse(chunk.at);
        if (previous !== null && Number.isFinite(at)) {
            clock += Math.min(REPLAY_MAX_GAP_MS, Math.max(0, at - previous));
        }
        if (Number.isFinite(at)) previous = at;
        out.push({ seq: chunk.seq, text: chunk.text, atMs: clock, realMs: at });
    }
    return out;
}

/** How long the timeline plays, in ms. */
export function timelineDuration(timeline: readonly TimedChunk[]): number {
    return timeline.length === 0 ? 0 : timeline[timeline.length - 1].atMs;
}

/** How many chunks have been printed by `positionMs` (the index of the next one to play). */
export function printedBy(timeline: readonly TimedChunk[], positionMs: number): number {
    let low = 0;
    let high = timeline.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (timeline[mid].atMs <= positionMs) low = mid + 1;
        else high = mid;
    }
    return low;
}

/** Clamp a seek into the timeline, snapped to the slider's step. */
export function clampPosition(positionMs: number, durationMs: number): number {
    if (!Number.isFinite(positionMs)) return 0;
    const snapped = Math.round(positionMs / REPLAY_STEP_MS) * REPLAY_STEP_MS;
    return Math.min(Math.max(0, snapped), Math.max(0, durationMs));
}

/** `1:05` for a position. */
export function formatPosition(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The player position of a real instant: where the first chunk stored at or after it plays. */
export function positionOfInstant(
    timeline: readonly TimedChunk[],
    instantMs: number,
): number | null {
    if (!Number.isFinite(instantMs) || timeline.length === 0) return null;
    for (const chunk of timeline) {
        if (Number.isFinite(chunk.realMs) && chunk.realMs >= instantMs) return chunk.atMs;
    }
    return null;
}

/**
 * The driver spans as marks on the slider, as fractions of the player's
 * timeline (so a shortened idle gap moves the marks with the text). A span
 * that ends before the recording starts or starts after it ends is dropped.
 */
export function spanMarks(
    timeline: readonly TimedChunk[],
    spans: readonly FleetSessionDriverSpan[],
): Array<{ start: number; end: number; span: FleetSessionDriverSpan }> {
    const duration = timelineDuration(timeline);
    if (duration <= 0) return [];
    const out: Array<{ start: number; end: number; span: FleetSessionDriverSpan }> = [];
    for (const span of spans) {
        const from = positionOfInstant(timeline, Date.parse(span.from));
        if (from === null) continue;
        const to = positionOfInstant(timeline, Date.parse(span.to)) ?? duration;
        out.push({ start: from / duration, end: Math.max(from, to) / duration, span });
    }
    return out;
}

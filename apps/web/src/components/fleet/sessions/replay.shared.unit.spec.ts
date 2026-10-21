import { describe, expect, it } from 'vitest';
import {
    buildTimeline,
    clampPosition,
    formatPosition,
    printedBy,
    REPLAY_MAX_GAP_MS,
    spanMarks,
    timelineDuration,
} from './replay.shared';

const chunk = (seq: number, at: string, text = `c${seq}`) => ({ seq, at, text });

describe('replay.shared (FL-04 P3)', () => {
    it('orders by seq and shortens idle gaps', () => {
        const timeline = buildTimeline([
            chunk(2, '2026-10-21T10:00:01.000Z'),
            chunk(1, '2026-10-21T10:00:00.000Z'),
            chunk(3, '2026-10-21T11:00:00.000Z'),
        ]);
        expect(timeline.map((entry) => entry.seq)).toEqual([1, 2, 3]);
        expect(timeline.map((entry) => entry.atMs)).toEqual([0, 1000, 1000 + REPLAY_MAX_GAP_MS]);
        expect(timelineDuration(timeline)).toBe(1000 + REPLAY_MAX_GAP_MS);
    });

    it('knows what has been printed by a position', () => {
        const timeline = buildTimeline([
            chunk(1, '2026-10-21T10:00:00.000Z'),
            chunk(2, '2026-10-21T10:00:01.000Z'),
            chunk(3, '2026-10-21T10:00:02.000Z'),
        ]);
        expect(printedBy(timeline, 0)).toBe(1);
        expect(printedBy(timeline, 1500)).toBe(2);
        expect(printedBy(timeline, 99_000)).toBe(3);
    });

    it('snaps a seek to whole seconds inside the recording', () => {
        expect(clampPosition(1499, 10_000)).toBe(1000);
        expect(clampPosition(-5, 10_000)).toBe(0);
        expect(clampPosition(99_999, 10_000)).toBe(10_000);
        expect(formatPosition(65_000)).toBe('1:05');
    });

    it('marks driver spans on the player clock', () => {
        const timeline = buildTimeline([
            chunk(1, '2026-10-21T10:00:00.000Z'),
            chunk(2, '2026-10-21T10:00:01.000Z'),
            chunk(3, '2026-10-21T10:00:02.000Z'),
        ]);
        const marks = spanMarks(timeline, [
            { userId: 'u', requestedBy: 'user:u', from: '2026-10-21T10:00:01.000Z', to: '2026-10-21T10:00:02.000Z' },
            { userId: 'u', requestedBy: 'user:u', from: '2026-10-21T12:00:00.000Z', to: '2026-10-21T12:00:01.000Z' },
        ]);
        expect(marks).toHaveLength(1);
        expect(marks[0].start).toBeCloseTo(0.5);
        expect(marks[0].end).toBeCloseTo(1);
    });
});

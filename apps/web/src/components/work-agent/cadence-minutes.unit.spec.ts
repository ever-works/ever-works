import { describe, expect, it } from 'vitest';
import {
    DEFAULT_AUTOBUILD_THROTTLE,
    DEFAULT_BATCH_SIZE,
    DEFAULT_CADENCE_MINUTES,
    DEFAULT_MISSION_OUTSTANDING_CAP,
    formatCadenceMinutes,
    parseCadenceMinutes,
} from './cadence-minutes';

describe('cadence-minutes helpers (Phase 4 PR L)', () => {
    describe('parseCadenceMinutes', () => {
        it('extracts the minute step from a "*/N * * * *" cron', () => {
            expect(parseCadenceMinutes('*/15 * * * *')).toBe(15);
            expect(parseCadenceMinutes('*/60 * * * *')).toBe(60);
            expect(parseCadenceMinutes('*/1 * * * *')).toBe(1);
        });

        it('tolerates surrounding whitespace', () => {
            expect(parseCadenceMinutes('  */30 * * * *  ')).toBe(30);
        });

        it('returns null for null / undefined / empty', () => {
            expect(parseCadenceMinutes(null)).toBeNull();
            expect(parseCadenceMinutes(undefined)).toBeNull();
            expect(parseCadenceMinutes('')).toBeNull();
        });

        it('returns null for cron shapes the simple-form UI does not edit', () => {
            // Hour-pinned cron.
            expect(parseCadenceMinutes('0 */2 * * *')).toBeNull();
            // Day-of-week constraint.
            expect(parseCadenceMinutes('*/15 * * * MON')).toBeNull();
            // Plain literal minute (not stepped).
            expect(parseCadenceMinutes('15 * * * *')).toBeNull();
            // Free-form garbage.
            expect(parseCadenceMinutes('not a cron')).toBeNull();
        });

        it('returns null for zero/negative step (invalid in cron)', () => {
            // Regex requires \d+, so explicit negatives never match. A literal
            // "*/0 * * * *" is technically permitted by the regex but is
            // nonsensical — the helper rejects it via the >=1 check.
            expect(parseCadenceMinutes('*/0 * * * *')).toBeNull();
        });
    });

    describe('formatCadenceMinutes', () => {
        it('round-trips the simple cron shape', () => {
            expect(formatCadenceMinutes(30)).toBe('*/30 * * * *');
            expect(formatCadenceMinutes(1)).toBe('*/1 * * * *');
        });

        it('clamps below 1 → 1 (cron minimum granularity)', () => {
            expect(formatCadenceMinutes(0)).toBe('*/1 * * * *');
            expect(formatCadenceMinutes(-99)).toBe('*/1 * * * *');
        });

        it('clamps above 1440 (a full day) → 1440', () => {
            expect(formatCadenceMinutes(99999)).toBe('*/1440 * * * *');
        });

        it('floors fractional inputs', () => {
            expect(formatCadenceMinutes(15.7)).toBe('*/15 * * * *');
        });

        it('round-trips with parseCadenceMinutes for valid inputs', () => {
            for (const n of [1, 5, 15, 30, 60, 240, 1440]) {
                expect(parseCadenceMinutes(formatCadenceMinutes(n))).toBe(n);
            }
        });
    });

    describe('display defaults are stable', () => {
        // Lock the v1 defaults so PR L's UI shape stays in lockstep with
        // the server-side platform defaults. If/when those move, this
        // spec is the breadcrumb that forces an explicit decision.
        it('cadence default = 60 minutes', () => {
            expect(DEFAULT_CADENCE_MINUTES).toBe(60);
        });
        it('batch size default = 3', () => {
            expect(DEFAULT_BATCH_SIZE).toBe(3);
        });
        it('autobuild throttle default = 50/day', () => {
            expect(DEFAULT_AUTOBUILD_THROTTLE).toBe(50);
        });
        it('mission outstanding cap default = 20 (matches MissionTickService)', () => {
            expect(DEFAULT_MISSION_OUTSTANDING_CAP).toBe(20);
        });
    });
});

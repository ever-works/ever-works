import { describe, expect, it } from 'vitest';
import {
    draftToLimitCeiling,
    FLEET_NODE_LIMIT_BOUNDS,
    isEmptyLimitCeiling,
    limitCeilingToDraft,
} from './fleet-node-limits.shared';

/** Remote node limits (self-build slice AS) — the drawer editor's parsing. */
describe('fleet node limit ceiling — editor parsing', () => {
    it('round-trips a ceiling through the editor text', () => {
        const ceiling = { maxConcurrentJobs: 2, maxCpuPercent: 80, maxMemoryMb: null };
        const draft = limitCeilingToDraft(ceiling);
        expect(draft).toEqual({ maxConcurrentJobs: '2', maxCpuPercent: '80', maxMemoryMb: '' });
        expect(draftToLimitCeiling(draft)).toEqual({ ok: true, ceiling });
    });

    it('reads empty fields as "no ceiling on that dimension"', () => {
        expect(
            draftToLimitCeiling({ maxConcurrentJobs: ' ', maxCpuPercent: '', maxMemoryMb: '' }),
        ).toEqual({
            ok: true,
            ceiling: { maxConcurrentJobs: null, maxCpuPercent: null, maxMemoryMb: null },
        });
        expect(limitCeilingToDraft(null)).toEqual({
            maxConcurrentJobs: '',
            maxCpuPercent: '',
            maxMemoryMb: '',
        });
    });

    it('names the first field the API would refuse, instead of sending it', () => {
        expect(
            draftToLimitCeiling({ maxConcurrentJobs: '17', maxCpuPercent: '', maxMemoryMb: '' }),
        ).toEqual({ ok: false, field: 'maxConcurrentJobs' });
        expect(
            draftToLimitCeiling({ maxConcurrentJobs: '2', maxCpuPercent: '4', maxMemoryMb: '' }),
        ).toEqual({ ok: false, field: 'maxCpuPercent' });
        expect(
            draftToLimitCeiling({ maxConcurrentJobs: '', maxCpuPercent: '', maxMemoryMb: '1.5' }),
        ).toEqual({ ok: false, field: 'maxMemoryMb' });
        expect(
            draftToLimitCeiling({ maxConcurrentJobs: '-1', maxCpuPercent: '', maxMemoryMb: '' }),
        ).toEqual({ ok: false, field: 'maxConcurrentJobs' });
    });

    it('uses the node’s own bounds', () => {
        expect(FLEET_NODE_LIMIT_BOUNDS).toEqual({
            maxConcurrentJobs: { min: 1, max: 16 },
            maxCpuPercent: { min: 5, max: 100 },
            maxMemoryMb: { min: 256, max: 1_048_576 },
        });
    });

    it('knows an all-null ceiling is no ceiling', () => {
        expect(isEmptyLimitCeiling(null)).toBe(true);
        expect(
            isEmptyLimitCeiling({
                maxConcurrentJobs: null,
                maxCpuPercent: null,
                maxMemoryMb: null,
            }),
        ).toBe(true);
        expect(
            isEmptyLimitCeiling({ maxConcurrentJobs: 1, maxCpuPercent: null, maxMemoryMb: null }),
        ).toBe(false);
    });
});

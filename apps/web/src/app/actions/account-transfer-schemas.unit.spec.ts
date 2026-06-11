import { describe, it, expect } from 'vitest';
import { accountExportPayloadSchema } from './account-transfer-schemas';

/**
 * EW-717 (deserialization): the import payload's nested arrays must be
 * count-capped so a hostile/corrupted export cannot force unbounded memory +
 * RPC body size in the web tier before the upstream API DTO check.
 */
describe('accountExportPayloadSchema (EW-717 import array caps)', () => {
    const baseData = { profile: { username: 'u', email: 'u@x.io' } };

    it('accepts a well-formed v1 payload (small arrays)', () => {
        const payload = {
            version: 1,
            exportedAt: '2026-06-08T00:00:00.000Z',
            includesSecrets: false,
            data: { ...baseData, works: [{ slug: 'a' }], userPlugins: [{ pluginId: 'p' }] },
        };
        expect(accountExportPayloadSchema.safeParse(payload).success).toBe(true);
    });

    it('accepts a minimal payload (optional fields absent)', () => {
        expect(accountExportPayloadSchema.safeParse({}).success).toBe(true);
        expect(accountExportPayloadSchema.safeParse({ version: 2, data: baseData }).success).toBe(
            true,
        );
    });

    it('keeps unknown top-level and unknown data fields forward-compatible (catchall)', () => {
        const payload = {
            version: 2,
            somethingNew: { nested: true },
            data: { ...baseData, works: [], userPlugins: [], futureV3Field: [1, 2, 3] },
        };
        expect(accountExportPayloadSchema.safeParse(payload).success).toBe(true);
    });

    it('REJECTS an oversized data.works array (> 50_000)', () => {
        const payload = {
            version: 1,
            data: { ...baseData, works: new Array(50_001).fill({}), userPlugins: [] },
        };
        const res = accountExportPayloadSchema.safeParse(payload);
        expect(res.success).toBe(false);
    });

    it('REJECTS an oversized data.userPlugins array (> 5_000)', () => {
        const payload = {
            version: 1,
            data: { ...baseData, works: [], userPlugins: new Array(5_001).fill({}) },
        };
        expect(accountExportPayloadSchema.safeParse(payload).success).toBe(false);
    });

    it('REJECTS an oversized v2-tail array (e.g. taskChat > 500_000)', () => {
        const payload = {
            version: 2,
            data: {
                ...baseData,
                works: [],
                userPlugins: [],
                taskChat: new Array(500_001).fill({}),
            },
        };
        expect(accountExportPayloadSchema.safeParse(payload).success).toBe(false);
    });

    it('accepts arrays exactly at the cap boundary', () => {
        const payload = {
            version: 1,
            data: {
                ...baseData,
                works: new Array(50_000).fill({}),
                userPlugins: new Array(5_000).fill({}),
            },
        };
        expect(accountExportPayloadSchema.safeParse(payload).success).toBe(true);
    });
});

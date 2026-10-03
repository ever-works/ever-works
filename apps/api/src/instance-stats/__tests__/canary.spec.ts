import type { DataSource } from 'typeorm';
import { createHarness } from './fixtures/harness.helper-spec';
import {
    CANARIES,
    createStatsDataSource,
    seedOneUserInstance,
} from './fixtures/works-seed.helper-spec';

/**
 * Nothing seeded into the installation reaches a report: not the person's
 * name, e-mail or username, not the company name, the Work name, the
 * repository URL or the prompt — and not ANY of the generated `canary-…`
 * markers the seed wrote into every other string column of every seeded row.
 * Checked on the exact signed bytes, which are the bytes that would be sent.
 */
describe('ever.stats.v1 — canary', () => {
    let dataSource: DataSource;
    let body: string;

    beforeAll(async () => {
        dataSource = await createStatsDataSource();
        await seedOneUserInstance(dataSource, '2026-10');
        const { builder, signer } = createHarness(dataSource);
        const report = await builder.build('2026-10', false, new Date('2026-10-15T08:00:00Z'));
        const signed = await signer.sign(report);
        body = Buffer.from(signed.body).toString('utf8');
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('seeded a meaningful canary list', () => {
        // Generated from the entities' string columns, so it grows with the schema.
        expect(CANARIES.length).toBeGreaterThan(50);
    });

    it('carries none of the seeded values', () => {
        const found = CANARIES.filter((value) => body.includes(value));
        expect(found).toEqual([]);
        expect(body.toLowerCase()).not.toContain('canary');
    });

    it('carries no e-mail, URL or host shape at all', () => {
        expect(body).not.toMatch(/@/);
        expect(body).not.toMatch(/https?:/i);
        expect(body).not.toMatch(/\.(com|net|org|io|invalid|example)\b/i);
    });

    it('control: the check does see a leaked value', () => {
        const leaked = body.replace('"country":"ZZ"', `"country":"${CANARIES[0]}"`);
        expect(CANARIES.filter((value) => leaked.includes(value))).toEqual([CANARIES[0]]);
    });
});

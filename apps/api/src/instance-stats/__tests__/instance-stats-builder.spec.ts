import type { DataSource } from 'typeorm';
import { WORK_KINDS, WORKS_STATS_WORK_KIND_KEYS } from '@ever-works/contracts';
import { validateStatsReport } from '@ever-works/agent/ever-instance';
import {
    deploymentProviderKey,
    foldWorksByKind,
    knownWorkKindKeys,
    periodRange,
    previousPeriodOf,
    utcDateOf,
    versionAndChannel,
    workKindKey,
} from '../instance-stats.mapping';
import { createHarness } from './fixtures/harness';
import { createStatsDataSource, seedOneUserInstance } from './fixtures/works-seed';

/**
 * The builder against a seeded one-person installation, and the closed-list
 * mapping it uses. A one-person installation reports FULL counts and
 * aggregates — there is no small-instance rule.
 */
describe('InstanceStatsBuilderService', () => {
    let dataSource: DataSource;

    beforeAll(async () => {
        dataSource = await createStatsDataSource();
        await seedOneUserInstance(dataSource, '2026-10');
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('builds a schema-valid Works report with full counts for a one-person installation', async () => {
        const { builder } = createHarness(dataSource, {
            env: { EVER_WORKS_APP_WORKS_ENABLED: 'true', SUBSCRIPTIONS_ENABLED: 'yes' },
        });
        const report = await builder.build('2026-10', false, new Date('2026-10-15T08:00:00Z'));

        expect(validateStatsReport(report)).toEqual({ ok: true });
        expect(report).toMatchObject({
            schema: 'ever.stats.v1',
            product: 'works',
            instance_kind: 'backend',
            serves: ['works'],
            install_source: 'self-hosted',
            country: 'ZZ',
            period: '2026-10',
            final: false,
            sent_at: '2026-10-15',
            module_version: '1.0.0',
        });
        expect(report.counts).toEqual({
            users: 1,
            tenants: 1,
            organizations: 1,
            works: 3,
            agents: 1,
            missions: 1,
            teams: 1,
            fleet_nodes: 1,
            plugins_enabled: 1,
            works_by_kind: {
                website: 1,
                landing_page: 0,
                blog: 0,
                directory: 0,
                awesome_repo: 0,
                repo: 0,
                company: 0,
                campaign: 0,
                default: 0,
                app: 1,
                other: 1,
            },
        });
        expect(report.aggregates).toEqual({
            deployments: 2,
            deployments_by_provider: {
                ever_works: 0,
                vercel: 1,
                k8s: 0,
                your_cluster: 0,
                ever_works_apps: 0,
                other: 1,
            },
            runs: 1,
            credits_consumed: 8,
        });
        // Strictly `=== 'true'`: `yes` is off.
        expect(report.features).toMatchObject({
            app_works_enabled: true,
            subscriptions_enabled: false,
        });
    });

    it('describes the previous month for a final report', async () => {
        const { builder } = createHarness(dataSource);
        const report = await builder.build('2026-09', true, new Date('2026-10-02T08:00:00Z'));
        expect(report.final).toBe(true);
        expect(report.period).toBe('2026-09');
        expect(report.aggregates).toMatchObject({ deployments: 1, runs: 1, credits_consumed: 40 });
        // Counts are installation-wide totals at build time, whatever the period.
        expect(report.counts.users).toBe(1);
    });

    it('takes install_source and country only from their variables', async () => {
        const declared = createHarness(dataSource, {
            env: { EVER_INSTALL_SOURCE: 'partner:acme-hosting', EVER_STATS_COUNTRY: 'de' },
        });
        const report = await declared.builder.build(
            '2026-10',
            false,
            new Date('2026-10-15T08:00:00Z'),
        );
        expect(report.install_source).toBe('partner:acme-hosting');
        expect(report.country).toBe('DE');

        const malformed = createHarness(dataSource, {
            env: { EVER_INSTALL_SOURCE: 'https://acme.example', EVER_STATS_COUNTRY: 'Germany' },
        });
        expect(malformed.config.warnings).toEqual(
            expect.arrayContaining([
                'EVER_INSTALL_SOURCE:malformed',
                'EVER_STATS_COUNTRY:malformed',
            ]),
        );
        const fallback = await malformed.builder.build(
            '2026-10',
            false,
            new Date('2026-10-15T08:00:00Z'),
        );
        expect(fallback.install_source).toBe('self-hosted');
        expect(fallback.country).toBe('ZZ');
    });
});

describe('instance-stats mapping', () => {
    it('maps every Work kind the product knows onto a schema key that is not `other`', () => {
        // The guard for the next new kind: adding one to WORK_KINDS without a
        // schema key (and a contract release) fails here instead of silently
        // counting it under `other`.
        for (const { kind, key } of knownWorkKindKeys()) {
            expect({
                kind,
                key:
                    (WORKS_STATS_WORK_KIND_KEYS as readonly string[]).includes(key) &&
                    key !== 'other',
            }).toEqual({
                kind,
                key: true,
            });
        }
        expect(WORK_KINDS.length).toBeGreaterThan(0);
    });

    it('folds unknown kinds and providers under `other`, never as their own key', () => {
        expect(workKindKey('landing-page')).toBe('landing_page');
        expect(workKindKey('landing')).toBe('landing_page');
        expect(workKindKey('awesome-repo')).toBe('awesome_repo');
        expect(workKindKey('acme-secret-kind')).toBe('other');
        expect(workKindKey('other')).toBe('other');
        expect(deploymentProviderKey('ever-works')).toBe('ever_works');
        expect(deploymentProviderKey('your-cluster')).toBe('your_cluster');
        expect(deploymentProviderKey('ever-works-apps')).toBe('ever_works_apps');
        expect(deploymentProviderKey('acme-internal')).toBe('other');
        expect(Object.keys(foldWorksByKind({ 'x-y': 2 }))).toEqual([...WORKS_STATS_WORK_KIND_KEYS]);
        expect(foldWorksByKind({ 'x-y': 2, z: 3 }).other).toBe(5);
    });

    it.each([
        ['1.4.2', '1.4.2', 'stable'],
        ['v2.0.1', '2.0.1', 'stable'],
        ['1.4.2+20261002', '1.4.2', 'stable'],
        ['1.4.2-rc.1', '1.4.2', 'rc'],
        ['1.4.2-beta.3', '1.4.2', 'beta'],
        ['1.4.2-alpha', '1.4.2', 'beta'],
        ['0.1.0-dev.123', '0.1.0', 'dev'],
        ['1.2.3-acme-corp-prod', '1.2.3', 'custom'],
        ['develop', '0.0.0', 'custom'],
        ['sha-abc1234', '0.0.0', 'custom'],
        ['12345.0.0', '0.0.0', 'custom'],
    ])('version %s → %s on %s, never the suffix', (raw, version, channel) => {
        expect(versionAndChannel(raw)).toEqual({ version, channel });
    });

    it('computes UTC periods and dates without a time of day', () => {
        expect(periodRange('2026-12')).toEqual({
            start: new Date('2026-12-01T00:00:00.000Z'),
            end: new Date('2027-01-01T00:00:00.000Z'),
        });
        expect(previousPeriodOf(new Date('2027-01-02T00:30:00Z'))).toBe('2026-12');
        expect(utcDateOf(new Date('2026-10-02T23:59:59.999Z'))).toBe('2026-10-02');
    });
});

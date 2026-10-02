import { join } from 'path';
import type { DataSource } from 'typeorm';
import type { InstanceStatsRaw } from '@ever-works/agent/ever-instance';
import { contractJson } from './contract-files';
import { createHarness } from './fixtures/harness';
import { createStatsDataSource } from './fixtures/works-seed';

/**
 * The builder's output equals the published Works golden report
 * (`valid/works.json`), modulo the three values minted per report or per
 * installation (`report_id`, `instance_id`, `sent_at`), when it is fed the
 * numbers that golden describes.
 *
 * The aggregate queries are proven against a real database elsewhere
 * (builder, canary and receiver specs); here the repository answers the
 * golden's numbers in their STORED form — hyphenated kinds, provider plugin
 * ids, and one unknown value of each, which must land under `other` — so the
 * whole mapping from storage to the published keys is pinned.
 */
describe('ever.stats.v1 — Works golden', () => {
    let dataSource: DataSource;
    const previousVersion = process.env.BUILD_VERSION;

    beforeAll(async () => {
        dataSource = await createStatsDataSource();
        process.env.BUILD_VERSION = '1.4.2';
    });

    afterAll(async () => {
        if (previousVersion === undefined) delete process.env.BUILD_VERSION;
        else process.env.BUILD_VERSION = previousVersion;
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('equals valid/works.json modulo report_id, instance_id and sent_at', async () => {
        const golden = contractJson<Record<string, unknown>>(
            join('fixtures', 'stats', 'valid', 'works.json'),
        );
        const harness = createHarness(dataSource, {
            env: {
                EVER_WORKS_APP_WORKS_ENABLED: 'false',
                EVER_WORKS_APP_LAUNCHER_ENABLED: 'true',
                PLUGIN_DISTRIBUTION_MODE: 'dynamic',
                DEPLOY_EVER_WORKS_ENABLED: 'false',
                SUBSCRIPTIONS_ENABLED: 'true',
                EVER_WORKS_MCP_AUTH_MODE: 'per-user-jwt',
            },
        });
        const raw: InstanceStatsRaw = {
            users: 407,
            tenants: 444,
            organizations: 481,
            works: 518,
            worksByKind: {
                website: 201,
                'landing-page': 238,
                blog: 275,
                directory: 312,
                'awesome-repo': 349,
                repo: 386,
                company: 423,
                campaign: 460,
                default: 497,
                app: 534,
                'a-kind-this-build-does-not-know': 571,
            },
            agents: 555,
            missions: 592,
            teams: 629,
            fleetNodes: 666,
            pluginsEnabled: 703,
            deployments: 150,
            deploymentsByProvider: {
                'ever-works': 100,
                vercel: 137,
                k8s: 174,
                'your-cluster': 211,
                'ever-works-apps': 248,
                'acme-custom-deployer': 285,
            },
            runs: 224,
            creditsConsumed: 261,
        };
        jest.spyOn(harness.repository, 'collect').mockResolvedValue(raw);

        const report = (await harness.builder.build(
            String(golden.period),
            golden.final === true,
            new Date('2026-11-02T10:00:00Z'),
        )) as unknown as Record<string, unknown>;

        const volatile = ['report_id', 'instance_id', 'sent_at'];
        const strip = (value: Record<string, unknown>) =>
            Object.fromEntries(Object.entries(value).filter(([key]) => !volatile.includes(key)));
        expect(strip(report)).toEqual(strip(golden));
        // Same key ORDER as the golden too, so the posted bytes read the same way.
        expect(Object.keys(report)).toEqual(Object.keys(golden));
    });
});

import { DataSource } from 'typeorm';
import type { AppLauncherItem } from '@ever-works/contracts';
import type { AppsTierPolicy } from '../../app-runtime/ports';
import { AppLauncherPreference } from '../../entities/app-launcher-preference.entity';
import { WorkCustomDomain } from '../../entities/work-custom-domain.entity';
import { DeploymentEnvironment, WorkDeployment } from '../../entities/work-deployment.entity';
import { WorkMember } from '../../entities/work-member.entity';
import { Work } from '../../entities/work.entity';
import { WorkMemberRole } from '../../entities/types';
import { ENTITIES } from '../../database/_entities-inventory';
import { AppLauncherPreferenceRepository } from '../../database/repositories/app-launcher-preference.repository';
import { WorkCustomDomainRepository } from '../../database/repositories/work-custom-domain.repository';
import { WorkDeploymentRepository } from '../../database/repositories/work-deployment.repository';
import { WorkMemberRepository } from '../../database/repositories/work-member.repository';
import { WorkRepository } from '../../database/repositories/work.repository';
import {
    AppLauncherService,
    type AppLauncherPlatformInput,
    type AppLauncherScope,
    type AppSpecDisplayNameReader,
    type WorkAppRuntimeStateReader,
} from '../app-launcher.service';
import {
    DefaultManagedHostRootResolver,
    type AppPublishedHostsPort,
} from '../managed-host-root.resolver';

/**
 * APW-11 T6 — the read path of `AppLauncherService` (plan §4.1, §4.6).
 *
 * Covers ACC-11-09, ACC-11-11, ACC-11-12, ACC-11-13, ACC-11-21, ACC-11-41,
 * ACC-11-42, ACC-11-43 and ACC-11-44, and the FR-16/FR-24/FR-27/FR-55/FR-56/
 * FR-57/FR-58/FR-62/FR-63/FR-64 rules of the plan's `app-launcher.service.spec.ts`
 * row (`plan.md:940`).
 *
 * The service runs on **real repositories over a real in-memory better-sqlite3
 * database** — the harness T5's repository spec uses — so the candidate set, the
 * three batched reads and the stored preference rows are the ones the queries
 * actually produce; a mocked repository could not catch a filter the service
 * forgot to ask for. Only the seams APW-03/06/10 own are fakes, and each fake is
 * bound through the token its owner will bind.
 *
 * Every host is a reserved documentation name (RFC 2606 `.test`); no real host,
 * Work title or address from the product appears.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** `EVER_WORKS_DOMAIN` — the platform's own managed root. */
const PLATFORM_ROOT = 'works.example.test';

/** `EVER_WORKS_APPS_DOMAIN` — the apex an App Work's label is allocated on. */
const APPS_APEX = 'apps.example.test';

/** The id the catalog marks **You're here** (`EVER_WORKS_PLATFORM_CATALOG_SELF_ID`). */
const SELF_KEY = 'platform:ever-works';

const ENV_KEYS = [
    'EVER_WORKS_DOMAIN',
    'EVER_WORKS_APPS_DOMAIN',
    'EVER_WORKS_APP_WORKS_ENABLED',
    'EVER_WORKS_PLATFORM_CATALOG_SELF_ID',
    'EVER_WORKS_PLATFORM_CATALOG_ENV',
    'NODE_ENV',
] as const;

describe('AppLauncherService.listForUser (APW-11 T6)', () => {
    const savedEnv = new Map<string, string | undefined>();
    let dataSource: DataSource;
    let sequence = 0;

    beforeAll(async () => {
        for (const key of ENV_KEYS) {
            savedEnv.set(key, process.env[key]);
        }
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
    });

    afterAll(async () => {
        for (const key of ENV_KEYS) {
            const value = savedEnv.get(key);
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        await dataSource.destroy();
    });

    beforeEach(async () => {
        process.env.EVER_WORKS_DOMAIN = PLATFORM_ROOT;
        process.env.EVER_WORKS_APPS_DOMAIN = APPS_APEX;
        delete process.env.EVER_WORKS_APP_WORKS_ENABLED;
        delete process.env.EVER_WORKS_PLATFORM_CATALOG_SELF_ID;
        delete process.env.EVER_WORKS_PLATFORM_CATALOG_ENV;

        await dataSource.query('DELETE FROM "app_launcher_preferences"');
        await dataSource.query('DELETE FROM "work_members"');
        await dataSource.query('DELETE FROM "work_deployments"');
        await dataSource.query('DELETE FROM "work_custom_domains"');
        await dataSource.query('DELETE FROM "works"');
    });

    // ── fixtures ─────────────────────────────────────────────────────────────

    async function makeWork(
        options: {
            userId?: string;
            kind?: string;
            organizationId?: string | null;
            status?: string;
            name?: string;
            managedSubdomain?: string | null;
            appLauncherExposed?: boolean | null;
        } = {},
    ): Promise<string> {
        sequence += 1;
        const works = dataSource.getRepository(Work);
        const saved = await works.save(
            works.create({
                userId: options.userId ?? USER,
                name: options.name ?? `Work ${sequence}`,
                slug: `work-${sequence}`,
                description: `Launcher fixture ${sequence}`,
                kind: options.kind ?? 'default',
                status: options.status ?? 'active',
                organizationId: options.organizationId ?? null,
                managedSubdomain: options.managedSubdomain ?? null,
                appLauncherExposed: options.appLauncherExposed ?? null,
            } as Partial<Work>),
        );
        return saved.id;
    }

    async function deploy(
        workId: string,
        state: string,
        options: {
            environment?: DeploymentEnvironment;
            website?: string | null;
            createdAt?: string;
        } = {},
    ): Promise<string> {
        const repository = dataSource.getRepository(WorkDeployment);
        const saved = await repository.save(
            repository.create({
                workId,
                environment: options.environment ?? DeploymentEnvironment.PRODUCTION,
                provider: 'ever-works',
                state,
                website: options.website ?? null,
            } as Partial<WorkDeployment>),
        );
        if (options.createdAt) {
            await dataSource.query(`UPDATE "work_deployments" SET "createdAt" = ? WHERE "id" = ?`, [
                options.createdAt,
                saved.id,
            ]);
        }
        return saved.id;
    }

    async function addDomain(
        workId: string,
        domain: string,
        options: { createdAt?: string; verified?: boolean; environment?: string } = {},
    ): Promise<string> {
        const repository = dataSource.getRepository(WorkCustomDomain);
        const saved = await repository.save(
            repository.create({
                workId,
                domain,
                verified: options.verified ?? true,
                environment: options.environment ?? 'production',
            } as Partial<WorkCustomDomain>),
        );
        if (options.createdAt) {
            await dataSource.query(
                `UPDATE "work_custom_domains" SET "createdAt" = ? WHERE "id" = ?`,
                [options.createdAt, saved.id],
            );
        }
        return saved.id;
    }

    async function addMember(workId: string, userId: string): Promise<void> {
        const repository = dataSource.getRepository(WorkMember);
        await repository.save(
            repository.create({
                workId,
                userId,
                role: WorkMemberRole.VIEWER,
            } as Partial<WorkMember>),
        );
    }

    function preferences(): AppLauncherPreferenceRepository {
        return new AppLauncherPreferenceRepository(dataSource.getRepository(AppLauncherPreference));
    }

    function buildService(
        fakes: {
            publishedHosts?: Partial<AppPublishedHostsPort>;
            runtimeStates?: Partial<WorkAppRuntimeStateReader>;
            tierPolicy?: { isQuarantined?: (workId: string) => boolean | Promise<boolean> };
            specNames?: Partial<AppSpecDisplayNameReader>;
            managedHostRoot?: DefaultManagedHostRootResolver;
        } = {},
    ): AppLauncherService {
        return new AppLauncherService(
            new WorkRepository(dataSource.getRepository(Work)),
            new WorkMemberRepository(dataSource.getRepository(WorkMember)),
            new WorkDeploymentRepository(dataSource.getRepository(WorkDeployment)),
            new WorkCustomDomainRepository(dataSource.getRepository(WorkCustomDomain)),
            preferences(),
            dataSource,
            fakes.managedHostRoot ?? new DefaultManagedHostRootResolver(),
            fakes.publishedHosts as AppPublishedHostsPort,
            fakes.runtimeStates as WorkAppRuntimeStateReader,
            fakes.tierPolicy as AppsTierPolicy,
            fakes.specNames as AppSpecDisplayNameReader,
        );
    }

    function platforms(): AppLauncherPlatformInput[] {
        return [
            {
                key: SELF_KEY,
                name: 'Ever Works',
                url: 'https://works.example.test/',
                current: true,
                catalogOrder: 10,
            },
            {
                key: 'platform:ever-gauzy',
                name: 'Ever Gauzy',
                url: 'https://gauzy.example.test/',
                catalogOrder: 20,
                status: 'available',
            },
            {
                key: 'platform:cal-diy',
                name: 'Cal.diy',
                url: 'https://cal.example.test/',
                catalogOrder: 30,
                status: 'beta',
            },
        ];
    }

    const personal: AppLauncherScope = { organizationId: null };
    const orgA: AppLauncherScope = { organizationId: ORG_A };
    const orgB: AppLauncherScope = { organizationId: ORG_B };

    async function list(
        options: {
            includeHidden?: boolean;
            limit?: number;
            filter?: string;
            scope?: AppLauncherScope;
            user?: { id: string };
            service?: AppLauncherService;
        } = {},
    ) {
        const launcher = options.service ?? buildService();
        return launcher.listForUser(
            options.user ?? { id: USER },
            options.scope ?? personal,
            platforms(),
            {
                includeHidden: options.includeHidden,
                limit: options.limit,
                filter: options.filter,
            },
        );
    }

    const keyOf = (workId: string) => `work:${workId}`;

    function tileOf(
        response: { items: AppLauncherItem[] },
        workId: string,
    ): AppLauncherItem | undefined {
        return response.items.find((item) => item.key === keyOf(workId));
    }

    // ── Your apps: liveness and address (ACC-11-09, ACC-11-11, ACC-11-13) ─────

    describe('Your apps — liveness and address', () => {
        it('lists an App Work with a READY production deployment and no setting changed (ACC-11-09)', async () => {
            const workId = await makeWork({
                kind: 'app',
                name: 'Cal.diy',
                managedSubdomain: 'bright-lab',
            });
            await deploy(workId, 'READY', { website: `https://bright-lab.${APPS_APEX}/` });

            const response = await list();

            expect(tileOf(response, workId)).toMatchObject({
                kind: 'work',
                section: 'works',
                name: 'Cal.diy',
                url: `https://bright-lab.${APPS_APEX}/`,
                host: `bright-lab.${APPS_APEX}`,
                workKind: 'app',
                visible: true,
                pinned: false,
                pinOrder: null,
                manageState: 'listed',
            });
            expect(tileOf(response, workId)?.chip).toBeUndefined();
        });

        it('does not list the same App Work when no production deployment ever succeeded (ACC-11-09)', async () => {
            const workId = await makeWork({
                kind: 'app',
                name: 'Never deployed',
                managedSubdomain: 'never-live',
            });

            const panel = await list();
            expect(panel.items.map((item) => item.key)).not.toContain(keyOf(workId));

            const manage = await list({ includeHidden: true });
            expect(tileOf(manage, workId)).toMatchObject({
                manageState: 'notLive',
                url: null,
                host: null,
            });
        });

        it('never makes a Work live off a preview deployment alone (ACC-11-13)', async () => {
            const workId = await makeWork({
                kind: 'app',
                name: 'Preview only',
                managedSubdomain: 'preview-only',
            });
            await deploy(workId, 'READY', {
                environment: DeploymentEnvironment.PREVIEW,
                website: 'https://preview.example.test/',
            });

            const panel = await list();
            expect(panel.items.map((item) => item.key)).not.toContain(keyOf(workId));

            const manage = await list({ includeHidden: true });
            expect(tileOf(manage, workId)?.manageState).toBe('notLive');
        });

        it('shows a live directory Work only once exposure is on, and only to somebody who can view it (ACC-11-11)', async () => {
            const workId = await makeWork({
                name: 'Directory Work',
                managedSubdomain: 'directory',
            });
            await deploy(workId, 'READY', { website: 'https://directory.example.test/' });
            await addMember(workId, MEMBER);

            // Kind `default` defaults exposure to off (FR-19), so the live Work is absent.
            const hidden = await list();
            expect(hidden.items.map((item) => item.key)).not.toContain(keyOf(workId));
            expect(tileOf(await list({ includeHidden: true }), workId)?.manageState).toBe(
                'exposureOff',
            );

            await dataSource
                .getRepository(Work)
                .update({ id: workId }, { appLauncherExposed: true });

            const owner = await list();
            expect(tileOf(owner, workId)).toMatchObject({
                manageState: 'listed',
                url: `https://directory.${PLATFORM_ROOT}/`,
                host: `directory.${PLATFORM_ROOT}`,
            });

            // A member who can view the Work sees the same tile.
            const member = await list({ user: { id: MEMBER } });
            expect(member.items.map((item) => item.key)).toContain(keyOf(workId));

            // A person who can neither create nor view the Work never sees it.
            const stranger = await list({ user: { id: STRANGER } });
            expect(stranger.items.map((item) => item.key)).not.toContain(keyOf(workId));
        });

        it('drops an archived Work from the candidate set entirely', async () => {
            const workId = await makeWork({
                kind: 'app',
                name: 'Archived',
                managedSubdomain: 'archived',
                status: 'archived',
            });
            await deploy(workId, 'READY', { website: `https://archived.${APPS_APEX}/` });

            const manage = await list({ includeHidden: true });
            expect(manage.items.map((item) => item.key)).not.toContain(keyOf(workId));
        });
    });

    // ── Chips (ACC-11-12, ACC-11-44) ─────────────────────────────────────────

    describe('chips — one row, the latest production deployment (FR-58)', () => {
        it('carries lastDeployFailed after an earlier success and still opens (ACC-11-12)', async () => {
            const workId = await makeWork({
                kind: 'app',
                name: 'Failed latest',
                managedSubdomain: 'failed-latest',
            });
            await deploy(workId, 'READY', {
                website: `https://failed-latest.${APPS_APEX}/`,
                createdAt: '2026-01-01T00:00:00.000Z',
            });
            await deploy(workId, 'ERROR', { createdAt: '2026-03-01T00:00:00.000Z' });

            const tile = tileOf(await list(), workId);

            expect(tile?.chip).toBe('lastDeployFailed');
            // Liveness comes from the READY read, not from the chip: the tile keeps
            // its address and still opens (ACC-11-12).
            expect(tile).toMatchObject({
                manageState: 'listed',
                url: `https://failed-latest.${APPS_APEX}/`,
            });
        });

        it('chips nothing for CANCELED and for SUPERSEDED, and lastDeployFailed for ROLLED_BACK (ACC-11-44)', async () => {
            const cancelled = await makeWork({ kind: 'app', managedSubdomain: 'cancelled' });
            await deploy(cancelled, 'READY', { createdAt: '2026-01-01T00:00:00.000Z' });
            await deploy(cancelled, 'CANCELED', { createdAt: '2026-02-01T00:00:00.000Z' });

            const superseded = await makeWork({ kind: 'app', managedSubdomain: 'superseded' });
            await deploy(superseded, 'READY', { createdAt: '2026-01-01T00:00:00.000Z' });
            await deploy(superseded, 'SUPERSEDED', { createdAt: '2026-02-01T00:00:00.000Z' });

            const rolledBack = await makeWork({ kind: 'app', managedSubdomain: 'rolled-back' });
            await deploy(rolledBack, 'READY', { createdAt: '2026-01-01T00:00:00.000Z' });
            await deploy(rolledBack, 'ROLLED_BACK', { createdAt: '2026-02-01T00:00:00.000Z' });

            const response = await list();
            const chipOf = (workId: string) => tileOf(response, workId)?.chip as string | undefined;

            expect(chipOf(cancelled)).toBeUndefined();
            expect(chipOf(superseded)).toBeUndefined();
            expect(chipOf(rolledBack)).toBe('lastDeployFailed');

            // A cancelled or superseded row fails no tile: all three are still live
            // off their earlier READY row.
            for (const workId of [cancelled, superseded, rolledBack]) {
                expect(tileOf(response, workId)?.manageState).toBe('listed');
            }
        });

        it.each(['INITIALIZING', 'QUEUED', 'BUILDING', 'DEPLOYING', 'VERIFYING'])(
            'chips deploying while the latest production row is %s',
            async (state) => {
                const workId = await makeWork({ kind: 'app', managedSubdomain: `state-${state}` });
                await deploy(workId, state, { createdAt: '2026-02-01T00:00:00.000Z' });

                const tile = tileOf(await list({ includeHidden: true }), workId);

                expect(tile?.chip).toBe('deploying');
                // Nothing has succeeded yet, so it is still not live.
                expect(tile?.manageState).toBe('notLive');
            },
        );

        it('chips nothing for an unknown state a later epic may add', async () => {
            const workId = await makeWork({ kind: 'app', managedSubdomain: 'unknown-state' });
            await deploy(workId, 'READY', { createdAt: '2026-01-01T00:00:00.000Z' });
            await deploy(workId, 'SOMETHING_NEW', { createdAt: '2026-02-01T00:00:00.000Z' });

            const tile = tileOf(await list(), workId);
            expect(tile?.chip).toBeUndefined();
            expect(tile?.manageState).toBe('listed');
        });
    });

    // ── Names (ACC-11-43) ───────────────────────────────────────────────────

    describe('item name (FR-57)', () => {
        it('is named from the App spec display name, community-build suffix included (ACC-11-43)', async () => {
            const workId = await makeWork({
                kind: 'app',
                name: 'cal-diy-fork',
                managedSubdomain: 'cal-diy',
            });
            await deploy(workId, 'READY', {});

            const withSpecName = buildService({
                specNames: {
                    findDisplayNamesForWorks: async () =>
                        new Map([[workId, 'Cal.diy (community build)']]),
                },
            });
            const response = await list({ service: withSpecName });

            expect(tileOf(response, workId)?.name).toBe('Cal.diy (community build)');
        });

        it('falls back to the Work name when no App spec name exists (FR-57)', async () => {
            const workId = await makeWork({
                kind: 'app',
                name: 'Plain name',
                managedSubdomain: 'plain',
            });
            await deploy(workId, 'READY', {});

            expect(tileOf(await list(), workId)?.name).toBe('Plain name');
        });

        it('keeps the community-build suffix whole when the name is over the cap (ACC-11-43)', async () => {
            const workId = await makeWork({ kind: 'app', managedSubdomain: 'long-name' });
            await deploy(workId, 'READY', {});

            const suffix = '(community build)';
            const base =
                'Cal.diy for teams that need a really long product name and a few more words to fill the line';
            const displayName = `${base} ${suffix}`;
            expect(base.length).toBeGreaterThan(82);
            expect(displayName.length).toBeGreaterThan(100);

            const withSpecName = buildService({
                specNames: {
                    findDisplayNamesForWorks: async () => new Map([[workId, displayName]]),
                },
            });
            const name = tileOf(await list({ service: withSpecName }), workId)?.name ?? '';

            // The suffix survives intact: the display name's own words are what get
            // truncated, and the cut lands after a whole word.
            expect(name.endsWith(` ${suffix}`)).toBe(true);
            expect(name.length).toBeLessThanOrEqual(100);
            const head = name.slice(0, name.length - suffix.length - 1);
            expect(base.startsWith(head)).toBe(true);
            expect(base[head.length]).toBe(' ');
            // …and nothing is dropped beyond what the cap forces (82 characters are
            // available for the name itself).
            expect(head.length).toBeGreaterThan(60);
        });

        it('never leaves a half-written parenthetical in the name', async () => {
            const workId = await makeWork({ kind: 'app', managedSubdomain: 'half-group' });
            await deploy(workId, 'READY', {});

            const base = 'Cal.diy for teams'.padEnd(84, 'x');
            // The trailing group is complete but is not at the end of the name, so
            // no whole-suffix rule can apply — a word-boundary cut would land
            // inside `(community` and must be discarded instead.
            const displayName = `${base} (community build) extra words here`;

            const withSpecName = buildService({
                specNames: {
                    findDisplayNamesForWorks: async () => new Map([[workId, displayName]]),
                },
            });
            const name = tileOf(await list({ service: withSpecName }), workId)?.name ?? '';

            expect(name.length).toBeLessThanOrEqual(100);
            expect(name).not.toContain('(');
            expect(name).toBe(base);
        });

        it('caps a long Work name that has no suffix at all (FR-57)', async () => {
            const workId = await makeWork({
                kind: 'app',
                name: 'y'.repeat(180),
                managedSubdomain: 'capped',
            });
            await deploy(workId, 'READY', {});

            const name = tileOf(await list(), workId)?.name ?? '';
            expect(name).toHaveLength(100);
        });
    });

    // ── Not live while it does not run (ACC-11-42) ──────────────────────────

    describe('not live while it does not run (FR-56)', () => {
        it.each([
            ['paused', { paused: true }],
            ['removed', { removedAt: '2026-02-01T00:00:00.000Z' }],
        ])(
            'marks a %s App Work notLive and keeps its arrangement (ACC-11-42)',
            async (_label, state) => {
                const workId = await makeWork({
                    kind: 'app',
                    name: 'Paused app',
                    managedSubdomain: 'paused-app',
                });
                await deploy(workId, 'READY', { website: `https://paused-app.${APPS_APEX}/` });
                await preferences().upsertMany(USER, [
                    {
                        scopeKey: 'personal',
                        itemKey: keyOf(workId),
                        visible: true,
                        pinned: true,
                        pinOrder: 0,
                    },
                ]);

                const blocked = buildService({
                    runtimeStates: {
                        findStateForWorks: async (workIds: string[]) =>
                            new Map(workIds.map((id) => [id, { workId: id, ...state }])),
                    },
                });

                const manage = await list({ includeHidden: true, service: blocked });
                const tile = tileOf(manage, workId);

                // Manage apps lists it as not live, with no address …
                expect(tile).toMatchObject({ manageState: 'notLive', url: null, host: null });
                // … and the stored arrangement is kept (FR-56).
                expect(tile).toMatchObject({ pinned: true, pinOrder: 0 });

                // It is absent from the panel …
                const panel = await list({ service: blocked });
                expect(panel.items.map((item) => item.key)).not.toContain(keyOf(workId));

                // … and the row itself survived the pause.
                const rows = await dataSource
                    .getRepository(AppLauncherPreference)
                    .find({ where: { userId: USER } });
                expect(rows).toHaveLength(1);
                expect(rows[0]).toMatchObject({
                    itemKey: keyOf(workId),
                    pinned: true,
                    pinOrder: 0,
                });
            },
        );

        it('marks a quarantined App Work notLive through APW-10s policy port (ACC-11-42)', async () => {
            const quarantined = await makeWork({ kind: 'app', managedSubdomain: 'quarantined' });
            await deploy(quarantined, 'READY', { website: `https://quarantined.${APPS_APEX}/` });
            const healthy = await makeWork({ kind: 'app', managedSubdomain: 'healthy' });
            await deploy(healthy, 'READY', { website: `https://healthy.${APPS_APEX}/` });

            const withPolicy = buildService({
                tierPolicy: { isQuarantined: async (workId: string) => workId === quarantined },
            });

            const panel = await list({ service: withPolicy });
            expect(panel.items.map((item) => item.key)).not.toContain(keyOf(quarantined));
            expect(panel.items.map((item) => item.key)).toContain(keyOf(healthy));

            const manage = await list({ includeHidden: true, service: withPolicy });
            expect(tileOf(manage, quarantined)?.manageState).toBe('notLive');
            expect(tileOf(manage, healthy)?.manageState).toBe('listed');
        });

        it('treats an unbound runtime-state port as "not paused" (the APW-06 seam)', async () => {
            const workId = await makeWork({ kind: 'app', managedSubdomain: 'unbound' });
            await deploy(workId, 'READY', { website: `https://unbound.${APPS_APEX}/` });

            const panel = await list({ service: buildService({ runtimeStates: undefined }) });
            expect(tileOf(panel, workId)?.manageState).toBe('listed');
        });

        it('does not hide every tile when the runtime-state port throws', async () => {
            const workId = await makeWork({ kind: 'app', managedSubdomain: 'throwing' });
            await deploy(workId, 'READY', { website: `https://throwing.${APPS_APEX}/` });

            const broken = buildService({
                runtimeStates: {
                    findStateForWorks: async () => {
                        throw new Error('APW-06 worker unreachable');
                    },
                },
            });
            const panel = await list({ service: broken });

            expect(tileOf(panel, workId)?.manageState).toBe('listed');
        });
    });

    // ── Address resolution (ACC-11-41, FR-16, FR-55) ────────────────────────

    describe('address resolution (FR-16, FR-55, ACC-11-41)', () => {
        it('addresses a kind-app Work on the apps apex and never under EVER_WORKS_DOMAIN (ACC-11-41)', async () => {
            const workId = await makeWork({ kind: 'app', managedSubdomain: 'bright-lab' });
            await deploy(workId, 'READY', {});

            const tile = tileOf(await list(), workId);

            expect(tile).toMatchObject({
                url: `https://bright-lab.${APPS_APEX}/`,
                host: `bright-lab.${APPS_APEX}`,
            });
            expect(tile?.host).not.toBe(`bright-lab.${PLATFORM_ROOT}`);
            expect(tile?.host?.endsWith(`.${PLATFORM_ROOT}`) ?? true).toBe(false);
            expect(tile?.host?.endsWith(PLATFORM_ROOT) ?? true).toBe(false);
        });

        it('falls back to EVER_WORKS_DOMAIN for the apps apex when no dedicated apex is configured', async () => {
            delete process.env.EVER_WORKS_APPS_DOMAIN;

            const workId = await makeWork({ kind: 'app', managedSubdomain: 'shared-apex' });
            await deploy(workId, 'READY', {});

            // CONTRACTS §7: EVER_WORKS_APPS_DOMAIN defaults to EVER_WORKS_DOMAIN, so
            // `<slug>.ever.works` is the expected default and asserting it is the point.
            expect(tileOf(await list(), workId)?.host).toBe(`shared-apex.${PLATFORM_ROOT}`);
        });

        it('invents no host at all for an App Work when neither domain is configured', async () => {
            delete process.env.EVER_WORKS_DOMAIN;
            delete process.env.EVER_WORKS_APPS_DOMAIN;

            const workId = await makeWork({ kind: 'app', managedSubdomain: 'no-apex' });
            await deploy(workId, 'READY', {});

            const manage = await list({ includeHidden: true });

            expect(tileOf(manage, workId)).toMatchObject({
                manageState: 'notLive',
                url: null,
                host: null,
            });
        });

        it('lets a bound published-hosts port win over the synthesised candidate (ACC-11-41)', async () => {
            const workId = await makeWork({ kind: 'app', managedSubdomain: 'published' });
            await deploy(workId, 'READY', {});

            const bound = buildService({
                publishedHosts: {
                    primary: async (id: string) =>
                        id === workId ? 'https://primary.example.test/' : null,
                },
            });
            const tile = tileOf(await list({ service: bound }), workId);

            expect(tile).toMatchObject({
                url: 'https://primary.example.test/',
                host: 'primary.example.test',
            });
        });

        it('falls back to the FR-16 order when the published-host port is unbound', async () => {
            const workId = await makeWork({ kind: 'app', managedSubdomain: 'fallback' });
            await deploy(workId, 'READY', {});
            await addDomain(workId, 'shop.example.test', { createdAt: '2026-01-01T00:00:00.000Z' });

            const tile = tileOf(
                await list({ service: buildService({ publishedHosts: undefined }) }),
                workId,
            );

            expect(tile?.host).toBe('shop.example.test');
        });

        it('falls through a published host the port answered but that is not usable', async () => {
            const workId = await makeWork({ kind: 'app', managedSubdomain: 'unusable' });
            await deploy(workId, 'READY', {});

            const bound = buildService({
                publishedHosts: { primary: async () => 'javascript:alert(1)' },
            });

            expect(tileOf(await list({ service: bound }), workId)?.host).toBe(
                `unusable.${APPS_APEX}`,
            );
        });

        it('prefers the earliest verified production domain for a non-app Work (FR-16)', async () => {
            const workId = await makeWork({
                managedSubdomain: 'directory',
                appLauncherExposed: true,
            });
            await deploy(workId, 'READY', { website: 'https://deployed.example.test/' });
            await addDomain(workId, 'second.example.test', {
                createdAt: '2026-06-01T00:00:00.000Z',
            });
            await addDomain(workId, 'first.example.test', {
                createdAt: '2026-01-01T00:00:00.000Z',
            });
            await addDomain(workId, 'unverified.example.test', {
                createdAt: '2025-01-01T00:00:00.000Z',
                verified: false,
            });
            await addDomain(workId, 'staging.example.test', {
                createdAt: '2025-02-01T00:00:00.000Z',
                environment: 'preview',
            });

            expect(tileOf(await list(), workId)?.host).toBe('first.example.test');
        });

        it('falls back to the latest READY deployment address when nothing else resolves', async () => {
            const workId = await makeWork({ appLauncherExposed: true });
            await deploy(workId, 'READY', { website: 'https://deployed.example.test/some/path' });

            expect(tileOf(await list(), workId)).toMatchObject({
                url: 'https://deployed.example.test/',
                host: 'deployed.example.test',
            });
        });

        it('refuses an http address in production and accepts it only in a development installation (FR-32)', async () => {
            const workId = await makeWork({ kind: 'app' });
            await deploy(workId, 'READY', { website: 'http://localhost:4000/' });
            delete process.env.EVER_WORKS_DOMAIN;
            delete process.env.EVER_WORKS_APPS_DOMAIN;

            process.env.NODE_ENV = 'production';
            expect(tileOf(await list({ includeHidden: true }), workId)?.manageState).toBe(
                'notLive',
            );

            process.env.NODE_ENV = 'development';
            expect(tileOf(await list({ includeHidden: true }), workId)).toMatchObject({
                manageState: 'listed',
                url: 'http://localhost:4000/',
            });
        });

        it('drops a catalog entry whose address is not a safe launcher address', async () => {
            const hostile: AppLauncherPlatformInput[] = [
                ...platforms(),
                {
                    key: 'platform:evil',
                    name: 'Evil',
                    url: 'javascript:alert(1)',
                    catalogOrder: 40,
                },
            ];

            const response = await buildService().listForUser({ id: USER }, personal, hostile, {});

            expect(response.items.map((item) => item.key)).not.toContain('platform:evil');
        });
    });

    // ── Scope, pins, meta ───────────────────────────────────────────────────

    describe('scope, pins and meta (FR-24, FR-62, FR-63, FR-64)', () => {
        it('keeps Work pins per Organization and Ever app pins shared (ACC-11-21)', async () => {
            const workA = await makeWork({
                organizationId: ORG_A,
                kind: 'app',
                managedSubdomain: 'org-a',
            });
            await deploy(workA, 'READY', { website: `https://org-a.${APPS_APEX}/` });

            await preferences().upsertMany(USER, [
                { scopeKey: ORG_A, itemKey: keyOf(workA), pinned: true, pinOrder: 0 },
                { scopeKey: 'global', itemKey: 'platform:ever-gauzy', pinned: true, pinOrder: 0 },
            ]);

            const inA = await list({ scope: orgA });
            const inB = await list({ scope: orgB });
            const find = (
                response: { items: Array<{ key: string; pinned: boolean }> },
                key: string,
            ) => response.items.find((item) => item.key === key);

            expect(find(inA, keyOf(workA))?.pinned).toBe(true);
            // Organization B never sees Organization A's Work at all.
            expect(inB.items.map((item) => item.key)).not.toContain(keyOf(workA));

            // Ever app pins are personal across Organizations (FR-24).
            expect(find(inA, 'platform:ever-gauzy')?.pinned).toBe(true);
            expect(find(inB, 'platform:ever-gauzy')?.pinned).toBe(true);
        });

        it('keeps all six pins of an Organization that holds six while another renders none (FR-62)', async () => {
            const workIds: string[] = [];
            for (let index = 0; index < 6; index += 1) {
                const workId = await makeWork({
                    organizationId: ORG_A,
                    kind: 'app',
                    managedSubdomain: `org-a-${index}`,
                });
                await deploy(workId, 'READY', { website: `https://org-a-${index}.${APPS_APEX}/` });
                workIds.push(workId);
            }

            await preferences().upsertMany(
                USER,
                workIds.map((workId, index) => ({
                    scopeKey: ORG_A,
                    itemKey: keyOf(workId),
                    pinned: true,
                    pinOrder: index,
                })),
            );

            const inA = await list({ scope: orgA });
            expect(inA.items.filter((item) => item.pinned)).toHaveLength(6);
            expect(inA.items.filter((item) => item.section === 'pinned')).toHaveLength(6);

            // Nothing was deleted and Organization B is untouched by A's six.
            expect((await list({ scope: orgB })).items.filter((item) => item.pinned)).toHaveLength(
                0,
            );
            const rows = await dataSource
                .getRepository(AppLauncherPreference)
                .find({ where: { userId: USER } });
            expect(rows).toHaveLength(6);
        });

        it('reports the active scope key and the pin limit', async () => {
            const personalResponse = await list();
            expect(personalResponse.meta.scopeKey).toBe('personal');
            expect(personalResponse.meta.pinLimit).toBe(6);

            expect((await list({ scope: orgA })).meta.scopeKey).toBe(ORG_A);
        });

        it('follows the App Works gate for meta.appWorksAvailable (FR-64)', async () => {
            expect((await list()).meta.appWorksAvailable).toBe(false);

            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'true';
            expect((await list()).meta.appWorksAvailable).toBe(true);

            process.env.EVER_WORKS_APP_WORKS_ENABLED = 'false';
            expect((await list()).meta.appWorksAvailable).toBe(false);
        });

        it('marks the running platform as current and never hides it (FR-13)', async () => {
            // A stored row that says the current platform is hidden: FR-13 forbids
            // one, the save path refuses to write one, and a read must not honour it.
            await preferences().upsertMany(USER, [
                { scopeKey: 'global', itemKey: SELF_KEY, visible: false },
            ]);

            const tile = (await list()).items.find((item) => item.key === SELF_KEY);

            expect(tile).toMatchObject({
                current: true,
                visible: true,
                section: 'platforms',
                kind: 'platform',
            });
        });

        it('omits hidden items from the panel and keeps them in Manage apps (FR-27)', async () => {
            const workId = await makeWork({ kind: 'app', managedSubdomain: 'hidden-app' });
            await deploy(workId, 'READY', { website: `https://hidden-app.${APPS_APEX}/` });
            await preferences().upsertMany(USER, [
                { scopeKey: 'personal', itemKey: keyOf(workId), visible: false },
            ]);

            const panel = await list();
            expect(panel.items.map((item) => item.key)).not.toContain(keyOf(workId));

            expect(tileOf(await list({ includeHidden: true }), workId)).toMatchObject({
                visible: false,
                manageState: 'listed',
                url: `https://hidden-app.${APPS_APEX}/`,
            });
        });

        it('keeps a stored order and reports it as the tile order (FR-26)', async () => {
            const first = await makeWork({ kind: 'app', managedSubdomain: 'order-first' });
            const second = await makeWork({ kind: 'app', managedSubdomain: 'order-second' });
            await deploy(first, 'READY', {
                website: `https://order-first.${APPS_APEX}/`,
                createdAt: '2026-03-01T00:00:00.000Z',
            });
            await deploy(second, 'READY', {
                website: `https://order-second.${APPS_APEX}/`,
                createdAt: '2026-01-01T00:00:00.000Z',
            });

            const newestFirst = await list();
            expect(
                newestFirst.items.filter((item) => item.kind === 'work').map((item) => item.key),
            ).toEqual([keyOf(first), keyOf(second)]);

            await preferences().upsertMany(USER, [
                { scopeKey: 'personal', itemKey: keyOf(second), sortOrder: 0 },
                { scopeKey: 'personal', itemKey: keyOf(first), sortOrder: 1 },
            ]);

            const reordered = await list();
            expect(
                reordered.items.filter((item) => item.kind === 'work').map((item) => item.key),
            ).toEqual([keyOf(second), keyOf(first)]);
            expect(
                reordered.items.filter((item) => item.kind === 'work').map((item) => item.order),
            ).toEqual([0, 1]);
        });

        it('caps the response at 200 items and says it truncated (FR-34, FR-63)', async () => {
            const works = dataSource.getRepository(Work);
            const rows = Array.from({ length: 201 }, (_value, index) => {
                sequence += 1;
                return works.create({
                    userId: USER,
                    name: `Bulk ${index}`,
                    slug: `bulk-${sequence}`,
                    description: `Bulk fixture ${index}`,
                    // `'app'` is APW-01's additive member of `WORK_KINDS`; it is written
                    // by raw column value here, exactly as the APW-01 create path will.
                    kind: 'app',
                    status: 'active',
                    organizationId: null,
                    managedSubdomain: `bulk-${index}`,
                    appLauncherExposed: null,
                } as unknown as Partial<Work>);
            });
            await works.save(rows);

            const response = await list({ includeHidden: true, limit: 200 });

            expect(response.items).toHaveLength(200);
            expect(response.meta.truncated).toBe(true);
            expect(response.meta.worksTotal).toBe(201);
        });

        it('is not truncated when everything fits', async () => {
            const workId = await makeWork({ kind: 'app', managedSubdomain: 'fits' });
            await deploy(workId, 'READY', { website: `https://fits.${APPS_APEX}/` });

            const response = await list();

            expect(response.meta.truncated).toBe(false);
            expect(response.meta.worksTotal).toBe(1);
            expect(response.items).toHaveLength(4);
        });

        it('reports the catalog facts its caller resolved (FR-12, S9)', async () => {
            const response = await buildService().listForUser({ id: USER }, personal, platforms(), {
                catalogVersion: '1.0.0',
                catalogAvailable: false,
            });

            expect(response.meta).toMatchObject({
                catalogVersion: '1.0.0',
                catalogAvailable: false,
                environment: 'production',
            });
        });

        it('defaults catalogAvailable to whether any platform was handed in', async () => {
            expect((await list()).meta.catalogAvailable).toBe(true);

            const empty = await buildService().listForUser({ id: USER }, personal, [], {});
            expect(empty.meta.catalogAvailable).toBe(false);
            expect(empty.meta.catalogVersion).toBeNull();
        });

        it('reads nothing for a request with no person (FR-53)', async () => {
            const workId = await makeWork({ kind: 'app', managedSubdomain: 'no-user' });
            await deploy(workId, 'READY', { website: `https://no-user.${APPS_APEX}/` });

            const response = await buildService().listForUser(undefined, personal, platforms(), {});

            expect(response.items).toEqual([]);
            expect(response.meta.worksTotal).toBe(0);
            // The early return is one of the places the response is built, so it
            // owes the client the same fields as the main one (FR-63).
            expect(response.meta.total).toBe(0);
        });
    });

    // ── The Manage apps filter and the eligible count (FR-63) ───────────────

    describe('the Manage apps filter and the eligible count (FR-63)', () => {
        /**
         * `count` eligible Works named `Bulk 001…`, so the name order — which is
         * what a Work that never deployed falls back to (FR-26) — is the numeric
         * order and "item 240" means the 240th.
         */
        async function makeBulkWorks(count: number): Promise<string[]> {
            const works = dataSource.getRepository(Work);
            const rows = Array.from({ length: count }, (_value, index) => {
                sequence += 1;
                return works.create({
                    userId: USER,
                    name: `Bulk ${String(index + 1).padStart(3, '0')}`,
                    slug: `bulk-${sequence}`,
                    description: `Bulk fixture ${index + 1}`,
                    kind: 'app',
                    status: 'active',
                    organizationId: null,
                    managedSubdomain: `bulk-${index + 1}`,
                    appLauncherExposed: null,
                } as unknown as Partial<Work>);
            });
            const saved = await works.save(rows);
            return saved.map((work) => work.id);
        }

        it('reaches the 240th eligible item with a filter, which the cap alone cannot (FR-63)', async () => {
            const ids = await makeBulkWorks(250);
            const target = ids[239];

            const page = await list({ includeHidden: true, limit: 200 });
            expect(page.items).toHaveLength(200);
            expect(page.meta.truncated).toBe(true);
            // Reachability is the whole criterion: today the 240th Work is simply
            // not in the answer, and the client-side filter could only narrow what
            // it already held.
            expect(page.items.map((item) => item.key)).not.toContain(keyOf(target));

            const filtered = await list({
                includeHidden: true,
                limit: 200,
                filter: 'Bulk 240',
            });

            expect(filtered.items.map((item) => item.key)).toEqual([keyOf(target)]);
            expect(tileOf(filtered, target)).toMatchObject({
                kind: 'work',
                name: 'Bulk 240',
                manageState: 'notLive',
            });
        });

        it('reports meta.total as the eligible count, whatever the filter and the cap', async () => {
            await makeBulkWorks(250);

            // 250 Works + the 3 catalog tiles the caller handed in: counted before
            // the filter and before the cap, which is what FR-63's {count} means.
            const page = await list({ includeHidden: true, limit: 200 });
            expect(page.meta.total).toBe(253);
            expect(page.meta.total).not.toBe(page.items.length);

            const filtered = await list({ includeHidden: true, filter: 'Bulk 240' });
            expect(filtered.items).toHaveLength(1);
            expect(filtered.meta.total).toBe(253);

            const noMatch = await list({ includeHidden: true, filter: 'nothing matches this' });
            expect(noMatch.items).toEqual([]);
            expect(noMatch.meta.total).toBe(253);

            const capped = await list({ includeHidden: true, limit: 1 });
            expect(capped.items).toHaveLength(1);
            expect(capped.meta.total).toBe(253);
        });

        it('changes nothing for a blank filter (FR-63)', async () => {
            const ids = await makeBulkWorks(5);
            const workId = ids[0];
            await deploy(workId, 'READY', { website: `https://bulk-live.${APPS_APEX}/` });

            const unfiltered = await list({ includeHidden: true });
            for (const blank of ['', '   ', '\t']) {
                const result = await list({ includeHidden: true, filter: blank });
                expect(result.items.map((item) => item.key)).toEqual(
                    unfiltered.items.map((item) => item.key),
                );
                expect(result.meta.total).toBe(unfiltered.meta.total);
                expect(result.meta.truncated).toBe(unfiltered.meta.truncated);
            }
        });

        it('leaves the order of what it returns alone (FR-26)', async () => {
            const first = await makeWork({ kind: 'app', name: 'Shared newest' });
            const second = await makeWork({ kind: 'app', name: 'Shared middle' });
            const third = await makeWork({ kind: 'app', name: 'Nothing in common' });
            await deploy(first, 'READY', {
                website: `https://shared-newest.${APPS_APEX}/`,
                createdAt: '2026-03-01T00:00:00.000Z',
            });
            await deploy(second, 'READY', {
                website: `https://shared-middle.${APPS_APEX}/`,
                createdAt: '2026-02-01T00:00:00.000Z',
            });
            await deploy(third, 'READY', {
                website: `https://unrelated.${APPS_APEX}/`,
                createdAt: '2026-01-01T00:00:00.000Z',
            });

            const all = await list({ includeHidden: true });
            const filtered = await list({ includeHidden: true, filter: 'shared' });

            // Newest successful production deployment first (FR-26) — and the
            // filter removes whole items rather than re-ranking the ones it keeps.
            expect(
                all.items.filter((item) => item.kind === 'work').map((item) => item.key),
            ).toEqual([keyOf(first), keyOf(second), keyOf(third)]);
            expect(filtered.items.map((item) => item.key)).toEqual([keyOf(first), keyOf(second)]);
            expect(filtered.items.map((item) => item.order)).toEqual([0, 1]);
        });

        it('matches a name case- and accent-insensitively, and only as a substring', async () => {
            const cafe = await makeWork({ kind: 'app', name: 'Café Central' });
            const other = await makeWork({ kind: 'app', name: 'Workshop' });

            const lowercase = await list({ includeHidden: true, filter: 'cafe central' });
            const uppercase = await list({ includeHidden: true, filter: 'CAFÉ' });
            const partial = await list({ includeHidden: true, filter: 'afe cen' });

            expect(lowercase.items.map((item) => item.key)).toEqual([keyOf(cafe)]);
            expect(uppercase.items.map((item) => item.key)).toEqual([keyOf(cafe)]);
            expect(partial.items.map((item) => item.key)).toEqual([keyOf(cafe)]);

            // The control: the matcher is not "everything matches", and a miss
            // still reports the eligible count rather than zero (FR-63).
            const missing = await list({ includeHidden: true, filter: 'zzz' });
            expect(missing.items).toEqual([]);
            expect(missing.meta.total).toBe(5);
            expect(missing.items.map((item) => item.key)).not.toContain(keyOf(other));
        });

        it('filters the panel read as well, over what the panel may show (FR-27)', async () => {
            const live = await makeWork({ kind: 'app', name: 'Shared live' });
            const hidden = await makeWork({ kind: 'app', name: 'Shared hidden' });
            await deploy(live, 'READY', { website: `https://shared-live.${APPS_APEX}/` });
            await preferences().upsertMany(USER, [
                { scopeKey: 'personal', itemKey: keyOf(hidden), visible: false },
            ]);

            const panel = await list({ filter: 'Shared' });
            const manage = await list({ includeHidden: true, filter: 'Shared' });

            expect(panel.items.map((item) => item.key)).toEqual([keyOf(live)]);
            // 3 catalog tiles + the one live Work: the hidden, never-deployed Work
            // is not part of the panel's eligible set at all (FR-27, FR-56).
            expect(panel.meta.total).toBe(4);
            expect(manage.items.map((item) => item.key).sort()).toEqual(
                [keyOf(live), keyOf(hidden)].sort(),
            );
            expect(manage.meta.total).toBe(5);
        });
    });
});

import {
    APPS_MANAGED_REQUIRE_PAID_PLAN_ENV,
    APPS_MAX_PER_PAID_USER_ENV,
    APPS_TIER_ELIGIBILITY_UNAVAILABLE_REASON,
    AppsTierEligibilityService,
} from '../apps-tier-eligibility.service';
import { ConfigAppsTierPolicy, APPS_MANAGED_ENABLED_ENV } from '../config-apps-tier-policy';

/**
 * Lane aw-safety (2026-10-26) — APW-10 T27 / APW-06 T45: who may run an App on Ever Works Apps.
 * Before this, `eligibility()` answered "eligible" for everyone once the tier was open and the
 * per-person cap (`EVER_WORKS_APPS_MAX_PER_USER`, default 3) had no caller.
 */

interface Managed {
    workId: string;
    slug: string;
}

function harness(
    options: {
        emailVerified?: boolean | null;
        userMissing?: boolean;
        ownerId?: string;
        managed?: Managed[];
        countThrows?: boolean;
        plan?: string | null;
        billing?: boolean;
        planThrows?: boolean;
        noPlanReader?: boolean;
        /** 2026-10-27: expose `findStateForWorks` (the managed Works are on the tier). */
        stateRows?: boolean;
        stateThrows?: boolean;
    } = {},
) {
    const counted: Array<{ owner: string; exclude: string | null | undefined }> = [];
    const users = {
        findById: jest.fn(async (id: string) =>
            options.userMissing
                ? null
                : { id, emailVerified: 'emailVerified' in options ? options.emailVerified : true },
        ),
    };
    const works = {
        findById: jest.fn(async (id: string) => ({
            id,
            userId: options.ownerId ?? 'owner-1',
            kind: 'app',
        })),
    };
    const states = {
        countManagedForOwner: jest.fn(
            async (owner: string, opts: { excludeWorkId?: string | null }) => {
                counted.push({ owner, exclude: opts?.excludeWorkId });
                if (options.countThrows) throw new Error('db down');
                const others = (options.managed ?? []).filter(
                    (m) => m.workId !== opts?.excludeWorkId,
                );
                return { count: others.length, names: others.map((m) => m.slug) };
            },
        ),
        ...(options.stateRows
            ? {
                  findStateForWorks: jest.fn(async (ids: string[]) => {
                      if (options.stateThrows) throw new Error('db down');
                      const on = new Set((options.managed ?? []).map((m) => m.workId));
                      return new Map(
                          ids
                              .filter((id) => on.has(id))
                              .map((id) => [
                                  id,
                                  {
                                      workId: id,
                                      target: 'ever-works-apps',
                                      removedAt: null,
                                      currentDeploymentId: `dep-${id}`,
                                      namespace: `ewapp-${id}`,
                                  },
                              ]),
                      );
                  }),
              }
            : {}),
    };
    const plans = {
        isEnabled: () => options.billing ?? true,
        resolvePlanForUser: jest.fn(async () => {
            if (options.planThrows) throw new Error('billing db down');
            return options.plan === null ? null : { code: options.plan ?? 'free' };
        }),
    };
    const service = new AppsTierEligibilityService(
        users as never,
        works as never,
        states as never,
        options.noPlanReader ? undefined : plans,
    );
    return { service, counted, users, works, states, plans };
}

const three: Managed[] = [
    { workId: 'w-1', slug: 'cal' },
    { workId: 'w-2', slug: 'umami' },
    { workId: 'w-3', slug: 'ghost' },
];

describe('AppsTierEligibilityService — FR-35, in the order the spec lists the reasons', () => {
    const saved = { ...process.env };
    afterEach(() => {
        process.env = { ...saved };
    });

    it('admits a verified owner under the cap', async () => {
        const h = harness({ managed: three.slice(0, 2) });

        await expect(h.service.evaluate('owner-1', { workId: 'w-9' })).resolves.toMatchObject({
            eligible: true,
            reasons: [],
            max: 3,
        });
    });

    it('refuses the 4th App Work with capReached, naming the three counted', async () => {
        const h = harness({ managed: three });

        const answer = await h.service.evaluate('owner-1', { workId: 'w-4' });

        expect(answer).toMatchObject({ eligible: false, reasons: ['capReached'], max: 3 });
        expect(answer.counted).toEqual(['cal', 'umami', 'ghost']);
        expect(h.counted).toEqual([{ owner: 'owner-1', exclude: 'w-4' }]);
    });

    it('never counts the Work being deployed against itself — a redeploy of one of the three passes', async () => {
        const h = harness({ managed: three });

        await expect(h.service.evaluate('owner-1', { workId: 'w-2' })).resolves.toMatchObject({
            eligible: true,
        });
    });

    it('reads the configured cap (EVER_WORKS_APPS_MAX_PER_USER), not a constant', async () => {
        process.env.EVER_WORKS_APPS_MAX_PER_USER = '5';
        const h = harness({ managed: three });

        await expect(h.service.evaluate('owner-1', { workId: 'w-4' })).resolves.toMatchObject({
            eligible: true,
            max: 5,
        });
    });

    it('counts the Work OWNER’s Apps when a member deploys', async () => {
        const h = harness({ ownerId: 'owner-1', managed: three });

        await h.service.evaluate('member-7', { workId: 'w-4' });

        expect(h.counted[0].owner).toBe('owner-1');
    });

    it.each([
        ['an unverified email', { emailVerified: false }],
        ['an unknown email state', { emailVerified: null }],
        ['an account that cannot be found', { userMissing: true }],
    ])('refuses %s with emailUnverified', async (_label, options) => {
        const h = harness(options);

        await expect(h.service.evaluate('owner-1', { workId: 'w-4' })).resolves.toMatchObject({
            eligible: false,
            reasons: expect.arrayContaining(['emailUnverified']),
        });
    });

    it('fails CLOSED when the Apps cannot be counted — open never means unlimited', async () => {
        const h = harness({ countThrows: true });

        await expect(h.service.evaluate('owner-1', { workId: 'w-4' })).resolves.toMatchObject({
            eligible: false,
            reasons: [APPS_TIER_ELIGIBILITY_UNAVAILABLE_REASON],
        });
    });

    it('fails closed with no repositories at all', async () => {
        const service = new AppsTierEligibilityService();

        await expect(service.evaluate('owner-1', { workId: 'w-4' })).resolves.toMatchObject({
            eligible: false,
            reasons: [APPS_TIER_ELIGIBILITY_UNAVAILABLE_REASON],
        });
    });

    it('skips the cap when no Work is named (the GET target card) — the deploy is where it bites', async () => {
        const h = harness({ managed: three });

        await expect(h.service.evaluate('owner-1')).resolves.toMatchObject({ eligible: true });
        expect(h.counted).toEqual([]);
    });

    describe('planRequired — off by default (owner question)', () => {
        it('does not read the plan unless the switch is on', async () => {
            const h = harness({ plan: 'free' });

            await expect(h.service.evaluate('owner-1', { workId: 'w-4' })).resolves.toMatchObject({
                eligible: true,
            });
        });

        it('refuses a free plan when the switch is on', async () => {
            process.env[APPS_MANAGED_REQUIRE_PAID_PLAN_ENV] = 'true';
            const h = harness({ plan: 'free' });

            await expect(h.service.evaluate('owner-1', { workId: 'w-4' })).resolves.toMatchObject({
                eligible: false,
                reasons: ['planRequired'],
            });
        });

        it('admits a paid plan, and admits everyone when billing is switched off', async () => {
            process.env[APPS_MANAGED_REQUIRE_PAID_PLAN_ENV] = 'true';

            await expect(
                harness({ plan: 'standard' }).service.evaluate('owner-1', { workId: 'w-4' }),
            ).resolves.toMatchObject({ eligible: true });
            await expect(
                harness({ plan: 'free', billing: false }).service.evaluate('owner-1', {
                    workId: 'w-4',
                }),
            ).resolves.toMatchObject({ eligible: true });
        });
    });
});

/** `n` managed App Works `w-1`...`w-n` (slugs `app-1`...`app-n`). */
function managedApps(n: number): Managed[] {
    return Array.from({ length: n }, (_, i) => ({ workId: `w-${i + 1}`, slug: `app-${i + 1}` }));
}

describe('the cap depends on the owner plan (owner decision 2026-10-27)', () => {
    // "max 3 managed apps per owner of an UNPAID plan, verified email required, paid plans can
    // host more than 3 apps."
    const saved = { ...process.env };
    beforeEach(() => {
        delete process.env.EVER_WORKS_APPS_MAX_PER_USER;
        delete process.env[APPS_MAX_PER_PAID_USER_ENV];
        delete process.env[APPS_MANAGED_REQUIRE_PAID_PLAN_ENV];
    });
    afterEach(() => {
        process.env = { ...saved };
    });

    it('refuses a FREE owner at 3 with capReached, and says a paid plan allows more', async () => {
        const h = harness({ plan: 'free', managed: managedApps(3), stateRows: true });

        const answer = await h.service.evaluate('owner-1', { workId: 'w-new' });

        expect(answer).toMatchObject({
            eligible: false,
            reasons: ['capReached'],
            max: 3,
            paidPlanAllowsMore: true,
        });
        expect(answer.counted).toEqual(['app-1', 'app-2', 'app-3']);
    });

    it('treats the self-hosted community plan as unpaid (the #2914 plan codes, reused)', async () => {
        const h = harness({ plan: 'selfhosted_community', managed: managedApps(3) });

        await expect(h.service.evaluate('owner-1', { workId: 'w-new' })).resolves.toMatchObject({
            eligible: false,
            reasons: ['capReached'],
        });
    });

    it('admits a PAID owner who already runs 5 (EVER_WORKS_APPS_MAX_PER_PAID_USER unset = no limit)', async () => {
        const h = harness({ plan: 'standard', managed: managedApps(5) });

        const answer = await h.service.evaluate('owner-1', { workId: 'w-new' });

        expect(answer).toEqual({ eligible: true, reasons: [] });
        // No cap applies, so nothing is counted (and a count failure cannot refuse them).
        expect(h.counted).toEqual([]);
    });

    it('admits a paid owner far past the free cap (premium, 40 Apps)', async () => {
        const h = harness({ plan: 'premium', managed: managedApps(40) });

        await expect(h.service.evaluate('owner-1', { workId: 'w-new' })).resolves.toMatchObject({
            eligible: true,
        });
    });

    it('refuses a paid owner at EVER_WORKS_APPS_MAX_PER_PAID_USER=10 with capReached, without the upgrade hint', async () => {
        process.env[APPS_MAX_PER_PAID_USER_ENV] = '10';
        const h = harness({ plan: 'standard', managed: managedApps(10), stateRows: true });

        const answer = await h.service.evaluate('owner-1', { workId: 'w-new' });

        expect(answer).toMatchObject({ eligible: false, reasons: ['capReached'], max: 10 });
        expect(answer.counted).toHaveLength(10);
        expect(answer.paidPlanAllowsMore).toBeUndefined();
    });

    it('admits a paid owner under EVER_WORKS_APPS_MAX_PER_PAID_USER=10 (9 others)', async () => {
        process.env[APPS_MAX_PER_PAID_USER_ENV] = '10';
        const h = harness({ plan: 'standard', managed: managedApps(9) });

        await expect(h.service.evaluate('owner-1', { workId: 'w-new' })).resolves.toMatchObject({
            eligible: true,
            max: 10,
        });
    });

    it('a free owner still hits the free cap when a paid cap is set; the hint stays while a paid plan would admit', async () => {
        process.env[APPS_MAX_PER_PAID_USER_ENV] = '10';
        const h = harness({ plan: 'free', managed: managedApps(3) });

        await expect(h.service.evaluate('owner-1', { workId: 'w-new' })).resolves.toMatchObject({
            eligible: false,
            reasons: ['capReached'],
            max: 3,
            paidPlanAllowsMore: true,
        });
    });

    it('no upgrade hint when a paid plan would not admit the App either (paid cap = free cap)', async () => {
        process.env[APPS_MAX_PER_PAID_USER_ENV] = '3';
        const h = harness({ plan: 'free', managed: managedApps(3) });

        const answer = await h.service.evaluate('owner-1', { workId: 'w-new' });

        expect(answer).toMatchObject({ eligible: false, reasons: ['capReached'] });
        expect(answer.paidPlanAllowsMore).toBeUndefined();
    });

    describe('fails CLOSED for the extra allowance: an unreadable plan is a free plan', () => {
        it('a plan read that throws => the free cap applies (5 Apps: a NEW one is refused), not eligibilityUnavailable', async () => {
            const h = harness({ plan: 'standard', planThrows: true, managed: managedApps(5) });

            const answer = await h.service.evaluate('owner-1', { workId: 'w-new' });

            expect(answer).toMatchObject({ eligible: false, reasons: ['capReached'], max: 3 });
            // Unknown plan: the member is not told to upgrade (they may already be paying).
            expect(answer.paidPlanAllowsMore).toBeUndefined();
        });

        it('a plan read that throws still admits a free-sized footprint (2 others)', async () => {
            const h = harness({ planThrows: true, managed: managedApps(2) });

            await expect(h.service.evaluate('owner-1', { workId: 'w-new' })).resolves.toMatchObject(
                { eligible: true, max: 3 },
            );
        });

        it('no plan reader bound => the free cap', async () => {
            const h = harness({ noPlanReader: true, managed: managedApps(3) });

            await expect(h.service.evaluate('owner-1', { workId: 'w-new' })).resolves.toMatchObject(
                { eligible: false, reasons: ['capReached'], max: 3 },
            );
        });

        it('a plan with no code => unpaid => the free cap', async () => {
            const h = harness({ plan: null, managed: managedApps(3) });

            await expect(h.service.evaluate('owner-1', { workId: 'w-new' })).resolves.toMatchObject(
                { eligible: false, reasons: ['capReached'], max: 3 },
            );
        });

        it('billing switched off => no one is on a paid plan => the free cap, and no upgrade hint', async () => {
            const h = harness({ plan: 'premium', billing: false, managed: managedApps(3) });

            const answer = await h.service.evaluate('owner-1', { workId: 'w-new' });

            expect(answer).toMatchObject({ eligible: false, reasons: ['capReached'], max: 3 });
            expect(answer.paidPlanAllowsMore).toBeUndefined();
        });
    });

    describe('a redeploy of an existing App is never refused', () => {
        it.each<[string, Parameters<typeof harness>[0], string | undefined]>([
            ['a free owner at 3', { plan: 'free', managed: managedApps(3) }, undefined],
            [
                'a free owner OVER the cap (5, e.g. after a downgrade)',
                { plan: 'free', managed: managedApps(5) },
                undefined,
            ],
            [
                'a paid owner at EVER_WORKS_APPS_MAX_PER_PAID_USER=10',
                { plan: 'standard', managed: managedApps(10) },
                '10',
            ],
            [
                'a paid owner with 5 whose plan cannot be read',
                { plan: 'standard', planThrows: true, managed: managedApps(5) },
                undefined,
            ],
        ])('%s, redeploying w-2', async (_label, options, paidCap) => {
            if (paidCap) process.env[APPS_MAX_PER_PAID_USER_ENV] = paidCap;
            const h = harness({ ...options, stateRows: true });

            await expect(h.service.evaluate('owner-1', { workId: 'w-2' })).resolves.toMatchObject({
                eligible: true,
                reasons: [],
            });
            // The Work is still never counted against itself.
            expect(h.counted.every((c) => c.exclude === 'w-2')).toBe(true);
        });

        it('but a NEW App of an owner over the cap is refused', async () => {
            const h = harness({ plan: 'free', managed: managedApps(5), stateRows: true });

            await expect(h.service.evaluate('owner-1', { workId: 'w-new' })).resolves.toMatchObject(
                { eligible: false, reasons: ['capReached'] },
            );
        });

        it('an unreadable runtime state keeps the cap (fail closed)', async () => {
            const h = harness({
                plan: 'free',
                managed: managedApps(5),
                stateRows: true,
                stateThrows: true,
            });

            await expect(h.service.evaluate('owner-1', { workId: 'w-2' })).resolves.toMatchObject({
                eligible: false,
                reasons: ['capReached'],
            });
        });
    });

    it('reads the plan once per evaluation, also with planRequired on', async () => {
        process.env[APPS_MANAGED_REQUIRE_PAID_PLAN_ENV] = 'true';
        const h = harness({ plan: 'standard', managed: managedApps(5) });

        await expect(h.service.evaluate('owner-1', { workId: 'w-new' })).resolves.toMatchObject({
            eligible: true,
        });
        expect(h.plans.resolvePlanForUser).toHaveBeenCalledTimes(1);
    });

    it('EVER_WORKS_APPS_MANAGED_REQUIRE_PAID_PLAN keeps working: a free owner under the cap is refused planRequired', async () => {
        process.env[APPS_MANAGED_REQUIRE_PAID_PLAN_ENV] = 'true';
        const h = harness({ plan: 'free', managed: managedApps(1) });

        await expect(h.service.evaluate('owner-1', { workId: 'w-new' })).resolves.toMatchObject({
            eligible: false,
            reasons: ['planRequired'],
        });
    });

    it('EVER_WORKS_APPS_MANAGED_REQUIRE_PAID_PLAN with an unreadable plan still refuses eligibilityUnavailable (unchanged)', async () => {
        process.env[APPS_MANAGED_REQUIRE_PAID_PLAN_ENV] = 'true';
        const h = harness({ planThrows: true, managed: managedApps(1) });

        await expect(h.service.evaluate('owner-1', { workId: 'w-new' })).resolves.toMatchObject({
            eligible: false,
            reasons: [APPS_TIER_ELIGIBILITY_UNAVAILABLE_REASON],
        });
    });

    it('a verified email stays required for a paid owner too', async () => {
        const h = harness({ plan: 'premium', emailVerified: false, managed: managedApps(5) });

        await expect(h.service.evaluate('owner-1', { workId: 'w-new' })).resolves.toMatchObject({
            eligible: false,
            reasons: ['emailUnverified'],
        });
    });

    it('does not read the plan when no Work is named and planRequired is off (unchanged)', async () => {
        const h = harness({ plan: 'standard' });

        await h.service.evaluate('owner-1');

        expect(h.plans.resolvePlanForUser).not.toHaveBeenCalled();
    });
});

describe('ConfigAppsTierPolicy.eligibility reads the source once the tier is open', () => {
    it('stays tierClosed-shaped while the tier is closed, without asking the source', async () => {
        const source = { evaluate: jest.fn() };
        const policy = new ConfigAppsTierPolicy({}, source);

        const answer = await policy.eligibility('owner-1', { workId: 'w-1' });

        expect(answer.eligible).toBe(false);
        expect(source.evaluate).not.toHaveBeenCalled();
    });

    it('delegates when open, passing the Work through', async () => {
        const source = {
            evaluate: jest.fn(async () => ({
                eligible: false,
                reasons: ['capReached'],
                counted: ['cal'],
            })),
        };
        const policy = new ConfigAppsTierPolicy({ [APPS_MANAGED_ENABLED_ENV]: 'true' }, source);

        await expect(policy.eligibility('owner-1', { workId: 'w-1' })).resolves.toMatchObject({
            eligible: false,
            reasons: ['capReached'],
            counted: ['cal'],
        });
        expect(source.evaluate).toHaveBeenCalledWith('owner-1', { workId: 'w-1' });
    });

    it('passes paidPlanAllowsMore through (only a literal true)', async () => {
        const answer = (paidPlanAllowsMore: unknown) =>
            new ConfigAppsTierPolicy(
                { [APPS_MANAGED_ENABLED_ENV]: 'true' },
                {
                    evaluate: async () =>
                        ({
                            eligible: false,
                            reasons: ['capReached'],
                            max: 3,
                            paidPlanAllowsMore,
                        }) as never,
                },
            ).eligibility('owner-1', { workId: 'w-1' });

        await expect(answer(true)).resolves.toMatchObject({ paidPlanAllowsMore: true, max: 3 });
        await expect(answer('yes')).resolves.not.toHaveProperty('paidPlanAllowsMore');
    });

    it('fails CLOSED when open and the binding found no source (was: eligible for everyone)', async () => {
        const policy = new ConfigAppsTierPolicy({ [APPS_MANAGED_ENABLED_ENV]: 'true' }, null);

        await expect(policy.eligibility('owner-1')).resolves.toEqual({
            eligible: false,
            reasons: [APPS_TIER_ELIGIBILITY_UNAVAILABLE_REASON],
        });
    });

    it('keeps the lean answer when constructed without a source argument (unit specs, lean contexts)', async () => {
        const policy = new ConfigAppsTierPolicy({ [APPS_MANAGED_ENABLED_ENV]: 'true' });

        await expect(policy.eligibility('owner-1')).resolves.toEqual({
            eligible: true,
            reasons: [],
        });
    });

    it('admits on a transport failure only when told the request was checked upstream (the worker)', async () => {
        const failing = {
            evaluate: async () => Promise.reject(new Error('Unknown remote target')),
        };
        const worker = new ConfigAppsTierPolicy({ [APPS_MANAGED_ENABLED_ENV]: 'true' }, failing, {
            onSourceFailure: 'admit',
        });

        await expect(worker.eligibility('owner-1', { workId: 'w-1' })).resolves.toEqual({
            eligible: true,
            reasons: [],
        });
    });

    it('fails closed when the source throws', async () => {
        const policy = new ConfigAppsTierPolicy(
            { [APPS_MANAGED_ENABLED_ENV]: 'true' },
            { evaluate: async () => Promise.reject(new Error('rpc down')) },
        );

        await expect(policy.eligibility('owner-1')).resolves.toMatchObject({ eligible: false });
    });
});

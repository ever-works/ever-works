import {
    APPS_MANAGED_REQUIRE_PAID_PLAN_ENV,
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
    } = {},
) {
    const counted: Array<{ owner: string; exclude: string | null | undefined }> = [];
    const users = {
        findById: jest.fn(async (id: string) =>
            options.userMissing ? null : { id, emailVerified: options.emailVerified ?? true },
        ),
    };
    const works = {
        findById: jest.fn(async (id: string) => ({ id, userId: options.ownerId ?? 'owner-1', kind: 'app' })),
    };
    const states = {
        countManagedForOwner: jest.fn(async (owner: string, opts: { excludeWorkId?: string | null }) => {
            counted.push({ owner, exclude: opts?.excludeWorkId });
            if (options.countThrows) throw new Error('db down');
            const others = (options.managed ?? []).filter((m) => m.workId !== opts?.excludeWorkId);
            return { count: others.length, names: others.map((m) => m.slug) };
        }),
    };
    const plans = {
        isEnabled: () => options.billing ?? true,
        resolvePlanForUser: async () => (options.plan === null ? null : { code: options.plan ?? 'free' }),
    };
    const service = new AppsTierEligibilityService(
        users as never,
        works as never,
        states as never,
        plans,
    );
    return { service, counted, users, works, states };
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
                harness({ plan: 'free', billing: false }).service.evaluate('owner-1', { workId: 'w-4' }),
            ).resolves.toMatchObject({ eligible: true });
        });
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
            evaluate: jest.fn(async () => ({ eligible: false, reasons: ['capReached'], counted: ['cal'] })),
        };
        const policy = new ConfigAppsTierPolicy({ [APPS_MANAGED_ENABLED_ENV]: 'true' }, source);

        await expect(policy.eligibility('owner-1', { workId: 'w-1' })).resolves.toMatchObject({
            eligible: false,
            reasons: ['capReached'],
            counted: ['cal'],
        });
        expect(source.evaluate).toHaveBeenCalledWith('owner-1', { workId: 'w-1' });
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

        await expect(policy.eligibility('owner-1')).resolves.toEqual({ eligible: true, reasons: [] });
    });

    it('admits on a transport failure only when told the request was checked upstream (the worker)', async () => {
        const failing = { evaluate: async () => Promise.reject(new Error('Unknown remote target')) };
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

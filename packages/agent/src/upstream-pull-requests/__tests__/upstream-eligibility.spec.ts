import { decideUpstreamEligibility, type UpstreamEligibilityFacts } from '../upstream-eligibility.rules';
import { UpstreamEligibilityService } from '../upstream-eligibility.service';

/**
 * APW-09 T8/T9 — eligibility: every refusal code has a case that fails without its gate, the
 * order is the documented one, and the service reads the member's OWN connection, the App
 * spec's opt-in and `maxOpen`, and fails closed when a collaborator is missing.
 */

const allowed: UpstreamEligibilityFacts = {
    killSwitchOn: true,
    relation: 'fork',
    hasUpstream: true,
    denied: false,
    optedIn: true,
    task: { prState: 'merged' },
    activeRecordId: null,
    connectionUsable: true,
    limits: null,
};

describe('decideUpstreamEligibility', () => {
    it('allows a merged Task on an opted-in fork with a usable connection and room in every limit', () => {
        expect(decideUpstreamEligibility(allowed)).toEqual({ allowed: true });
    });

    it.each<[string, Partial<UpstreamEligibilityFacts>, string]>([
        ['the operator switch is off', { killSwitchOn: false }, 'disabled'],
        ['a private copy', { relation: 'private-copy' }, 'notFork'],
        ['a link', { relation: 'link' }, 'notFork'],
        ['no recorded relation', { relation: null }, 'notFork'],
        ['no upstream', { hasUpstream: false }, 'notFork'],
        ['a denied upstream', { denied: true }, 'deniedUpstream'],
        ['the App spec has not opted in', { optedIn: false }, 'disabled'],
        ['the Task is not on this Work', { task: null }, 'taskNotOnWork'],
        ['the source Task is not merged', { task: { prState: 'open' } }, 'sourceNotMerged'],
        ['the source Task has no pull request', { task: { prState: null } }, 'sourceNotMerged'],
        ['an active record exists', { activeRecordId: 'r1' }, 'activeProposal'],
        ['the connection is unusable', { connectionUsable: false }, 'connectionScope'],
    ])('refuses when %s', (_label, change, code) => {
        expect(decideUpstreamEligibility({ ...allowed, ...change })).toMatchObject({
            allowed: false,
            code,
        });
    });

    it('carries the limit, its value and the next slot of a limit refusal (FR-27)', () => {
        expect(
            decideUpstreamEligibility({
                ...allowed,
                limits: {
                    code: 'rateLimited',
                    limit: 'openedPerUpstreamPer24h',
                    limitValue: 1,
                    nextSlotAt: '2026-10-28T10:00:00.000Z',
                },
            }),
        ).toEqual({
            allowed: false,
            code: 'rateLimited',
            limit: 'openedPerUpstreamPer24h',
            limitValue: 1,
            nextSlotAt: '2026-10-28T10:00:00.000Z',
        });
    });

    it('checks the operator switch before anything else, and the deny list before the opt-in', () => {
        expect(
            decideUpstreamEligibility({ ...allowed, killSwitchOn: false, relation: 'link', denied: true })
                .allowed === false &&
                (decideUpstreamEligibility({ ...allowed, killSwitchOn: false, relation: 'link' }) as {
                    code: string;
                }).code,
        ).toBe('disabled');
        expect(
            (decideUpstreamEligibility({ ...allowed, denied: true, optedIn: false }) as { code: string }).code,
        ).toBe('deniedUpstream');
    });
});

describe('UpstreamEligibilityService', () => {
    const saved = { ...process.env };
    afterEach(() => {
        process.env = { ...saved };
    });

    function work(type = 'app_fork') {
        return {
            id: 'w1',
            userId: 'owner',
            kind: 'app',
            sourceRepository: {
                type,
                owner: 'maya',
                repo: 'bookings',
                upstream: { owner: 'acme', repo: 'bookings', defaultBranch: 'main' },
            },
            getRepoOwner: () => 'maya',
            getDataRepo: () => 'bookings-data',
            getWebsiteRepo: () => 'bookings',
        };
    }

    function build(
        options: {
            work?: ReturnType<typeof work>;
            spec?: { enabled?: boolean; maxOpen?: number } | null;
            prState?: string | null;
            active?: { id: string } | null;
            usable?: boolean;
            openedOnUpstream?: Date[];
            open?: number;
        } = {},
    ) {
        const works = { findById: jest.fn(async () => options.work ?? work()) };
        const tasks = {
            findById: jest.fn(async (id: string) =>
                id === 't1' ? { id: 't1', workId: 'w1', prState: options.prState ?? 'merged' } : null,
            ),
        };
        const records = {
            findLatestForUser: jest.fn(async () => null),
            findActiveBySourceTask: jest.fn(async () => options.active ?? null),
            openedAtInWindow: jest.fn(async (scope: { userId?: string }) =>
                scope.userId ? [] : (options.openedOnUpstream ?? []),
            ),
            countOpenByUserOnUpstream: jest.fn(async () => options.open ?? 0),
        };
        const appSpec = {
            getEffectiveSpec: jest.fn(async () => ({
                spec:
                    options.spec === null
                        ? null
                        : { upstreamPullRequests: options.spec ?? { enabled: true } },
            })),
        };
        const credentials = {
            resolveForPublishingMember: jest.fn(async () => ({ usable: options.usable ?? true })),
        };
        const service = new UpstreamEligibilityService(
            works as never,
            tasks as never,
            records as never,
            appSpec as never,
            credentials as never,
        );
        return { service, credentials, records, appSpec };
    }

    it('answers allowed with the target, and marks preparation unavailable', async () => {
        const { service, credentials } = build();
        const view = await service.evaluate({ workId: 'w1', userId: 'maya-user', taskId: 't1' });
        expect(view).toMatchObject({
            allowed: true,
            relation: 'fork',
            preparationAvailable: false,
            maintainerCanModifyDefault: true,
            target: { owner: 'acme', repo: 'bookings', baseBranch: 'main', forkOwner: 'maya', forkRepo: 'bookings' },
        });
        // FR-24: the caller's OWN connection is what is checked — never a Work-resolved token.
        expect(credentials.resolveForPublishingMember).toHaveBeenCalledWith('w1', 'maya-user');
    });

    it('refuses a private copy with notFork and never reads the connection', async () => {
        const { service, credentials } = build({ work: work('app_private_copy') });
        const view = await service.evaluate({ workId: 'w1', userId: 'u', taskId: 't1' });
        expect(view).toMatchObject({ allowed: false, code: 'notFork', relation: 'private-copy' });
        expect(credentials.resolveForPublishingMember).not.toHaveBeenCalled();
    });

    it('refuses an App Work whose spec has not opted in, and one whose spec cannot be read', async () => {
        await expect(
            build({ spec: { enabled: false } }).service.evaluate({ workId: 'w1', userId: 'u' }),
        ).resolves.toMatchObject({ allowed: false, code: 'disabled' });
        await expect(
            build({ spec: null }).service.evaluate({ workId: 'w1', userId: 'u' }),
        ).resolves.toMatchObject({ allowed: false, code: 'disabled' });
    });

    it('refuses while the operator switch is off, and a denied upstream', async () => {
        process.env.APP_WORKS_UPSTREAM_PRS_ENABLED = 'false';
        await expect(build().service.evaluate({ workId: 'w1', userId: 'u' })).resolves.toMatchObject({
            code: 'disabled',
        });
        process.env.APP_WORKS_UPSTREAM_PRS_ENABLED = 'true';
        process.env.APP_WORKS_UPSTREAM_DENY_LIST = 'ACME/Bookings';
        await expect(build().service.evaluate({ workId: 'w1', userId: 'u' })).resolves.toMatchObject({
            code: 'deniedUpstream',
        });
    });

    it('refuses an unmerged source Task, flags a foreign Task, and names the active record', async () => {
        await expect(
            build({ prState: 'open' }).service.evaluate({ workId: 'w1', userId: 'u', taskId: 't1' }),
        ).resolves.toMatchObject({ allowed: false, code: 'sourceNotMerged' });
        await expect(
            build().service.evaluate({ workId: 'w1', userId: 'u', taskId: 't-other' }),
        ).resolves.toMatchObject({ allowed: false, taskNotOnWork: true });
        await expect(
            build({ active: { id: 'r9' } }).service.evaluate({ workId: 'w1', userId: 'u', taskId: 't1' }),
        ).resolves.toMatchObject({ allowed: false, activeProposalId: 'r9' });
    });

    it('refuses an unusable connection with connectionScope', async () => {
        await expect(
            build({ usable: false }).service.evaluate({ workId: 'w1', userId: 'u', taskId: 't1' }),
        ).resolves.toMatchObject({ allowed: false, code: 'connectionScope' });
    });

    it('honours the App spec maxOpen per App Work (G15)', async () => {
        await expect(
            build({ spec: { enabled: true, maxOpen: 1 }, open: 1 }).service.evaluate({ workId: 'w1', userId: 'u' }),
        ).resolves.toMatchObject({ allowed: false, code: 'rateLimited', limit: 'openPerUpstream', limitValue: 1 });
        await expect(
            build({ spec: { enabled: true, maxOpen: 5 }, open: 4 }).service.evaluate({ workId: 'w1', userId: 'u' }),
        ).resolves.toMatchObject({ allowed: true });
    });

    it('refuses on the platform ceiling with the next slot', async () => {
        const now = new Date('2026-10-27T12:00:00.000Z');
        const opened = [1, 2, 3, 4, 5].map((h) => new Date(now.getTime() - h * 3_600_000));
        const view = await build({ openedOnUpstream: opened.reverse() }).service.evaluate({
            workId: 'w1',
            userId: 'u',
            now,
        });
        expect(view).toMatchObject({
            allowed: false,
            code: 'platformCapReached',
            limit: 'platformOpenedPerUpstreamPer24h',
            limitValue: 5,
        });
        expect(view.nextSlotAt).toBe(new Date(now.getTime() - 5 * 3_600_000 + 86_400_000).toISOString());
    });

    it('fails closed with no record store', async () => {
        const service = new UpstreamEligibilityService(
            { findById: async () => work() } as never,
            undefined,
            undefined,
            undefined,
            undefined,
        );
        await expect(service.evaluate({ workId: 'w1', userId: 'u' })).resolves.toMatchObject({
            allowed: false,
            code: 'disabled',
        });
    });
});

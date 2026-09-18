import {
    UPSTREAM_CREDENTIAL_I18N,
    UPSTREAM_CREDENTIAL_REQUIRED_SCOPES,
    UpstreamCredentialNotFoundError,
    UpstreamCredentialService,
} from '../upstream-credential.service';

/**
 * APW-09 T43 — the credential of record and its handover (FR-43, XC-18,
 * ACC-09-32).
 *
 * The claims this spec exists to pin, in the order the requirement makes them:
 *
 *   1. **The recorded member is the fork's creator.** Forking is done with the
 *      member who created the App Work (APW-01 FR-15, D2), so that member is
 *      the credential of record — and a handover is the only thing that moves
 *      it (`spec.md:343-352`).
 *   2. **An unusable credential pauses the job with the reason and makes no
 *      provider call.** Each of FR-43's four reasons is derived from local
 *      state, the paused resolution carries no token at all, and the provider
 *      spies below *throw* — so a job that touched the provider while paused
 *      would fail this spec rather than pass it quietly.
 *   3. **A handover changes the credential for work not yet started and
 *      re-authors nothing.** It needs edit access, it is refused by name when
 *      it cannot be recorded durably, and it makes no provider call.
 *   4. **Preparation and push keep the publishing member's own token
 *      (FR-24), never the credential of record.** Two distinct members, two
 *      distinct tokens, asserted in **both** directions: the background path
 *      never answers with the publisher's token and the publishing path never
 *      answers with the record's — including after a handover, which must not
 *      touch the publishing path at all.
 *
 * ## Why the provider spies throw
 *
 * `makeGit` hands back a facade whose provider-facing methods reject loudly. A
 * "makes no provider call" assertion that only counted calls would pass for a
 * service that called them and swallowed the failure; these throw through the
 * `await`, so the claim is proven by the resolution the caller received.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORK_ID = '99999999-9999-4999-8999-999999999999';

const CREATOR_ID = '22222222-2222-4222-8222-222222222222';
const PUBLISHER_ID = '33333333-3333-4333-8333-333333333333';
const EDITOR_ID = '44444444-4444-4444-8444-444444444444';
const VIEWER_ID = '55555555-5555-4555-8555-555555555555';
const DEPARTED_ID = '66666666-6666-4666-8666-666666666666';

const CREATOR_TOKEN = 'creator-member-token';
const PUBLISHER_TOKEN = 'publisher-member-token';
const EDITOR_TOKEN = 'editor-member-token';
const PLATFORM_TOKEN = 'platform-pat-or-installation-token';

/** A Work row as `WorkRepository.findById` returns it (`user` is eager). */
function makeWork(overrides: Record<string, unknown> = {}) {
    const work = {
        id: WORK_ID,
        userId: CREATOR_ID,
        gitProvider: 'github',
        user: { id: CREATOR_ID, username: 'creator-login' },
        isCreator(this: { userId: string }, userId: string) {
            return this.userId === userId;
        },
        ...overrides,
    };

    return work;
}

/** An `AuthAccount` row as the repository returns it. */
function makeAccount(overrides: Record<string, unknown> = {}) {
    return {
        userId: CREATOR_ID,
        providerId: 'plugin:github',
        accessToken: CREATOR_TOKEN,
        scope: 'repo',
        accessTokenExpiresAt: null as Date | null,
        username: 'creator-login',
        metadata: { login: 'creator-login' },
        ...overrides,
    };
}

/** The token each member's own connection answers with. */
const TOKENS: Record<string, string> = {
    [CREATOR_ID]: CREATOR_TOKEN,
    [PUBLISHER_ID]: PUBLISHER_TOKEN,
    [EDITOR_ID]: EDITOR_TOKEN,
};

/**
 * The connections every member has **by default**: each one is usable, so a
 * test that pauses a member has to say so explicitly (`connected: { [id]: null }`)
 * and cannot pass by accident on an empty fixture.
 */
const DEFAULT_CONNECTIONS: Record<string, Record<string, unknown>> = {
    [CREATOR_ID]: makeAccount(),
    [PUBLISHER_ID]: makeAccount({
        userId: PUBLISHER_ID,
        accessToken: PUBLISHER_TOKEN,
        username: 'publisher-login',
        metadata: { login: 'publisher-login' },
    }),
    [EDITOR_ID]: makeAccount({
        userId: EDITOR_ID,
        accessToken: EDITOR_TOKEN,
        username: 'editor-login',
        metadata: { login: 'editor-login' },
    }),
};
interface HarnessOptions {
    /** The Work `findById` answers; `null` is a Work that does not exist. */
    work?: Record<string, unknown> | null;
    /** Connected (usable) accounts, by member id. */
    connected?: Record<string, Record<string, unknown> | null>;
    /** Raw integration account rows (`plugin:<provider>`), by member id. */
    raw?: Record<string, Record<string, unknown> | null>;
    /** Raw sign-in account rows (`<provider>`), by member id. */
    rawPlain?: Record<string, Record<string, unknown> | null>;
    /** Members of the Work, by member id. */
    members?: Record<string, boolean>;
    /** Members with edit access, by member id. */
    editors?: Record<string, boolean>;
    /** The recorded handover member, or `null` for none. */
    handover?: string | null;
    /** Members whose member-token read answers `null`. */
    tokenless?: string[];
    /** Leave the handover store unbound (the provisional state). */
    noStore?: boolean;
    /** Leave the account reader unbound. */
    noAccounts?: boolean;
    /** Leave the member reader unbound. */
    noMembers?: boolean;
    /** Leave the git facade unbound. */
    noGit?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
    const work = options.work === undefined ? makeWork() : options.work;

    const connected = { ...DEFAULT_CONNECTIONS, ...options.connected };
    // The raw row defaults to the connected one: a member with no connection
    // has no row either, and a test that wants "connected yet unusable" says
    // so by overriding `raw` on its own.
    const raw = { ...connected, ...options.raw };

    const works = {
        findById: jest.fn().mockResolvedValue(work),
    };

    const members = {
        findMember: jest.fn(async (_workId: string, userId: string) =>
            (options.members?.[userId] ?? false) ? { userId } : null,
        ),
        hasRole: jest.fn(
            async (_workId: string, userId: string) => options.editors?.[userId] ?? false,
        ),
    };

    const accounts = {
        findConnectedProviderAccount: jest.fn(async (userId: string) => connected[userId] ?? null),
        findProviderAccount: jest.fn(async (userId: string, providerId: string) =>
            providerId.startsWith('plugin:')
                ? (raw[userId] ?? null)
                : (options.rawPlain?.[userId] ?? null),
        ),
    };

    /** Every provider-facing method rejects: "no provider call" is proven, not counted. */
    const providerCall = (name: string) =>
        jest.fn(() => {
            throw new Error(`provider call while paused: ${name}`);
        });

    const git = {
        getMemberAccountToken: jest.fn(async ({ userId }: { userId: string }) =>
            options.tokenless?.includes(userId) ? null : (TOKENS[userId] ?? null),
        ),
        // The Work-scoped read that can answer with a platform PAT or an
        // installation token. It answers one here, so a service that fell back
        // to it would return PLATFORM_TOKEN and fail the assertions below.
        getAccessToken: jest.fn().mockResolvedValue(PLATFORM_TOKEN),
        createPullRequest: providerCall('createPullRequest'),
        updatePullRequest: providerCall('updatePullRequest'),
        listPullRequests: providerCall('listPullRequests'),
        getRepository: providerCall('getRepository'),
    };

    const store = {
        read: jest.fn().mockResolvedValue(options.handover ?? null),
        write: jest.fn().mockResolvedValue(undefined),
    };

    const service = new UpstreamCredentialService(
        works as never,
        options.noMembers ? undefined : (members as never),
        options.noAccounts ? undefined : (accounts as never),
        options.noGit ? undefined : (git as never),
        options.noStore ? undefined : (store as never),
    );

    return { service, works, members, accounts, git, store };
}

describe('UpstreamCredentialService — the credential of record (FR-43)', () => {
    it('records the member who created the App Work — the member whose connection performed the fork', async () => {
        const { service, store } = makeHarness();

        const record = await service.credentialOfRecord(WORK_ID);

        expect(record).toEqual({
            workId: WORK_ID,
            memberUserId: CREATOR_ID,
            source: 'creator',
            providerId: 'github',
        });
        expect(store.read).toHaveBeenCalledWith(WORK_ID);
    });

    it('answers null for a Work that does not exist', async () => {
        const { service } = makeHarness({ work: null });

        await expect(service.credentialOfRecord(WORK_ID)).resolves.toBeNull();
    });

    it('names the handover member once one is recorded', async () => {
        const { service } = makeHarness({ handover: EDITOR_ID });

        const record = await service.credentialOfRecord(WORK_ID);

        expect(record).toMatchObject({ memberUserId: EDITOR_ID, source: 'handover' });
    });
});

describe('UpstreamCredentialService — the background job resolves the credential of record', () => {
    it("resolves the creator's own member-account token through the FR-24 door", async () => {
        const { service, git } = makeHarness();

        const resolution = await service.resolveForBackgroundJob(WORK_ID);

        expect(resolution).toMatchObject({
            usable: true,
            memberUserId: CREATOR_ID,
            source: 'creator',
            credential: { userId: CREATOR_ID, providerId: 'github', token: CREATOR_TOKEN },
        });
        expect(git.getMemberAccountToken).toHaveBeenCalledWith({
            userId: CREATOR_ID,
            providerId: 'github',
        });
    });

    it('never asks the Work-scoped read that can answer with a platform PAT or an installation token', async () => {
        const { service, git } = makeHarness();

        const resolution = await service.resolveForBackgroundJob(WORK_ID);

        expect(git.getAccessToken).not.toHaveBeenCalled();
        expect(resolution).toMatchObject({ credential: { token: CREATOR_TOKEN } });
        expect(JSON.stringify(resolution)).not.toContain(PLATFORM_TOKEN);
    });

    it('reads the provider the Work names, else the App Works default', async () => {
        const { service } = makeHarness({
            work: makeWork({ gitProvider: 'github-enterprise' }),
        });

        const resolution = await service.resolveForBackgroundJob(WORK_ID);

        expect(resolution).toMatchObject({
            credential: { providerId: 'github-enterprise' },
        });
    });

    it('stops with a named error instead of pausing when the App Work is gone', async () => {
        const { service } = makeHarness({ work: null });

        await expect(service.resolveForBackgroundJob(WORK_ID)).rejects.toBeInstanceOf(
            UpstreamCredentialNotFoundError,
        );
        await expect(service.resolveForBackgroundJob(WORK_ID)).rejects.toMatchObject({
            code: 'not_found',
            workId: WORK_ID,
        });
    });
});

describe('UpstreamCredentialService — an unusable credential pauses with the reason', () => {
    it('pauses as member_left when the member of record is no longer on the App Work', async () => {
        const { service } = makeHarness({
            handover: DEPARTED_ID,
            connected: { [DEPARTED_ID]: null },
        });

        const resolution = await service.resolveForBackgroundJob(WORK_ID);

        expect(resolution).toMatchObject({ usable: false, reason: 'member_left' });
    });

    it('pauses as disconnected when the member has no connected account', async () => {
        const { service } = makeHarness({ connected: { [CREATOR_ID]: null } });

        const resolution = await service.resolveForBackgroundJob(WORK_ID);

        expect(resolution).toMatchObject({ usable: false, reason: 'disconnected' });
    });

    it('pauses as disconnected when the connected account’s token has expired', async () => {
        const expired = makeAccount({ accessTokenExpiresAt: new Date(Date.now() - 1000) });
        const { service } = makeHarness({
            connected: { [CREATOR_ID]: null },
            raw: { [CREATOR_ID]: expired },
        });

        const resolution = await service.resolveForBackgroundJob(WORK_ID);

        expect(resolution).toMatchObject({ usable: false, reason: 'disconnected' });
    });

    it('pauses as scope_withdrawn when the connection lost the repo scope', async () => {
        const narrowed = makeAccount({ scope: 'read:user' });
        const { service } = makeHarness({
            connected: { [CREATOR_ID]: null },
            raw: { [CREATOR_ID]: narrowed },
        });

        const resolution = await service.resolveForBackgroundJob(WORK_ID);

        expect(resolution).toMatchObject({ usable: false, reason: 'scope_withdrawn' });
    });

    it('pauses as access_lost when the usability gate refuses a connection that looks live', async () => {
        const { service } = makeHarness({
            connected: { [CREATOR_ID]: null },
            raw: { [CREATOR_ID]: makeAccount() },
        });

        const resolution = await service.resolveForBackgroundJob(WORK_ID);

        expect(resolution).toMatchObject({ usable: false, reason: 'access_lost' });
    });

    it('makes no provider call and resolves no token while paused', async () => {
        const { service, git } = makeHarness({ connected: { [CREATOR_ID]: null } });

        const resolution = await service.resolveForBackgroundJob(WORK_ID);

        expect(resolution.usable).toBe(false);
        expect(git.getMemberAccountToken).not.toHaveBeenCalled();
        expect(git.getAccessToken).not.toHaveBeenCalled();
        expect(git.createPullRequest).not.toHaveBeenCalled();
        expect(git.updatePullRequest).not.toHaveBeenCalled();
        expect(git.listPullRequests).not.toHaveBeenCalled();
        expect(git.getRepository).not.toHaveBeenCalled();
    });

    it('carries no token field at all on the paused arm', async () => {
        const { service } = makeHarness({ connected: { [CREATOR_ID]: null } });

        const resolution = await service.resolveForBackgroundJob(WORK_ID);

        expect(resolution).not.toHaveProperty('credential');
        expect(JSON.stringify(resolution)).not.toContain(CREATOR_TOKEN);
    });

    it('pauses rather than falling back when the member-token door answers null', async () => {
        const { service, git } = makeHarness({ tokenless: [CREATOR_ID] });

        const resolution = await service.resolveForBackgroundJob(WORK_ID);

        expect(resolution).toMatchObject({ usable: false, reason: 'disconnected' });
        expect(git.getAccessToken).not.toHaveBeenCalled();
        expect(JSON.stringify(resolution)).not.toContain(PLATFORM_TOKEN);
    });

    it('carries the copy key, the handover action and the member the banner names', async () => {
        const { service } = makeHarness({
            connected: { [CREATOR_ID]: null },
            raw: { [CREATOR_ID]: makeAccount({ username: 'creator-login' }) },
        });

        const resolution = await service.resolveForBackgroundJob(WORK_ID);

        expect(resolution).toMatchObject({
            usable: false,
            pause: {
                messageKey: UPSTREAM_CREDENTIAL_I18N.paused,
                actionKey: UPSTREAM_CREDENTIAL_I18N.handover,
                member: { userId: CREATOR_ID, login: 'creator-login' },
                params: { member: 'creator-login' },
            },
        });
        expect(UPSTREAM_CREDENTIAL_I18N.paused).toBe(
            'dashboard.workDetail.upstream.credentialPaused',
        );
    });

    it('falls back to the Work’s own user row when the connection is gone', async () => {
        const { service } = makeHarness({
            connected: { [CREATOR_ID]: null },
            raw: { [CREATOR_ID]: null },
        });

        const resolution = await service.resolveForBackgroundJob(WORK_ID);

        expect(resolution).toMatchObject({
            usable: false,
            pause: { params: { member: 'creator-login' } },
        });
    });

    it('falls back to the member id when neither the connection nor the Work names the member', async () => {
        const { service } = makeHarness({
            handover: DEPARTED_ID,
            members: { [DEPARTED_ID]: true },
            connected: { [DEPARTED_ID]: null },
            raw: { [DEPARTED_ID]: null },
        });

        const resolution = await service.resolveForBackgroundJob(WORK_ID);

        expect(resolution).toMatchObject({
            usable: false,
            pause: { params: { member: DEPARTED_ID } },
        });
    });

    it('reads the sign-in account row when the integration row is absent', async () => {
        const { service, accounts } = makeHarness({
            connected: { [CREATOR_ID]: null },
            raw: { [CREATOR_ID]: null },
            rawPlain: { [CREATOR_ID]: makeAccount({ scope: 'read:user' }) },
        });

        const resolution = await service.resolveForBackgroundJob(WORK_ID);

        expect(resolution).toMatchObject({ usable: false, reason: 'scope_withdrawn' });
        expect(accounts.findProviderAccount).toHaveBeenCalledWith(CREATOR_ID, 'plugin:github');
        expect(accounts.findProviderAccount).toHaveBeenCalledWith(CREATOR_ID, 'github');
    });

    it('cannot count a credential as usable when the account reader is unbound', async () => {
        const { service } = makeHarness({ noAccounts: true });

        const resolution = await service.resolveForBackgroundJob(WORK_ID);

        expect(resolution).toMatchObject({ usable: false, reason: 'disconnected' });
    });
});

describe('UpstreamCredentialService — the pause the tab reads', () => {
    it('is null while the credential of record is usable', async () => {
        const { service } = makeHarness();

        await expect(service.pauseFor(WORK_ID)).resolves.toBeNull();
    });

    it('is the pause the jobs take when it is not', async () => {
        const { service } = makeHarness({ connected: { [CREATOR_ID]: null } });

        await expect(service.pauseFor(WORK_ID)).resolves.toMatchObject({
            workId: WORK_ID,
            reason: 'disconnected',
        });
    });
});

describe('UpstreamCredentialService — classifying a refusal the job already received', () => {
    it('reads a 401 as disconnected', () => {
        const { service } = makeHarness();

        expect(service.pauseReasonForProviderRefusal(401)).toBe('disconnected');
    });

    it('reads a 403 that names a scope as scope_withdrawn', () => {
        const { service } = makeHarness();

        expect(service.pauseReasonForProviderRefusal(403, 'insufficient_scope')).toBe(
            'scope_withdrawn',
        );
    });

    it('reads a 403 that names no scope as access_lost', () => {
        const { service } = makeHarness();

        expect(
            service.pauseReasonForProviderRefusal(403, 'Resource not accessible by integration'),
        ).toBe('access_lost');
    });

    it('leaves every other status to the caller — a 404 is a row going closed, not a pause', () => {
        const { service } = makeHarness();

        expect(service.pauseReasonForProviderRefusal(404)).toBeNull();
        expect(service.pauseReasonForProviderRefusal(422)).toBeNull();
        expect(service.pauseReasonForProviderRefusal(500)).toBeNull();
    });
});

describe('UpstreamCredentialService — the handover (FR-43)', () => {
    it('lets the creator make their own connection the credential of record', async () => {
        const { service, store } = makeHarness();

        const result = await service.handover(WORK_ID, CREATOR_ID);

        expect(result).toEqual({
            ok: true,
            workId: WORK_ID,
            memberUserId: CREATOR_ID,
            previousMemberUserId: CREATOR_ID,
            source: 'handover',
        });
        expect(store.write).toHaveBeenCalledWith(WORK_ID, CREATOR_ID);
    });

    it('lets a member with edit access hand over, and the next background job uses their connection', async () => {
        const { service, store, git } = makeHarness({
            members: { [EDITOR_ID]: true },
            editors: { [EDITOR_ID]: true },
            connected: { [EDITOR_ID]: makeAccount({ userId: EDITOR_ID }) },
        });

        const result = await service.handover(WORK_ID, EDITOR_ID);

        expect(result).toMatchObject({
            ok: true,
            memberUserId: EDITOR_ID,
            previousMemberUserId: CREATOR_ID,
        });
        expect(store.write).toHaveBeenCalledWith(WORK_ID, EDITOR_ID);

        // The record now names the editor: the background job resolves theirs.
        store.read.mockResolvedValue(EDITOR_ID);
        const resolution = await service.resolveForBackgroundJob(WORK_ID);

        expect(resolution).toMatchObject({
            usable: true,
            memberUserId: EDITOR_ID,
            source: 'handover',
            credential: { userId: EDITOR_ID, token: EDITOR_TOKEN },
        });
        expect(git.getMemberAccountToken).toHaveBeenCalledWith({
            userId: EDITOR_ID,
            providerId: 'github',
        });
    });

    it('refuses a viewer and a stranger with not_edit_access, and writes nothing', async () => {
        const viewer = makeHarness({
            members: { [VIEWER_ID]: true, [PUBLISHER_ID]: true },
            editors: { [VIEWER_ID]: false, [PUBLISHER_ID]: false },
        });

        await expect(viewer.service.handover(WORK_ID, VIEWER_ID)).resolves.toMatchObject({
            ok: false,
            refusal: 'not_edit_access',
        });
        await expect(viewer.service.handover(WORK_ID, PUBLISHER_ID)).resolves.toMatchObject({
            ok: false,
            refusal: 'not_edit_access',
        });
        expect(viewer.store.write).not.toHaveBeenCalled();
    });

    it('checks edit access through the Work’s roles, not through a second membership rule', async () => {
        const { service, members } = makeHarness({
            members: { [EDITOR_ID]: true },
            editors: { [EDITOR_ID]: true },
        });

        await service.handover(WORK_ID, EDITOR_ID);

        expect(members.hasRole).toHaveBeenCalledWith(WORK_ID, EDITOR_ID, 'editor');
    });

    it('refuses with handover_unavailable when no record store is bound — never a success it cannot keep', async () => {
        const { service } = makeHarness({ noStore: true });

        await expect(service.handover(WORK_ID, CREATOR_ID)).resolves.toEqual({
            ok: false,
            workId: WORK_ID,
            refusal: 'handover_unavailable',
        });
    });

    it("refuses when the caller's own connection cannot be used, naming the reason", async () => {
        const { service, store } = makeHarness({
            members: { [EDITOR_ID]: true },
            editors: { [EDITOR_ID]: true },
            connected: { [EDITOR_ID]: null },
        });

        await expect(service.handover(WORK_ID, EDITOR_ID)).resolves.toEqual({
            ok: false,
            workId: WORK_ID,
            refusal: 'credential_unusable',
            reason: 'disconnected',
        });
        expect(store.write).not.toHaveBeenCalled();
    });

    it('re-authors nothing: it makes no provider call and touches no pull request', async () => {
        const { service, git } = makeHarness();

        const result = await service.handover(WORK_ID, CREATOR_ID);

        expect(result).toMatchObject({ ok: true });
        expect(git.createPullRequest).not.toHaveBeenCalled();
        expect(git.updatePullRequest).not.toHaveBeenCalled();
        expect(git.listPullRequests).not.toHaveBeenCalled();
        expect(git.getRepository).not.toHaveBeenCalled();
        expect(git.getAccessToken).not.toHaveBeenCalled();
    });

    it('is refused by name for a Work that does not exist', async () => {
        const { service } = makeHarness({ work: null });

        await expect(service.handover(OTHER_WORK_ID, CREATOR_ID)).resolves.toEqual({
            ok: false,
            workId: OTHER_WORK_ID,
            refusal: 'not_found',
        });
    });
});

describe("UpstreamCredentialService — preparation and push keep the publishing member's own token (FR-24)", () => {
    it("resolves the publishing member's own token, not the credential of record's", async () => {
        const { service, git } = makeHarness();

        const background = await service.resolveForBackgroundJob(WORK_ID);
        const publishing = await service.resolveForPublishingMember(WORK_ID, PUBLISHER_ID);

        expect(background).toMatchObject({ credential: { token: CREATOR_TOKEN } });
        expect(publishing).toEqual({
            usable: true,
            workId: WORK_ID,
            memberUserId: PUBLISHER_ID,
            credential: { userId: PUBLISHER_ID, providerId: 'github', token: PUBLISHER_TOKEN },
        });
        // The two directions are distinct members with distinct tokens.
        expect(PUBLISHER_TOKEN).not.toBe(CREATOR_TOKEN);
        expect(git.getMemberAccountToken).toHaveBeenCalledWith({
            userId: PUBLISHER_ID,
            providerId: 'github',
        });
        expect(git.getMemberAccountToken).toHaveBeenCalledWith({
            userId: CREATOR_ID,
            providerId: 'github',
        });
    });

    it('resolves a member who is not the credential of record, and never reads the record for it', async () => {
        const { service, store } = makeHarness({ connected: { [CREATOR_ID]: null } });

        const background = await service.resolveForBackgroundJob(WORK_ID);
        expect(background).toMatchObject({ usable: false, reason: 'disconnected' });

        store.read.mockClear();
        const publishing = await service.resolveForPublishingMember(WORK_ID, PUBLISHER_ID);

        expect(publishing).toMatchObject({
            usable: true,
            credential: { token: PUBLISHER_TOKEN },
        });
        expect(store.read).not.toHaveBeenCalled();
    });

    it('is unaffected by a handover to a third member', async () => {
        const { service, store } = makeHarness({
            members: { [EDITOR_ID]: true },
            editors: { [EDITOR_ID]: true },
            connected: { [EDITOR_ID]: makeAccount({ userId: EDITOR_ID }) },
        });

        await service.handover(WORK_ID, EDITOR_ID);
        store.read.mockResolvedValue(EDITOR_ID);

        const background = await service.resolveForBackgroundJob(WORK_ID);
        const publishing = await service.resolveForPublishingMember(WORK_ID, PUBLISHER_ID);

        expect(background).toMatchObject({ credential: { token: EDITOR_TOKEN } });
        expect(publishing).toMatchObject({ credential: { token: PUBLISHER_TOKEN } });
        expect(JSON.stringify(publishing)).not.toContain(EDITOR_TOKEN);
    });

    it('refuses with connectionScope when the publishing member has no member token, and falls back to nothing', async () => {
        const { service, git } = makeHarness({ tokenless: [PUBLISHER_ID] });

        const publishing = await service.resolveForPublishingMember(WORK_ID, PUBLISHER_ID);

        expect(publishing).toEqual({
            usable: false,
            workId: WORK_ID,
            memberUserId: PUBLISHER_ID,
            code: 'connectionScope',
        });
        expect(git.getAccessToken).not.toHaveBeenCalled();
        expect(JSON.stringify(publishing)).not.toContain(PLATFORM_TOKEN);
    });

    it('stops with a named error when the App Work is gone', async () => {
        const { service } = makeHarness({ work: null });

        await expect(
            service.resolveForPublishingMember(WORK_ID, PUBLISHER_ID),
        ).rejects.toBeInstanceOf(UpstreamCredentialNotFoundError);
    });
});

describe('UpstreamCredentialService — the scope vocabulary FR-43 pauses on', () => {
    it('requires exactly the repo scope the member push needs', () => {
        expect(UPSTREAM_CREDENTIAL_REQUIRED_SCOPES).toEqual(['repo']);
    });
});

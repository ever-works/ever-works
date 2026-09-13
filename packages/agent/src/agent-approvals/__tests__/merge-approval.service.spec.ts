import { MERGE_APPROVAL_MAX_AGE_MS, mergeApprovalSubjectKey } from '@ever-works/contracts';
import { MergeApprovalService } from '../merge-approval.service';

/**
 * Merge approval (self-build slice AE, EW-805) — the verifier.
 *
 * This is the file that decides whether a pull request gets merged, so
 * every case below is written as "what would have to be true for an
 * UNAPPROVED merge to land". The positives are one test; the rest is the
 * list of ways a merge bot lands the wrong thing.
 *
 * The service is driven for real — no self-comparing fixtures. The only
 * doubles are the repositories, and the assertions look at the exact
 * lookup they receive, because a verifier that queried by Task alone
 * would pass every "approved" test here while being catastrophically
 * wrong.
 */
describe('MergeApprovalService', () => {
    const TASK_ID = '9f1c0d1e-6c1a-4c3a-9f6c-2b6a0a5d1e77';
    const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const OLD_HEAD = '1111111111111111111111111111111111111111';
    const PR = 42;
    const KEY = mergeApprovalSubjectKey({ taskId: TASK_ID, prNumber: PR, headSha: HEAD });

    const QUERY = { taskId: TASK_ID, prNumber: PR, headSha: HEAD };

    function approvedRow(over: Record<string, unknown> = {}) {
        return {
            id: 'proposal-1',
            actionType: 'merge_pull_request',
            subjectKey: KEY,
            status: 'approved',
            decidedVia: 'user',
            decidedById: 'human-1',
            decidedAt: new Date(),
            ...over,
        };
    }

    function orgTask(over: Record<string, unknown> = {}) {
        return {
            id: TASK_ID,
            userId: 'owner-1',
            slug: 'T-42',
            tenantId: 'tenant-1',
            organizationId: 'org-1',
            ...over,
        };
    }

    function build(
        over: {
            row?: unknown;
            priorCount?: number;
            task?: unknown;
            user?: unknown;
            findOneImpl?: jest.Mock;
            /** Roster rows the approver's Organization holds. */
            rosterSize?: number;
            /** `tenants.ownerUserId` for the Task's Tenant. */
            tenantOwnerUserId?: string | null;
        } = {},
    ) {
        // `'row' in over` rather than `??`: an explicit `null` means "the
        // store holds nothing", which is a different case from "the test
        // did not care" and is exactly the case worth testing.
        const proposals = {
            findOne:
                over.findOneImpl ??
                jest.fn().mockResolvedValue('row' in over ? over.row : approvedRow()),
            count: jest.fn().mockResolvedValue(over.priorCount ?? 0),
        };
        const tasks = {
            findById: jest.fn().mockResolvedValue('task' in over ? over.task : orgTask()),
        };
        const users = {
            findById: jest.fn().mockResolvedValue(
                'user' in over
                    ? over.user
                    : {
                          id: 'human-1',
                          isActive: true,
                          isAnonymous: false,
                          tenantId: 'tenant-1',
                      },
            ),
        };
        const approvals = {
            createProposal: jest.fn().mockResolvedValue({ id: 'proposal-new' }),
        };
        const members = {
            findByOrgAndUser: jest.fn().mockResolvedValue({ id: 'member-1' }),
            countForOrganization: jest.fn().mockResolvedValue(over.rosterSize ?? 3),
        };
        const tenants = {
            findById: jest.fn().mockResolvedValue({
                id: 'tenant-1',
                ownerUserId: 'tenantOwnerUserId' in over ? over.tenantOwnerUserId : 'owner-of-t1',
            }),
        };
        const service = new MergeApprovalService(
            proposals as never,
            tasks as never,
            users as never,
            approvals as never,
            members as never,
            tenants as never,
        );
        return { service, proposals, tasks, users, approvals, members, tenants };
    }

    // ── the one happy path ────────────────────────────────────────────

    it('approves a human decision recorded for exactly this pull request and head', async () => {
        const { service } = build();
        await expect(service.verifyMergeApproval(QUERY)).resolves.toEqual({
            approved: true,
            approvalId: 'proposal-1',
            approvedById: 'human-1',
            approvedAt: expect.any(Date),
        });
    });

    it('looks the approval up by the EXACT subject key, not by Task or PR alone', async () => {
        const { service, proposals } = build();
        await service.verifyMergeApproval(QUERY);
        expect(proposals.findOne).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    actionType: 'merge_pull_request',
                    subjectKey: KEY,
                    status: 'approved',
                },
            }),
        );
        // The key names the head, so a query built from it cannot match a
        // decision made about a different commit.
        expect(KEY).toContain(HEAD);
    });

    it('normalises a shouted head SHA to the same key the writer used', async () => {
        const { service, proposals } = build();
        await service.verifyMergeApproval({ ...QUERY, headSha: HEAD.toUpperCase() });
        expect(proposals.findOne.mock.calls[0][0].where.subjectKey).toBe(KEY);
    });

    // ── nothing recorded ──────────────────────────────────────────────

    it('refuses with approval-missing when nothing names this pull request', async () => {
        const { service } = build({ row: null, priorCount: 0 });
        const verdict = await service.verifyMergeApproval(QUERY);
        expect(verdict).toMatchObject({ approved: false, code: 'approval-missing' });
        expect(verdict.reason).toContain('No human approval is on record');
    });

    it('refuses with approval-STALE when the approval was for an earlier commit', async () => {
        // This is the force-push / new-commit case, and it is the reason
        // the head is in the key at all: the human approved a diff, and
        // the diff changed underneath them.
        const { service } = build({ row: null, priorCount: 1 });
        const verdict = await service.verifyMergeApproval(QUERY);
        expect(verdict).toMatchObject({ approved: false, code: 'approval-stale' });
        expect(verdict.reason).toContain('approved for an earlier commit');
    });

    it('an approval for the same PR at another head does not satisfy this head', async () => {
        // Driven end to end through the real key derivation: a store that
        // only holds OLD_HEAD answers nothing for HEAD.
        const stored = new Map([
            [
                mergeApprovalSubjectKey({ taskId: TASK_ID, prNumber: PR, headSha: OLD_HEAD }),
                approvedRow({
                    subjectKey: mergeApprovalSubjectKey({
                        taskId: TASK_ID,
                        prNumber: PR,
                        headSha: OLD_HEAD,
                    }),
                }),
            ],
        ]);
        const findOneImpl = jest.fn(async (opts: { where: { subjectKey?: string } }) =>
            opts.where.subjectKey ? (stored.get(opts.where.subjectKey) ?? null) : null,
        );
        const { service } = build({ findOneImpl, priorCount: 1 });

        await expect(
            service.verifyMergeApproval({ ...QUERY, headSha: OLD_HEAD }),
        ).resolves.toMatchObject({ approved: true });
        await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
            approved: false,
            code: 'approval-stale',
        });
    });

    // ── the platform must not approve its own work ────────────────────

    it('refuses a GUARDRAIL auto-approval — the platform cannot approve itself', async () => {
        const { service } = build({
            row: approvedRow({ decidedVia: 'guardrail', decidedById: null }),
        });
        await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
            approved: false,
            code: 'approval-not-human',
        });
    });

    it('refuses an approved row with no decider at all', async () => {
        const { service } = build({ row: approvedRow({ decidedById: null }) });
        await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
            approved: false,
            code: 'approval-not-human',
        });
    });

    // ── freshness ─────────────────────────────────────────────────────

    it('refuses an approval older than the validity window', async () => {
        const { service } = build({
            row: approvedRow({
                decidedAt: new Date(Date.now() - MERGE_APPROVAL_MAX_AGE_MS - 1000),
            }),
        });
        await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
            approved: false,
            code: 'approval-expired',
        });
    });

    it('accepts an approval just inside the window', async () => {
        const { service } = build({
            row: approvedRow({
                decidedAt: new Date(Date.now() - MERGE_APPROVAL_MAX_AGE_MS + 60_000),
            }),
        });
        await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({ approved: true });
    });

    it('refuses an approval with no decision time — its age cannot be established', async () => {
        const { service } = build({ row: approvedRow({ decidedAt: null }) });
        await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
            approved: false,
            code: 'approval-expired',
        });
    });

    // ── entitlement, derived from platform state ──────────────────────

    it('refuses an approver from a DIFFERENT tenant', async () => {
        const { service } = build({
            user: { id: 'human-1', isActive: true, isAnonymous: false, tenantId: 'tenant-2' },
        });
        await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
            approved: false,
            code: 'approver-not-entitled',
        });
    });

    it('refuses a deactivated approver', async () => {
        const { service } = build({
            user: { id: 'human-1', isActive: false, isAnonymous: false, tenantId: 'tenant-1' },
        });
        await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
            approved: false,
            code: 'approver-not-entitled',
        });
    });

    it('refuses an ANONYMOUS approver — an unclaimed account is nobody', async () => {
        const { service } = build({
            user: { id: 'human-1', isActive: true, isAnonymous: true, tenantId: 'tenant-1' },
        });
        await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
            approved: false,
            code: 'approver-not-entitled',
        });
    });

    it('refuses when the approver row cannot be read at all', async () => {
        const { service } = build({ user: null });
        await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
            approved: false,
            code: 'approver-not-entitled',
        });
    });

    it('refuses when the Task itself is gone — entitlement has no scope to check', async () => {
        const { service } = build({ task: null });
        await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
            approved: false,
            code: 'approver-not-entitled',
        });
    });

    it('derives the scope from the TASK, never from the proposal row', async () => {
        const { service, tasks } = build();
        await service.verifyMergeApproval(QUERY);
        expect(tasks.findById).toHaveBeenCalledWith(TASK_ID);
    });

    it('admits an org approver who is on the roster', async () => {
        const { service, members } = build();
        await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({ approved: true });
        expect(members.findByOrgAndUser).toHaveBeenCalledWith('org-1', 'human-1');
    });

    // CONTRACT REVERSAL (AE review). This block used to hold one test —
    // "admits an org approver WITHOUT a roster row — tenant equality is
    // the predicate" — justified by the two production reverts where
    // roster-strictness admitted only the Tenant owner.
    //
    // That justification does not transfer. Both reverts were on READ
    // paths, where over-restriction is a visibility bug; this is the one
    // irreversible WRITE in the queue. And tenant equality alone reads a
    // revocation and ignores it: `removeMember` deletes the roster row but
    // only clears `users.tenantId` once the person's LAST membership in
    // the Tenant is gone, so somebody removed from Organization A while
    // still in Organization B kept merge authority over A's repositories.
    //
    // The predicate is now roster row OR Tenant owner OR an Organization
    // with no roster at all — which keeps every case the reverts were
    // about working, and closes the one they were not about.
    describe('Organization roster (entitlement)', () => {
        it('REFUSES an approver removed from the Organization but still in the Tenant', async () => {
            // The exact leak: Bob is removed from Org A, stays in Org B, so
            // his users.tenantId survives. Org A's roster is populated, and
            // his row in it is gone.
            const { service, members } = build({ rosterSize: 4 });
            members.findByOrgAndUser.mockResolvedValue(null);
            const verdict = await service.verifyMergeApproval(QUERY);
            expect(verdict).toMatchObject({ approved: false, code: 'approver-not-entitled' });
            expect(verdict.reason).toContain('not a member of the Organization');
        });

        it('admits the TENANT OWNER, who holds no roster row by construction', async () => {
            // `removeMember` refuses to remove the owner precisely because
            // "the owner is a member of every Organization in their Tenant
            // by construction — there is no roster row to delete". A
            // roster-only check would admit everybody except them.
            const { service, members } = build({
                rosterSize: 4,
                tenantOwnerUserId: 'human-1',
            });
            members.findByOrgAndUser.mockResolvedValue(null);
            await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
                approved: true,
            });
        });

        it('admits a tenant member when the Organization has NO roster at all', async () => {
            // Organizations that predate invitations have an empty
            // `organization_members`. Where there is no roster there is no
            // revocation to honour, and roster-strictness against these is
            // exactly what had to be reverted twice before.
            const { service, members } = build({ rosterSize: 0 });
            members.findByOrgAndUser.mockResolvedValue(null);
            await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
                approved: true,
            });
        });

        it('refuses when the roster size cannot be read — it does not guess', async () => {
            const { service, members } = build();
            members.findByOrgAndUser.mockResolvedValue(null);
            members.countForOrganization.mockRejectedValue(new Error('db down'));
            await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
                approved: false,
                code: 'approver-not-entitled',
            });
        });

        it('never consults the roster for a personal-scope Task', async () => {
            const { service, members } = build({
                task: orgTask({ organizationId: null, tenantId: null }),
                row: approvedRow({ decidedById: 'owner-1' }),
                user: { id: 'owner-1', isActive: true, isAnonymous: false, tenantId: null },
            });
            await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
                approved: true,
            });
            expect(members.findByOrgAndUser).not.toHaveBeenCalled();
        });
    });

    describe('personal scope (no Organization)', () => {
        const personal = orgTask({ organizationId: null, tenantId: null, userId: 'owner-1' });

        it('admits the Task owner', async () => {
            const { service } = build({
                task: personal,
                row: approvedRow({ decidedById: 'owner-1' }),
                user: { id: 'owner-1', isActive: true, isAnonymous: false, tenantId: null },
            });
            await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
                approved: true,
            });
        });

        it('refuses anybody else, even an active user', async () => {
            const { service } = build({
                task: personal,
                row: approvedRow({ decidedById: 'stranger' }),
                user: { id: 'stranger', isActive: true, isAnonymous: false, tenantId: null },
            });
            await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
                approved: false,
                code: 'approver-not-entitled',
            });
        });
    });

    // ── unusable inputs and faults all fail CLOSED ────────────────────

    it.each([
        ['an empty task id', { ...QUERY, taskId: '  ' }, 'approval-missing'],
        ['a branch name as the head', { ...QUERY, headSha: 'main' }, 'head-sha-unknown'],
        ['an empty head', { ...QUERY, headSha: '' }, 'head-sha-unknown'],
    ] as const)('refuses %s', async (_label, query, code) => {
        const { service, proposals } = build();
        await expect(service.verifyMergeApproval(query)).resolves.toMatchObject({
            approved: false,
            code,
        });
        expect(proposals.findOne).not.toHaveBeenCalled();
    });

    it('refuses when a positive PR number cannot be keyed', async () => {
        const { service } = build();
        await expect(service.verifyMergeApproval({ ...QUERY, prNumber: 0 })).resolves.toMatchObject(
            { approved: false, code: 'approval-missing' },
        );
    });

    it('refuses when the approval store throws — an unreadable record is not an approval', async () => {
        const { service, proposals } = build();
        proposals.findOne.mockRejectedValue(new Error('db down'));
        await expect(service.verifyMergeApproval(QUERY)).resolves.toMatchObject({
            approved: false,
            code: 'approval-missing',
        });
    });

    // ── requesting an approval ────────────────────────────────────────

    describe('requestMergeApproval', () => {
        const REQUEST = {
            userId: 'owner-1',
            taskId: TASK_ID,
            taskLabel: 'T-42',
            agentId: 'agent-1',
            prNumber: PR,
            headSha: HEAD,
            targetBranch: 'develop',
            repository: 'acme/site-data',
            ciState: 'passing',
        };

        it('raises a merge_pull_request proposal keyed to this pull request AND head', async () => {
            const { service, proposals, approvals } = build();
            proposals.findOne.mockResolvedValue(null);

            const outcome = await service.requestMergeApproval(REQUEST);

            expect(outcome).toMatchObject({ raised: true });
            expect(approvals.createProposal).toHaveBeenCalledWith(
                'owner-1',
                expect.objectContaining({
                    agentId: 'agent-1',
                    actionType: 'merge_pull_request',
                    subjectKey: KEY,
                    payload: expect.objectContaining({
                        taskId: TASK_ID,
                        prNumber: PR,
                        headSha: HEAD,
                        targetBranch: 'develop',
                        repository: 'acme/site-data',
                        destructive: true,
                    }),
                }),
            );
        });

        it('puts the pull request, base branch, repository and commit in the title', async () => {
            // The title is the only string BOTH surfaces show — the Inbox
            // item and the approvals queue. Somebody approving an
            // irreversible merge has to be able to tell what they are
            // approving from it alone.
            const { service, proposals, approvals } = build();
            proposals.findOne.mockResolvedValue(null);
            await service.requestMergeApproval(REQUEST);
            expect(approvals.createProposal.mock.calls[0][1].title).toBe(
                'Merge PR #42 into develop in acme/site-data for T-42 (@ a1b2c3d4e5f6)',
            );
        });

        it('degrades the title gracefully when the branch or repository is unknown', async () => {
            const { service, proposals, approvals } = build();
            proposals.findOne.mockResolvedValue(null);
            await service.requestMergeApproval({
                ...REQUEST,
                targetBranch: null,
                repository: null,
            });
            expect(approvals.createProposal.mock.calls[0][1].title).toBe(
                'Merge PR #42 for T-42 (@ a1b2c3d4e5f6)',
            );
        });

        it('is idempotent per head — a repeated sweep files nothing new', async () => {
            const { service, proposals, approvals } = build();
            proposals.findOne.mockResolvedValue({ id: 'p-1', status: 'pending' });
            await expect(service.requestMergeApproval(REQUEST)).resolves.toEqual({
                raised: false,
                reason: 'already-open',
            });
            expect(approvals.createProposal).not.toHaveBeenCalled();
        });

        it('does not re-ask once a human has already decided this head', async () => {
            const { service, proposals, approvals } = build();
            proposals.findOne.mockResolvedValue({ id: 'p-1', status: 'rejected' });
            await expect(service.requestMergeApproval(REQUEST)).resolves.toEqual({
                raised: false,
                reason: 'already-decided',
            });
            expect(approvals.createProposal).not.toHaveBeenCalled();
        });

        it('a NEW head commit is a NEW ask — the previous decision does not carry over', async () => {
            const seen = new Set<string>();
            const findOneImpl = jest.fn(async (opts: { where: { subjectKey?: string } }) =>
                opts.where.subjectKey && seen.has(opts.where.subjectKey)
                    ? { id: 'p-1', status: 'approved' }
                    : null,
            );
            const { service, approvals } = build({ findOneImpl });

            await service.requestMergeApproval(REQUEST);
            seen.add(KEY);
            await service.requestMergeApproval(REQUEST); // same head → no second ask
            await service.requestMergeApproval({ ...REQUEST, headSha: OLD_HEAD });

            expect(approvals.createProposal).toHaveBeenCalledTimes(2);
            const keys = approvals.createProposal.mock.calls.map(
                (call: unknown[]) => (call[1] as { subjectKey: string }).subjectKey,
            );
            expect(keys).toEqual([
                KEY,
                mergeApprovalSubjectKey({ taskId: TASK_ID, prNumber: PR, headSha: OLD_HEAD }),
            ]);
        });

        it('raises nothing when the head is not a commit SHA', async () => {
            const { service, approvals } = build();
            await expect(
                service.requestMergeApproval({ ...REQUEST, headSha: 'main' }),
            ).resolves.toEqual({ raised: false, reason: 'unusable-subject' });
            expect(approvals.createProposal).not.toHaveBeenCalled();
        });

        it('reports a failure to raise rather than throwing at the sweep', async () => {
            const { service, proposals, approvals } = build();
            proposals.findOne.mockResolvedValue(null);
            approvals.createProposal.mockRejectedValue(new Error('agent not found'));
            await expect(service.requestMergeApproval(REQUEST)).resolves.toEqual({
                raised: false,
                reason: 'failed',
            });
        });

        it('reports the WINNER when it loses the insert race, not a failure', async () => {
            // This is a check-then-create across two processes — the
            // two-minute `task-pr-status-sync` sweep in the worker and an
            // API `?refresh=true` — so the read can say "nothing here" in
            // both at once. The unique index on (actionType, subjectKey)
            // is what stops two Approve buttons appearing for one merge,
            // of which a later click on the second would grant a fresh 24h
            // validity window over a head the first already covered. The
            // loser has to recognise the collision rather than report a
            // failure the sweep would retry into the same wall.
            const { service, proposals, approvals } = build();
            proposals.findOne
                .mockResolvedValueOnce(null) // the optimistic read
                .mockResolvedValueOnce({ id: 'p-winner', status: 'pending' }); // after the clash
            approvals.createProposal.mockRejectedValue(
                new Error('UNIQUE constraint failed: idx_agent_action_proposals_subject'),
            );

            await expect(service.requestMergeApproval(REQUEST)).resolves.toEqual({
                raised: false,
                reason: 'already-open',
            });
            // Exactly one attempt: it does not retry into the constraint.
            expect(approvals.createProposal).toHaveBeenCalledTimes(1);
        });

        it('reports already-decided when the race winner has since been decided', async () => {
            const { service, proposals, approvals } = build();
            proposals.findOne
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({ id: 'p-winner', status: 'approved' });
            approvals.createProposal.mockRejectedValue(new Error('UNIQUE constraint failed'));

            await expect(service.requestMergeApproval(REQUEST)).resolves.toEqual({
                raised: false,
                reason: 'already-decided',
            });
        });
    });
});

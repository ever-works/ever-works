import type { NodeAgentProfile } from '../../entities/node-agent-profile.entity';
import { NodeAgentProfileService, toProfileRef } from '../node-agent-profile.service';

/**
 * Each Agent's own logins and files on each machine. What an owner relies
 * on, pinned:
 *
 *  - one profile per (machine, Agent), created the first time it is needed;
 *  - a reset asks for the Agent's name, refuses while that Agent is working
 *    on that machine, touches no other Agent's profile, and is audited;
 *  - nothing here ever exposes the key the machine resolves.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const NODE = '33333333-3333-4333-8333-333333333333';
const OTHER_NODE = '44444444-4444-4444-8444-444444444444';
const AGENT = { id: '22222222-2222-4222-8222-222222222222', name: 'Ops', organizationId: null };
const SIBLING = '55555555-5555-4555-8555-555555555555';

function build(
    options: {
        liveJobs?: unknown[];
        liveJobsError?: Error;
        /** Open live views on machines, as `findOpenForNode` answers them; omitted = no session repository wired. */
        openViews?: Array<{ nodeId: string; agentId: string; status: string; createdAt: Date }>;
    } = {},
) {
    const rows: NodeAgentProfile[] = [];
    let seq = 0;
    const profiles = {
        findForNodeAgent: jest.fn(
            async (nodeId: string, agentId: string) =>
                rows.find((row) => row.nodeId === nodeId && row.agentId === agentId) ?? null,
        ),
        create: jest.fn(async (data: Partial<NodeAgentProfile>) => {
            if (rows.some((row) => row.nodeId === data.nodeId && row.agentId === data.agentId)) {
                throw new Error('unique violation');
            }
            const row = {
                id: `profile-${++seq}`,
                createdAt: new Date('2026-09-01T10:00:00.000Z'),
                signedInSiteCount: 0,
                diskBytes: 0,
                ...data,
            } as NodeAgentProfile;
            rows.push(row);
            return row;
        }),
        recordUsage: jest.fn(async () => true),
        reset: jest.fn(
            async (id: string, previousKey: string, patch: Partial<NodeAgentProfile>) => {
                const row = rows.find(
                    (candidate) => candidate.id === id && candidate.profileKey === previousKey,
                );
                if (!row) return false;
                Object.assign(row, patch);
                return true;
            },
        ),
    };
    const nodes = {
        findById: jest.fn(async (id: string) =>
            id === NODE || id === OTHER_NODE ? { id, userId: USER } : null,
        ),
    };
    const jobs = {
        findActiveForUser: jest.fn(async () => {
            if (options.liveJobsError) throw options.liveJobsError;
            return options.liveJobs ?? [];
        }),
    };
    const audit = { tryRecord: jest.fn(async (_input: unknown) => true) };
    const lock = { held: false, keys: [] as unknown[] };
    const sessions = options.openViews
        ? {
              findOpenForNode: jest.fn(async (nodeId: string) =>
                  (options.openViews ?? []).filter((view) => view.nodeId === nodeId),
              ),
              withAdmissionLock: jest.fn(async (keys: unknown, fn: () => Promise<unknown>) => {
                  lock.keys.push(keys);
                  lock.held = true;
                  try {
                      return await fn();
                  } finally {
                      lock.held = false;
                  }
              }),
          }
        : undefined;
    const service = new NodeAgentProfileService(
        profiles as never,
        nodes as never,
        jobs as never,
        audit as never,
        sessions as never,
    );
    const logger = (service as never as { logger: Record<string, () => void> }).logger;
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    return { service, rows, profiles, audit, jobs, sessions, lock };
}

const ensureInput = (nodeId = NODE, agentId = AGENT.id) => ({
    userId: USER,
    organizationId: null,
    nodeId,
    agentId,
});

describe('NodeAgentProfileService.ensure', () => {
    it('creates the profile lazily, once per (machine, Agent), with an opaque key', async () => {
        const { service, rows } = build();

        const first = await service.ensure(ensureInput());
        const again = await service.ensure(ensureInput());

        expect(again.id).toBe(first.id);
        expect(rows).toHaveLength(1);
        expect(first.profileKey).toMatch(/^[0-9a-f]{32}$/);
        expect(first.profileKey).not.toContain('/');
        expect(first.profileKey).not.toContain('\\');
    });

    it('gives a second Agent on the same machine, and the same Agent on another machine, their own profile', async () => {
        const { service, rows } = build();
        const mine = await service.ensure(ensureInput());
        const sibling = await service.ensure(ensureInput(NODE, SIBLING));
        const elsewhere = await service.ensure(ensureInput(OTHER_NODE));

        expect(rows).toHaveLength(3);
        expect(new Set([mine.profileKey, sibling.profileKey, elsewhere.profileKey]).size).toBe(3);
    });

    it('returns the winning row when a concurrent open created it first', async () => {
        const { service, profiles, rows } = build();
        const winner = await service.ensure(ensureInput());
        profiles.findForNodeAgent.mockResolvedValueOnce(null);

        const raced = await service.ensure(ensureInput());

        expect(raced.id).toBe(winner.id);
        expect(rows).toHaveLength(1);
    });
});

describe('NodeAgentProfileService.reset', () => {
    it('rotates only this Agent’s key on this machine, zeroes its usage and writes an audit row', async () => {
        const { service, rows, audit } = build();
        const mine = await service.ensure(ensureInput());
        mine.signedInSiteCount = 4;
        const sibling = await service.ensure(ensureInput(NODE, SIBLING));
        const siblingKey = sibling.profileKey;
        const previousKey = mine.profileKey;

        const outcome = await service.reset({
            userId: USER,
            agent: AGENT,
            nodeId: NODE,
            confirmAgentName: 'Ops',
        });

        expect('reset' in outcome).toBe(true);
        expect(mine.profileKey).not.toBe(previousKey);
        expect(mine).toMatchObject({ signedInSiteCount: 0, diskBytes: 0, lastResetByUserId: USER });
        expect(rows.find((row) => row.agentId === SIBLING)?.profileKey).toBe(siblingKey);
        expect(audit.tryRecord).toHaveBeenCalledTimes(1);
        expect(audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'computer.profile-reset',
                nodeId: NODE,
                details: {
                    agentId: AGENT.id,
                    profileRef: toProfileRef(previousKey),
                    signedInSiteCountBefore: 4,
                },
            }),
        );
    });

    it('refuses when the typed name does not match the Agent', async () => {
        const { service, audit } = build();
        await service.ensure(ensureInput());
        expect(
            await service.reset({
                userId: USER,
                agent: AGENT,
                nodeId: NODE,
                confirmAgentName: 'ops-typo',
            }),
        ).toEqual({ refused: 'name-mismatch' });
        expect(audit.tryRecord).not.toHaveBeenCalled();
    });

    it('refuses while a job for that Agent is live on that machine', async () => {
        const { service, rows } = build({
            liveJobs: [{ nodeId: NODE, kind: 'agent-task', payload: { agentId: AGENT.id } }],
        });
        const mine = await service.ensure(ensureInput());
        const key = mine.profileKey;

        expect(
            await service.reset({
                userId: USER,
                agent: AGENT,
                nodeId: NODE,
                confirmAgentName: 'Ops',
            }),
        ).toEqual({ refused: 'run-live' });
        expect(rows[0].profileKey).toBe(key);
    });

    it('is not blocked by another Agent working on the same machine, or this Agent working elsewhere', async () => {
        const { service } = build({
            liveJobs: [
                { nodeId: NODE, kind: 'agent-task', payload: { agentId: SIBLING } },
                { nodeId: OTHER_NODE, kind: 'agent-task', payload: { agentId: AGENT.id } },
            ],
        });
        await service.ensure(ensureInput());
        const outcome = await service.reset({
            userId: USER,
            agent: AGENT,
            nodeId: NODE,
            confirmAgentName: 'Ops',
        });
        expect('reset' in outcome).toBe(true);
    });

    it('fails closed when it cannot tell whether a job is live', async () => {
        const { service } = build({ liveJobsError: new Error('db down') });
        await service.ensure(ensureInput());
        expect(
            await service.reset({
                userId: USER,
                agent: AGENT,
                nodeId: NODE,
                confirmAgentName: 'Ops',
            }),
        ).toEqual({ refused: 'run-live' });
    });

    it('refuses while a live view of that Agent holds a claim on that machine — the view runs on the profile', async () => {
        const { service, rows } = build({
            liveJobs: [{ nodeId: NODE, kind: 'computer-session', payload: { agentId: AGENT.id } }],
        });
        const mine = await service.ensure(ensureInput());
        const key = mine.profileKey;

        expect(
            await service.reset({
                userId: USER,
                agent: AGENT,
                nodeId: NODE,
                confirmAgentName: 'Ops',
            }),
        ).toEqual({ refused: 'run-live' });
        expect(rows[0].profileKey).toBe(key);
    });

    it('refuses while an unclaimed view of that Agent is waiting on that machine, but not for an expired one', async () => {
        const waiting = {
            nodeId: NODE,
            agentId: AGENT.id,
            status: 'requested',
            createdAt: new Date(),
        };
        const blocked = build({ openViews: [waiting] });
        await blocked.service.ensure(ensureInput());
        expect(
            await blocked.service.reset({
                userId: USER,
                agent: AGENT,
                nodeId: NODE,
                confirmAgentName: 'Ops',
            }),
        ).toEqual({ refused: 'run-live' });

        const stale = build({
            openViews: [
                { ...waiting, createdAt: new Date(Date.now() - 10 * 60_000) },
                { ...waiting, agentId: SIBLING },
                { ...waiting, nodeId: OTHER_NODE },
            ],
        });
        await stale.service.ensure(ensureInput());
        const outcome = await stale.service.reset({
            userId: USER,
            agent: AGENT,
            nodeId: NODE,
            confirmAgentName: 'Ops',
        });
        expect('reset' in outcome).toBe(true);
    });

    it('checks and rotates inside the machine’s admission lock', async () => {
        const { service, profiles, jobs, lock } = build({ openViews: [] });
        await service.ensure(ensureInput());
        const seenInLock: boolean[] = [];
        jobs.findActiveForUser.mockImplementation(async () => {
            seenInLock.push(lock.held);
            return [];
        });
        profiles.reset.mockImplementationOnce(async () => {
            seenInLock.push(lock.held);
            return true;
        });

        await service.reset({ userId: USER, agent: AGENT, nodeId: NODE, confirmAgentName: 'Ops' });

        expect(lock.keys).toEqual([{ nodeId: NODE }]);
        expect(seenInLock.length).toBeGreaterThanOrEqual(2);
        expect(seenInLock.every(Boolean)).toBe(true);
    });

    it('puts the key back and refuses when work was claimed between the check and the rotation', async () => {
        const { service, rows, jobs, audit } = build();
        const mine = await service.ensure(ensureInput());
        mine.signedInSiteCount = 4;
        mine.diskBytes = 2048;
        const key = mine.profileKey;
        // Nothing live at the first check; a Run claimed before the rotation
        // committed is visible to the re-check.
        jobs.findActiveForUser
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                { nodeId: NODE, kind: 'agent-task', payload: { agentId: AGENT.id } },
            ]);

        const outcome = await service.reset({
            userId: USER,
            agent: AGENT,
            nodeId: NODE,
            confirmAgentName: 'Ops',
        });

        expect(outcome).toEqual({ refused: 'run-live' });
        expect(rows[0]).toMatchObject({ profileKey: key, signedInSiteCount: 4, diskBytes: 2048 });
        expect(rows[0].lastResetAt ?? null).toBeNull();
        expect(audit.tryRecord).not.toHaveBeenCalled();
    });

    it('never restores over a reset that landed after its own rotation', async () => {
        const { service, rows, jobs } = build();
        await service.ensure(ensureInput());
        jobs.findActiveForUser.mockResolvedValueOnce([]).mockImplementationOnce(async () => {
            rows[0].profileKey = 'ff'.repeat(16); // a later reset rotated it again
            return [{ nodeId: NODE, kind: 'agent-task', payload: { agentId: AGENT.id } }];
        });

        expect(
            await service.reset({
                userId: USER,
                agent: AGENT,
                nodeId: NODE,
                confirmAgentName: 'Ops',
            }),
        ).toEqual({ refused: 'run-live' });
        expect(rows[0].profileKey).toBe('ff'.repeat(16));
    });

    it('answers node-not-found for a machine the owner does not have, and profile-not-found when nothing exists', async () => {
        const { service } = build();
        expect(
            await service.reset({
                userId: USER,
                agent: AGENT,
                nodeId: '99999999-9999-4999-8999-999999999999',
                confirmAgentName: 'Ops',
            }),
        ).toEqual({ refused: 'node-not-found' });
        expect(
            await service.reset({
                userId: USER,
                agent: AGENT,
                nodeId: NODE,
                confirmAgentName: 'Ops',
            }),
        ).toEqual({ refused: 'profile-not-found' });
    });
});

describe('NodeAgentProfileService views', () => {
    it('never returns the key the machine resolves, and hides another owner’s profile', async () => {
        const { service } = build();
        const row = await service.ensure(ensureInput());

        const view = await service.getView(USER, NODE, AGENT.id);

        expect(view).not.toBeNull();
        expect(JSON.stringify(view)).not.toContain(row.profileKey);
        expect(view?.profileRef).toBe(row.profileKey.slice(0, 8));
        expect(await service.getView('someone-else', NODE, AGENT.id)).toBeNull();
    });

    it('clamps a machine’s usage report rather than trusting it', async () => {
        const { service, profiles } = build();
        await service.recordSelfReport({
            nodeId: NODE,
            agentId: AGENT.id,
            profileKey: 'k',
            signedInSiteCount: -3,
            diskBytes: Number.POSITIVE_INFINITY,
        });
        expect(profiles.recordUsage).toHaveBeenCalledWith(
            NODE,
            AGENT.id,
            'k',
            expect.objectContaining({ signedInSiteCount: 0, diskBytes: 0 }),
        );
    });
});

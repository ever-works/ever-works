import { AgentIdentityService } from './agent-identity.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * AW-23 — the composer behind the identity card.
 *
 * The contract these cases defend:
 *
 *  1. **One round trip.** The card paints from a single response. A card
 *     that fanned out would show its dot before its sentence, and a dot
 *     with no sentence is exactly the state this epic exists to abolish.
 *  2. **Read-side fail-SOFT** — the deliberate opposite of the brake's
 *     fail-closed posture. A read that breaks degrades ONE row to its
 *     empty value; it never blanks the card and never invents a state.
 *  3. **The status reason comes from the shared resolver**, so the compact
 *     card on a list and the full card on the detail page cannot tell
 *     different stories about the same agent.
 *  4. **No second notes store.** The Notes row is fed by an optional port
 *     and reads `null` while nothing is bound — the notes file itself
 *     belongs to the memory-and-context-files work.
 */
describe('AgentIdentityService (AW-23)', () => {
    const agentId = 'agent-1';

    const AGENT = {
        id: agentId,
        userId: 'u1',
        name: 'research-agent',
        slug: 'research-agent',
        title: 'Senior researcher',
        status: 'active',
        errorCount: 0,
        haltReason: null,
        haltNote: null,
        haltedAt: null,
        haltedByUserId: null,
        haltedRunId: null,
        haltDetail: null,
        haltRepeatCount: 0,
        lastRunAt: new Date('2026-09-01T09:00:00.000Z'),
        nextHeartbeatAt: null,
        avatarMode: 'initials',
        avatarIcon: null,
    } as any;

    let runs: any;
    let escalations: any;
    let approvals: any;

    const make = (over: { escalations?: any; approvals?: any; notes?: any } = {}) =>
        new AgentIdentityService(
            runs,
            'escalations' in over ? over.escalations : escalations,
            'approvals' in over ? over.approvals : approvals,
            over.notes,
        );

    beforeEach(() => {
        runs = {
            findNewestInFlightForAgent: jest.fn().mockResolvedValue(null),
            countInFlightForAgent: jest.fn().mockResolvedValue(0),
            listQueuedForAgent: jest.fn().mockResolvedValue({ total: 0, items: [] }),
            findNewestFailedForAgent: jest.fn().mockResolvedValue(null),
        };
        escalations = { countOpenForAgent: jest.fn().mockResolvedValue(0) };
        approvals = { countPendingForAgent: jest.fn().mockResolvedValue(0) };
    });

    it('paints an idle agent with its schedule and no halt story', async () => {
        const card = await make().build(AGENT);

        expect(card.agent).toEqual({
            id: agentId,
            name: 'research-agent',
            slug: 'research-agent',
            title: 'Senior researcher',
            status: 'active',
            avatarMode: 'initials',
            avatarIcon: null,
        });
        expect(card.status.reason).toBe('idle');
        expect(card.status.heldCount).toBe(0);
        expect(card.workingOn).toBeNull();
    });

    it('reports WORKING with the live run, and links to it', async () => {
        runs.findNewestInFlightForAgent.mockResolvedValue({
            id: 'run-9',
            status: 'running',
            currentActivity: 'Reading the brief',
            startedAt: new Date('2026-09-02T08:00:00.000Z'),
            createdAt: new Date('2026-09-02T07:59:00.000Z'),
        });
        runs.countInFlightForAgent.mockResolvedValue(1);

        const card = await make().build({ ...AGENT, status: 'running' });

        expect(card.status.reason).toBe('working');
        expect(card.status.linkKind).toBe('run');
        expect(card.status.linkId).toBe('run-9');
        expect(card.status.inFlightCount).toBe(1);
        expect(card.workingOn).toEqual({
            runId: 'run-9',
            activity: 'Reading the brief',
            startedAt: '2026-09-02T08:00:00.000Z',
        });
    });

    it('does NOT claim a paused agent with held work is working on something', async () => {
        runs.listQueuedForAgent.mockResolvedValue({ total: 3, items: [] });

        const card = await make().build({
            ...AGENT,
            status: 'paused',
            haltReason: 'user',
            haltNote: 'Waiting on the new contract',
            haltedAt: new Date('2026-09-02T10:00:00.000Z'),
            haltRepeatCount: 1,
        });

        expect(card.status.reason).toBe('pausedByYou');
        expect(card.status.note).toBe('Waiting on the new contract');
        expect(card.status.since).toBe('2026-09-02T10:00:00.000Z');
        expect(card.status.heldCount).toBe(3);
        expect(card.workingOn).toBeNull();
    });

    it('adds up open escalations and pending proposals for "waiting on you"', async () => {
        escalations.countOpenForAgent.mockResolvedValue(1);
        approvals.countPendingForAgent.mockResolvedValue(2);

        const card = await make().build(AGENT);

        expect(escalations.countOpenForAgent).toHaveBeenCalledWith(agentId, 'u1');
        expect(approvals.countPendingForAgent).toHaveBeenCalledWith('u1', agentId);
        expect(card.status.reason).toBe('waitingOnYou');
        expect(card.status.openDecisionCount).toBe(3);
        expect(card.status.linkKind).toBe('decision');
    });

    it('counts zero decisions when neither queue is mounted, and still paints', async () => {
        const card = await make({ escalations: undefined, approvals: undefined }).build(AGENT);

        expect(card.status.reason).toBe('idle');
    });

    it('degrades ONE row when a read throws — never the whole card', async () => {
        runs.countInFlightForAgent.mockRejectedValue(new Error('db down'));
        runs.listQueuedForAgent.mockRejectedValue(new Error('db down'));
        escalations.countOpenForAgent.mockRejectedValue(new Error('db down'));

        const card = await make().build(AGENT);

        expect(card.status.reason).toBe('idle');
        expect(card.status.inFlightCount).toBe(0);
        expect(card.status.heldCount).toBe(0);
    });

    it('links a failure halt to the run behind it, preferring the stored run id', async () => {
        runs.findNewestFailedForAgent.mockResolvedValue({ id: 'run-newest-failed' });

        const stored = await make().build({
            ...AGENT,
            status: 'paused',
            haltReason: 'failures',
            haltedRunId: 'run-stored',
            haltedAt: new Date('2026-09-03T10:00:00.000Z'),
            errorCount: 3,
        });

        expect(stored.status.reason).toBe('stoppedByFailures');
        expect(stored.status.linkId).toBe('run-stored');
        expect(stored.status.failureCount).toBe(3);
        // The stored id was enough; no extra query was spent.
        expect(runs.findNewestFailedForAgent).not.toHaveBeenCalled();
    });

    it('falls back to the newest failed run for an agent halted before this shipped', async () => {
        runs.findNewestFailedForAgent.mockResolvedValue({ id: 'run-newest-failed' });

        const card = await make().build({ ...AGENT, status: 'error', errorCount: 3 });

        expect(card.status.reason).toBe('stoppedByFailures');
        expect(card.status.linkId).toBe('run-newest-failed');
    });

    it('never asks for a failed run when the agent has none', async () => {
        await make().build(AGENT);

        expect(runs.findNewestFailedForAgent).not.toHaveBeenCalled();
    });

    it('states only a display name for a refused credential, never an error body', async () => {
        const card = await make().build({
            ...AGENT,
            status: 'paused',
            haltReason: 'credential',
            haltedAt: new Date('2026-09-04T10:00:00.000Z'),
            haltedRunId: 'run-cred',
            haltDetail: { subjectLabel: 'Repository access', subjectKind: 'repository' },
        });

        expect(card.status.reason).toBe('blockedOnCredential');
        expect(card.status.subjectLabel).toBe('Repository access');
        expect(JSON.stringify(card)).not.toMatch(/sk-|ghp_|Bearer /);
    });

    describe('the Notes row and its extension point', () => {
        it('reads null while nothing is bound — this epic adds no notes store', async () => {
            const card = await make().build(AGENT);

            expect(card.notesPreview).toBeNull();
        });

        it('shows the preview a bound provider returns', async () => {
            const notes = {
                previewForAgent: jest.fn().mockResolvedValue('Prefers short summaries.'),
            };

            const card = await make({ notes }).build(AGENT);

            expect(notes.previewForAgent).toHaveBeenCalledWith(agentId);
            expect(card.notesPreview).toBe('Prefers short summaries.');
        });

        it('degrades to null when the provider throws', async () => {
            const notes = {
                previewForAgent: jest.fn().mockRejectedValue(new Error('store down')),
            };

            const card = await make({ notes }).build(AGENT);

            expect(card.notesPreview).toBeNull();
        });
    });

    describe('the P1 placeholders', () => {
        it('ships the level row as "not set" and promotes nobody', async () => {
            const card = await make().build(AGENT);

            expect(card.level).toEqual({ value: null, driftCount: 0, readiness: null });
        });

        it('ships the personality row empty until the voice work lands', async () => {
            const card = await make().build(AGENT);

            expect(card.personalityPreview).toBeNull();
        });
    });

    describe('listHeld', () => {
        it('labels each held item by the path it arrived on', async () => {
            runs.listQueuedForAgent.mockResolvedValue({
                total: 3,
                items: [
                    {
                        id: 'r1',
                        triggerKind: 'task',
                        summary: 'Draft the brief',
                        createdAt: new Date('2026-09-02T10:00:00.000Z'),
                    },
                    {
                        id: 'r2',
                        triggerKind: 'chat',
                        summary: null,
                        createdAt: new Date('2026-09-02T10:01:00.000Z'),
                    },
                    {
                        id: 'r3',
                        triggerKind: 'heartbeat',
                        summary: null,
                        createdAt: new Date('2026-09-02T10:02:00.000Z'),
                    },
                ],
            });

            const held = await make().listHeld(agentId, 20);

            expect(runs.listQueuedForAgent).toHaveBeenCalledWith(agentId, 'agent-paused', 20);
            expect(held.total).toBe(3);
            expect(held.items.map((i) => i.kind)).toEqual(['task', 'chat', 'other']);
            expect(held.items[0]).toEqual({
                runId: 'r1',
                kind: 'task',
                title: 'Draft the brief',
                heldAt: '2026-09-02T10:00:00.000Z',
            });
        });

        it('is empty, not an error, when the query breaks', async () => {
            runs.listQueuedForAgent.mockRejectedValue(new Error('db down'));

            await expect(make().listHeld(agentId)).resolves.toEqual({ total: 0, items: [] });
        });
    });
});

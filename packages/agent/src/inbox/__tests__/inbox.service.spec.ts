import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { InboxService } from '../inbox.service';
import type { InboxItem } from '../../entities/inbox-item.entity';
import type { CreateInboxItemInput } from '../../database/repositories/inbox-item.repository';

/**
 * Inbox (operator message center) — service-level behaviour.
 *
 * The store is a hand-rolled in-memory fake rather than a mock-per-call:
 * the reply path re-reads the row it just CAS-claimed, so an assertion
 * about "what the human sees after answering" is only meaningful against
 * a store that actually mutates.
 *
 * Every downstream router (steering / approvals / escalations /
 * notifications / activity) is optional in the constructor, so each
 * describe binds exactly the ones its assertion is about.
 */

function makeRow(overrides: Partial<InboxItem> = {}): InboxItem {
    return {
        id: 'i1',
        userId: 'u1',
        kind: 'question',
        title: 'Which database?',
        body: 'Which database?',
        options: null,
        sourceType: 'agent-run',
        agentId: 'a1',
        agentRunId: null,
        taskId: null,
        workId: null,
        escalationId: null,
        proposalId: null,
        status: 'open',
        unread: true,
        answeredAt: null,
        answerText: null,
        answerOptionId: null,
        tenantId: null,
        organizationId: null,
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        ...overrides,
    } as InboxItem;
}

/** In-memory stand-in for `InboxItemRepository`, owner-scoped like the real one. */
function makeStore(seed: InboxItem[] = []) {
    const rows = new Map<string, InboxItem>(seed.map((row) => [row.id, row]));
    let next = seed.length;
    return {
        rows,
        create: jest.fn(async (input: CreateInboxItemInput) => {
            next += 1;
            const row = makeRow({
                ...(input as Partial<InboxItem>),
                options: Array.isArray(input.options)
                    ? (input.options as InboxItem['options'])
                    : null,
                id: `new-${next}`,
                status: 'open',
                unread: true,
                answeredAt: null,
            });
            rows.set(row.id, row);
            return row;
        }),
        findOwned: jest.fn(async (id: string, userId: string) => {
            const row = rows.get(id);
            return row && row.userId === userId ? row : null;
        }),
        findByEscalationId: jest.fn(async (escalationId: string) => {
            return [...rows.values()].find((row) => row.escalationId === escalationId) ?? null;
        }),
        findByProposalId: jest.fn(async (proposalId: string) => {
            return [...rows.values()].find((row) => row.proposalId === proposalId) ?? null;
        }),
        listForUser: jest.fn(async (userId: string) => {
            const owned = [...rows.values()].filter(
                (row) => row.userId === userId && row.status !== 'archived',
            );
            return { rows: owned, total: owned.length };
        }),
        countUnreadForUser: jest.fn(async (userId: string) => {
            return [...rows.values()].filter(
                (row) => row.userId === userId && row.unread && row.status !== 'archived',
            ).length;
        }),
        setUnread: jest.fn(async (id: string, userId: string, unread: boolean) => {
            const row = rows.get(id);
            if (!row || row.userId !== userId) return false;
            row.unread = unread;
            return true;
        }),
        setArchived: jest.fn(async (id: string, userId: string, archived: boolean) => {
            const row = rows.get(id);
            if (!row || row.userId !== userId) return null;
            row.status = archived ? 'archived' : row.answeredAt ? 'answered' : 'open';
            return row;
        }),
        markAnswered: jest.fn(
            async (
                id: string,
                userId: string,
                answer: { text?: string | null; optionId?: string | null },
            ) => {
                const row = rows.get(id);
                if (!row || row.userId !== userId || row.status !== 'open') return false;
                row.status = 'answered';
                row.unread = false;
                row.answeredAt = new Date('2026-08-02T00:00:00.000Z');
                row.answerText = answer.text ?? null;
                row.answerOptionId = answer.optionId ?? null;
                return true;
            },
        ),
        reopen: jest.fn(async (id: string, userId: string) => {
            const row = rows.get(id);
            if (!row || row.userId !== userId || row.status !== 'answered') return false;
            row.status = 'open';
            row.answeredAt = null;
            row.answerText = null;
            row.answerOptionId = null;
            return true;
        }),
        deleteOwned: jest.fn(async (id: string, userId: string) => {
            const row = rows.get(id);
            if (!row || row.userId !== userId) return false;
            rows.delete(id);
            return true;
        }),
    };
}

function makeRuns(run: Record<string, unknown> | null = null) {
    return {
        findById: jest.fn(async () => run),
        findByIdAndUser: jest.fn(async () => run),
        setAwaitingInput: jest.fn(async () => undefined),
    };
}

function makeSteering() {
    return {
        steer: jest.fn(async () => ({ dispatched: 'injected' as const })),
        resume: jest.fn(async () => ({ runId: 'run-2' })),
    };
}

function build(overrides: {
    store?: ReturnType<typeof makeStore>;
    runs?: ReturnType<typeof makeRuns>;
    steering?: unknown;
    approvals?: unknown;
    escalations?: unknown;
    notifications?: unknown;
    activityLog?: unknown;
}) {
    const store = overrides.store ?? makeStore();
    const runs = overrides.runs ?? makeRuns();
    const service = new InboxService(
        store as never,
        runs as never,
        overrides.steering as never,
        overrides.approvals as never,
        overrides.escalations as never,
        overrides.notifications as never,
        overrides.activityLog as never,
    );
    return { service, store, runs };
}

describe('InboxService', () => {
    describe('askHuman (the ask_human agent tool)', () => {
        it('files the question, parks the asking run, and reports parked=true', async () => {
            const runs = makeRuns({
                id: 'run-1',
                userId: 'u1',
                taskId: 't1',
                workId: 'w1',
                organizationId: 'o1',
            });
            const { service, store } = build({ runs });

            const result = await service.askHuman(
                'u1',
                { question: 'Postgres or SQLite?\nBoth work.', options: undefined },
                { agentId: 'a1', agentRunId: 'run-1' },
            );

            expect(runs.setAwaitingInput).toHaveBeenCalledWith('run-1', true);
            expect(result.parked).toBe(true);
            const created = store.create.mock.calls[0][0];
            expect(created).toMatchObject({
                userId: 'u1',
                kind: 'question',
                sourceType: 'agent-run',
                agentId: 'a1',
                agentRunId: 'run-1',
                taskId: 't1',
                workId: 'w1',
            });
            // The subject is the first line, not the whole question.
            expect(created.title).toBe('Postgres or SQLite?');
            expect(result.item.kind).toBe('question');
        });

        it('normalizes model-supplied options and drops the unusable ones', async () => {
            const { service, store } = build({});
            await service.askHuman(
                'u1',
                {
                    question: 'Pick one',
                    options: [
                        { id: 'a', label: 'Ship it' },
                        { id: 'a', label: 'Duplicate id' },
                        { id: '', label: 'No id' },
                        { id: 'b' },
                        { id: 'c', label: 'Hold', description: 'Wait a day', recommended: true },
                    ],
                },
                { agentId: 'a1', agentRunId: null },
            );
            expect(store.create.mock.calls[0][0].options).toEqual([
                { id: 'a', label: 'Ship it' },
                { id: 'c', label: 'Hold', description: 'Wait a day', recommended: true },
            ]);
        });

        it('files the item WITHOUT run links when the run belongs to someone else', async () => {
            const runs = makeRuns({ id: 'run-1', userId: 'someone-else', taskId: 't1' });
            const { service, store } = build({ runs });

            const result = await service.askHuman(
                'u1',
                { question: 'Whose run is this?' },
                { agentId: 'a1', agentRunId: 'run-1' },
            );

            expect(runs.setAwaitingInput).not.toHaveBeenCalled();
            expect(result.parked).toBe(false);
            expect(store.create.mock.calls[0][0]).toMatchObject({ agentRunId: null, taskId: null });
        });

        it('still files the question when parking the run throws', async () => {
            const runs = makeRuns({ id: 'run-1', userId: 'u1', taskId: 't1' });
            runs.setAwaitingInput.mockRejectedValue(new Error('db down'));
            const { service, store } = build({ runs });

            const result = await service.askHuman(
                'u1',
                { question: 'Still asked?' },
                { agentId: 'a1', agentRunId: 'run-1' },
            );

            expect(result.parked).toBe(false);
            expect(store.create).toHaveBeenCalledTimes(1);
        });

        it('rejects an empty question', async () => {
            const { service } = build({});
            await expect(
                service.askHuman('u1', { question: '   ' }, { agentId: 'a1', agentRunId: null }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('emits the bell row + channel fanout for the new item', async () => {
            const notifications = { notifyInboxItem: jest.fn(async () => undefined) };
            const { service } = build({ notifications });

            await service.askHuman(
                'u1',
                { question: 'Ping?' },
                { agentId: 'a1', agentRunId: null },
            );

            expect(notifications.notifyInboxItem).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'u1', kind: 'question', title: 'Ping?' }),
            );
        });

        it('files the item even when the notification fanout throws', async () => {
            const notifications = {
                notifyInboxItem: jest.fn(async () => {
                    throw new Error('novu down');
                }),
            };
            const { service, store } = build({ notifications });
            await expect(
                service.askHuman('u1', { question: 'Ping?' }, { agentId: 'a1', agentRunId: null }),
            ).resolves.toMatchObject({ item: expect.objectContaining({ kind: 'question' }) });
            expect(store.create).toHaveBeenCalledTimes(1);
        });
    });

    describe('escalationRaised / proposalPending producers', () => {
        it('mirrors an escalation into an item carrying the escalationId', async () => {
            const { service, store } = build({});
            await service.escalationRaised({
                userId: 'u1',
                escalationId: 'e1',
                summary: 'Cannot reach the repo',
                decisionNeeded: 'Re-auth or skip?',
                agentId: 'a1',
                runId: 'run-1',
                taskId: 't1',
            });
            expect(store.create.mock.calls[0][0]).toMatchObject({
                kind: 'escalation',
                sourceType: 'escalation',
                escalationId: 'e1',
                title: 'Cannot reach the repo',
                body: 'Re-auth or skip?',
                agentRunId: 'run-1',
            });
        });

        it('is idempotent per escalation — a second mirror writes nothing', async () => {
            const store = makeStore([
                makeRow({ id: 'i1', kind: 'escalation', escalationId: 'e1' }),
            ]);
            const { service } = build({ store });
            await service.escalationRaised({
                userId: 'u1',
                escalationId: 'e1',
                summary: 's',
                decisionNeeded: 'd',
            });
            expect(store.create).not.toHaveBeenCalled();
        });

        it('mirrors a pending proposal with approve/reject options', async () => {
            const { service, store } = build({});
            await service.proposalPending({
                userId: 'u1',
                proposalId: 'p1',
                title: 'Ping the ops channel',
                actionType: 'send_message',
                riskFlags: ['external_side_effect'],
            });
            const created = store.create.mock.calls[0][0];
            expect(created).toMatchObject({ kind: 'approval', proposalId: 'p1' });
            expect(created.options).toEqual([
                { id: 'approve', label: 'Approve' },
                { id: 'reject', label: 'Reject' },
            ]);
            expect(created.body).toContain('external_side_effect');
        });

        it('is idempotent per proposal', async () => {
            const store = makeStore([makeRow({ id: 'i1', kind: 'approval', proposalId: 'p1' })]);
            const { service } = build({ store });
            await service.proposalPending({
                userId: 'u1',
                proposalId: 'p1',
                title: 't',
                actionType: 'other',
            });
            expect(store.create).not.toHaveBeenCalled();
        });

        it('files a system notice', async () => {
            const notifications = { notifyInboxItem: jest.fn(async () => undefined) };
            const { service, store } = build({ notifications });
            await service.notice('u1', {
                title: 'Budget 90% reached',
                body: 'Spend is at 90% of the cap.',
                workId: 'w1',
            });
            expect(store.create.mock.calls[0][0]).toMatchObject({
                kind: 'notice',
                sourceType: 'system',
                workId: 'w1',
            });
            expect(notifications.notifyInboxItem).toHaveBeenCalledWith(
                expect.objectContaining({ kind: 'notice' }),
            );
        });

        it('files but does NOT ring when the producer already notified (notify:false)', async () => {
            // Budget thresholds are the live case: `BudgetAlertHandler`
            // writes the in-app row + email for the same event, so ringing
            // here too would double every crossing.
            const notifications = { notifyInboxItem: jest.fn(async () => undefined) };
            const { service, store } = build({ notifications });
            await service.notice('u1', {
                title: 'Budget 90% reached',
                body: 'Spend is at 90% of the cap.',
                workId: 'w1',
                notify: false,
            });
            expect(store.create).toHaveBeenCalledTimes(1);
            expect(notifications.notifyInboxItem).not.toHaveBeenCalled();
        });
    });

    describe('reply — question routing', () => {
        it('steers a LIVE run and reports the same run id', async () => {
            const store = makeStore([makeRow({ id: 'i1', agentRunId: 'run-1' })]);
            const runs = makeRuns({
                id: 'run-1',
                userId: 'u1',
                status: 'running',
                taskId: 't1',
                awaitingInput: true,
            });
            const steering = makeSteering();
            const { service } = build({ store, runs, steering });

            const outcome = await service.reply('u1', 'i1', { text: 'Use Postgres' });

            expect(steering.steer).toHaveBeenCalledWith({
                runId: 'run-1',
                userId: 'u1',
                message: 'Use Postgres',
            });
            expect(outcome.routed).toBe('steered');
            expect(outcome.runId).toBe('run-1');
            expect(outcome.item.status).toBe('answered');
            expect(outcome.item.unread).toBe(false);
            expect(outcome.item.answerText).toBe('Use Postgres');
        });

        it('resumes a PARKED run and reports the NEW run id', async () => {
            const store = makeStore([makeRow({ id: 'i1', agentRunId: 'run-1' })]);
            const runs = makeRuns({
                id: 'run-1',
                userId: 'u1',
                status: 'completed',
                awaitingInput: true,
                taskId: 't1',
            });
            const steering = makeSteering();
            const { service } = build({ store, runs, steering });

            const outcome = await service.reply('u1', 'i1', { text: 'Use Postgres' });

            expect(steering.steer).not.toHaveBeenCalled();
            expect(steering.resume).toHaveBeenCalledWith('run-1', 'u1', 'Use Postgres');
            expect(outcome.routed).toBe('resumed');
            expect(outcome.runId).toBe('run-2');
        });

        it('falls back to resume when the live steer loses the terminal race', async () => {
            const store = makeStore([makeRow({ id: 'i1', agentRunId: 'run-1' })]);
            const runs = makeRuns({
                id: 'run-1',
                userId: 'u1',
                status: 'running',
                awaitingInput: true,
                taskId: 't1',
            });
            const steering = makeSteering();
            steering.steer.mockResolvedValue({ dispatched: 'new-run' } as never);
            const { service } = build({ store, runs, steering });

            const outcome = await service.reply('u1', 'i1', { text: 'Use Postgres' });

            expect(steering.resume).toHaveBeenCalled();
            expect(outcome.routed).toBe('resumed');
        });

        it('composes "option label — text" when both halves are supplied', async () => {
            const store = makeStore([
                makeRow({
                    id: 'i1',
                    agentRunId: 'run-1',
                    options: [
                        { id: 'pg', label: 'Postgres' },
                        { id: 'lite', label: 'SQLite' },
                    ],
                }),
            ]);
            const runs = makeRuns({
                id: 'run-1',
                userId: 'u1',
                status: 'running',
                taskId: 't1',
                awaitingInput: true,
            });
            const steering = makeSteering();
            const { service } = build({ store, runs, steering });

            const outcome = await service.reply('u1', 'i1', {
                optionId: 'pg',
                text: 'managed, not self-hosted',
            });

            expect(steering.steer).toHaveBeenCalledWith(
                expect.objectContaining({ message: 'Postgres — managed, not self-hosted' }),
            );
            expect(outcome.item.answerOptionId).toBe('pg');
        });

        it('records the answer and clears the park flag when nothing can be routed', async () => {
            const store = makeStore([makeRow({ id: 'i1', agentRunId: 'run-1' })]);
            const runs = makeRuns({
                id: 'run-1',
                userId: 'u1',
                status: 'failed',
                awaitingInput: false,
                taskId: null,
            });
            const steering = makeSteering();
            const { service } = build({ store, runs, steering });

            const outcome = await service.reply('u1', 'i1', { text: 'too late' });

            expect(steering.steer).not.toHaveBeenCalled();
            expect(steering.resume).not.toHaveBeenCalled();
            expect(runs.setAwaitingInput).toHaveBeenCalledWith('run-1', false);
            expect(outcome.routed).toBe('none');
            expect(outcome.item.answerText).toBe('too late');
        });
    });

    describe('reply — approval routing', () => {
        it('proxies approve to the approvals decide path', async () => {
            const store = makeStore([
                makeRow({
                    id: 'i1',
                    kind: 'approval',
                    proposalId: 'p1',
                    options: [
                        { id: 'approve', label: 'Approve' },
                        { id: 'reject', label: 'Reject' },
                    ],
                }),
            ]);
            const approvals = { decide: jest.fn(async () => ({ id: 'p1' })) };
            const { service } = build({ store, approvals });

            const outcome = await service.reply('u1', 'i1', { optionId: 'approve' });

            expect(approvals.decide).toHaveBeenCalledWith('u1', 'p1', 'approved');
            expect(outcome.routed).toBe('approved');
        });

        it('proxies reject', async () => {
            const store = makeStore([
                makeRow({
                    id: 'i1',
                    kind: 'approval',
                    proposalId: 'p1',
                    options: [
                        { id: 'approve', label: 'Approve' },
                        { id: 'reject', label: 'Reject' },
                    ],
                }),
            ]);
            const approvals = { decide: jest.fn(async () => ({ id: 'p1' })) };
            const { service } = build({ store, approvals });

            const outcome = await service.reply('u1', 'i1', { optionId: 'reject' });

            expect(approvals.decide).toHaveBeenCalledWith('u1', 'p1', 'rejected');
            expect(outcome.routed).toBe('rejected');
        });

        it('reports already-decided (not a 409) when the proposal was decided elsewhere', async () => {
            const store = makeStore([
                makeRow({
                    id: 'i1',
                    kind: 'approval',
                    proposalId: 'p1',
                    options: [
                        { id: 'approve', label: 'Approve' },
                        { id: 'reject', label: 'Reject' },
                    ],
                }),
            ]);
            const approvals = {
                decide: jest.fn(async () => {
                    throw new ConflictException('already');
                }),
            };
            const { service } = build({ store, approvals });

            const outcome = await service.reply('u1', 'i1', { optionId: 'approve' });

            expect(outcome.routed).toBe('already-decided');
            expect(outcome.item.status).toBe('answered');
        });

        it('rejects a free-text-only reply to an approval', async () => {
            const store = makeStore([
                makeRow({
                    id: 'i1',
                    kind: 'approval',
                    proposalId: 'p1',
                    options: [
                        { id: 'approve', label: 'Approve' },
                        { id: 'reject', label: 'Reject' },
                    ],
                }),
            ]);
            const approvals = { decide: jest.fn() };
            const { service } = build({ store, approvals });

            await expect(service.reply('u1', 'i1', { text: 'looks fine' })).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(approvals.decide).not.toHaveBeenCalled();
        });
    });

    describe('reply — escalation routing', () => {
        it('resolves the escalation with the reply as the note', async () => {
            const store = makeStore([
                makeRow({ id: 'i1', kind: 'escalation', escalationId: 'e1', agentRunId: null }),
            ]);
            const escalations = { resolve: jest.fn(async () => true) };
            const { service } = build({ store, escalations });

            const outcome = await service.reply('u1', 'i1', { text: 'Re-authed, carry on' });

            expect(escalations.resolve).toHaveBeenCalledWith('e1', 'u1', 'Re-authed, carry on');
            expect(outcome.routed).toBe('escalation-resolved');
        });

        it('also resumes the linked parked run with the note', async () => {
            const store = makeStore([
                makeRow({ id: 'i1', kind: 'escalation', escalationId: 'e1', agentRunId: 'run-1' }),
            ]);
            const runs = makeRuns({
                id: 'run-1',
                userId: 'u1',
                status: 'completed',
                awaitingInput: true,
                taskId: 't1',
            });
            const steering = makeSteering();
            const escalations = { resolve: jest.fn(async () => true) };
            const { service } = build({ store, runs, steering, escalations });

            const outcome = await service.reply('u1', 'i1', { text: 'Re-authed' });

            expect(steering.resume).toHaveBeenCalledWith('run-1', 'u1', 'Re-authed');
            expect(outcome.runId).toBe('run-2');
        });

        it('keeps the escalation resolved when the follow-up resume throws', async () => {
            const store = makeStore([
                makeRow({ id: 'i1', kind: 'escalation', escalationId: 'e1', agentRunId: 'run-1' }),
            ]);
            const runs = makeRuns({
                id: 'run-1',
                userId: 'u1',
                status: 'completed',
                awaitingInput: true,
                taskId: 't1',
            });
            const steering = makeSteering();
            steering.resume.mockRejectedValue(new Error('worker gone'));
            const escalations = { resolve: jest.fn(async () => true) };
            const { service } = build({ store, runs, steering, escalations });

            const outcome = await service.reply('u1', 'i1', { text: 'Re-authed' });

            expect(outcome.routed).toBe('escalation-resolved');
            expect(outcome.runId).toBeUndefined();
        });

        it('reports already-decided when the escalation was resolved elsewhere', async () => {
            const store = makeStore([
                makeRow({ id: 'i1', kind: 'escalation', escalationId: 'e1' }),
            ]);
            const escalations = { resolve: jest.fn(async () => false) };
            const { service } = build({ store, escalations });

            const outcome = await service.reply('u1', 'i1', { text: 'done' });

            expect(outcome.routed).toBe('already-decided');
        });
    });

    describe('reply — validation, concurrency and authz', () => {
        it('404s on another user’s item — foreign and missing are the same answer', async () => {
            const store = makeStore([makeRow({ id: 'i1', userId: 'someone-else' })]);
            const { service } = build({ store });
            await expect(service.reply('u1', 'i1', { text: 'hi' })).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('409s when the item was already answered', async () => {
            const store = makeStore([makeRow({ id: 'i1', status: 'answered' })]);
            const { service } = build({ store });
            await expect(service.reply('u1', 'i1', { text: 'again' })).rejects.toBeInstanceOf(
                ConflictException,
            );
        });

        it('rejects an option id that is not on the item', async () => {
            const store = makeStore([
                makeRow({ id: 'i1', options: [{ id: 'pg', label: 'Postgres' }] }),
            ]);
            const { service } = build({ store });
            await expect(service.reply('u1', 'i1', { optionId: 'mysql' })).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('rejects an empty reply (no text, no option)', async () => {
            const store = makeStore([makeRow({ id: 'i1' })]);
            const { service } = build({ store });
            await expect(service.reply('u1', 'i1', { text: '   ' })).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('rejects a reply over the length cap', async () => {
            const store = makeStore([makeRow({ id: 'i1' })]);
            const { service } = build({ store });
            await expect(
                service.reply('u1', 'i1', { text: 'x'.repeat(8001) }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('reports already-decided when a concurrent reply won the CAS', async () => {
            const store = makeStore([makeRow({ id: 'i1', kind: 'notice' })]);
            store.markAnswered.mockResolvedValue(false);
            const { service } = build({ store });

            const outcome = await service.reply('u1', 'i1', { text: 'ok' });

            expect(outcome.routed).toBe('already-decided');
        });

        it('claims BEFORE routing — a lost CAS resumes nothing', async () => {
            // `resume` creates and dispatches a NEW AgentRun every call, so
            // routing before claiming would let two racing replies pay for
            // two runs answering one question.
            const store = makeStore([makeRow({ id: 'i1', agentRunId: 'run-1' })]);
            store.markAnswered.mockResolvedValue(false);
            const runs = makeRuns({
                id: 'run-1',
                status: 'completed',
                awaitingInput: true,
                taskId: 't1',
            });
            const steering = makeSteering();
            const { service } = build({ store, runs, steering });

            const outcome = await service.reply('u1', 'i1', { text: 'Postgres' });

            expect(outcome.routed).toBe('already-decided');
            expect(steering.resume).not.toHaveBeenCalled();
            expect(steering.steer).not.toHaveBeenCalled();
        });

        it('releases the claim when routing throws, so the item stays answerable', async () => {
            const store = makeStore([makeRow({ id: 'i1', agentRunId: 'run-1' })]);
            const runs = makeRuns({
                id: 'run-1',
                status: 'completed',
                awaitingInput: true,
                taskId: 't1',
            });
            const steering = makeSteering();
            steering.resume.mockRejectedValue(new ConflictException('dispatch failed'));
            const { service } = build({ store, runs, steering });

            await expect(service.reply('u1', 'i1', { text: 'Postgres' })).rejects.toBeInstanceOf(
                ConflictException,
            );

            expect(store.reopen).toHaveBeenCalledWith('i1', 'u1');
            expect(store.rows.get('i1')?.status).toBe('open');
            expect(store.rows.get('i1')?.answerText).toBeNull();
        });

        it('an approval reply with no option is rejected without ever claiming', async () => {
            const store = makeStore([
                makeRow({
                    id: 'i1',
                    kind: 'approval',
                    proposalId: 'p1',
                    options: [
                        { id: 'approve', label: 'Approve' },
                        { id: 'reject', label: 'Reject' },
                    ],
                }),
            ]);
            const approvals = { decide: jest.fn() };
            const { service } = build({ store, approvals });

            await expect(service.reply('u1', 'i1', { text: 'looks fine' })).rejects.toBeInstanceOf(
                BadRequestException,
            );

            expect(store.markAnswered).not.toHaveBeenCalled();
            expect(store.rows.get('i1')?.status).toBe('open');
        });

        it('marks a notice answered without routing anywhere', async () => {
            const store = makeStore([makeRow({ id: 'i1', kind: 'notice' })]);
            const steering = makeSteering();
            const { service } = build({ store, steering });

            const outcome = await service.reply('u1', 'i1', { text: 'seen' });

            expect(outcome.routed).toBe('none');
            expect(steering.steer).not.toHaveBeenCalled();
            expect(outcome.item.status).toBe('answered');
        });
    });

    describe('read-state, archive and delete', () => {
        it('lists the active view with the unread count', async () => {
            const store = makeStore([
                makeRow({ id: 'i1' }),
                makeRow({ id: 'i2', unread: false }),
                makeRow({ id: 'i3', status: 'archived' }),
                makeRow({ id: 'i4', userId: 'someone-else' }),
            ]);
            const { service } = build({ store });

            const result = await service.list('u1');

            expect(result.items.map((item) => item.id)).toEqual(['i1', 'i2']);
            expect(result.total).toBe(2);
            expect(result.unreadCount).toBe(1);
        });

        it('marks read and unread again', async () => {
            const store = makeStore([makeRow({ id: 'i1' })]);
            const { service } = build({ store });

            expect((await service.setUnread('i1', 'u1', false)).unread).toBe(false);
            expect((await service.setUnread('i1', 'u1', true)).unread).toBe(true);
        });

        it('archives, then restores an ANSWERED item back to answered', async () => {
            const store = makeStore([
                makeRow({ id: 'i1', status: 'answered', answeredAt: new Date('2026-08-02') }),
            ]);
            const { service } = build({ store });

            expect((await service.setArchived('i1', 'u1', true)).status).toBe('archived');
            expect((await service.setArchived('i1', 'u1', false)).status).toBe('answered');
        });

        it('restores an unanswered item back to open', async () => {
            const store = makeStore([makeRow({ id: 'i1' })]);
            const { service } = build({ store });

            await service.setArchived('i1', 'u1', true);
            expect((await service.setArchived('i1', 'u1', false)).status).toBe('open');
        });

        it('archived items drop out of the unread badge', async () => {
            const store = makeStore([makeRow({ id: 'i1' })]);
            const { service } = build({ store });

            expect(await service.unreadCount('u1')).toBe(1);
            await service.setArchived('i1', 'u1', true);
            expect(await service.unreadCount('u1')).toBe(0);
        });

        it('deletes an owned item and 404s on a foreign one', async () => {
            const store = makeStore([
                makeRow({ id: 'i1' }),
                makeRow({ id: 'i2', userId: 'someone-else' }),
            ]);
            const { service } = build({ store });

            await expect(service.delete('i1', 'u1')).resolves.toBeUndefined();
            await expect(service.delete('i2', 'u1')).rejects.toBeInstanceOf(NotFoundException);
        });

        it('404s every owner-scoped mutation on a foreign item', async () => {
            const store = makeStore([makeRow({ id: 'i1', userId: 'someone-else' })]);
            const { service } = build({ store });

            await expect(service.setUnread('i1', 'u1', false)).rejects.toBeInstanceOf(
                NotFoundException,
            );
            await expect(service.setArchived('i1', 'u1', true)).rejects.toBeInstanceOf(
                NotFoundException,
            );
            await expect(service.getForUser('i1', 'u1')).resolves.toBeNull();
        });
    });

    describe('activity trail', () => {
        it('logs a row on create and on answer', async () => {
            const store = makeStore([makeRow({ id: 'i1', kind: 'notice' })]);
            const activityLog = {
                log: jest.fn(async (_entry: { actionType: string }) => undefined),
            };
            const { service } = build({ store, activityLog });

            await service.notice('u1', { title: 'FYI', body: 'body' });
            await service.reply('u1', 'i1', { text: 'seen' });

            const actions = activityLog.log.mock.calls.map((call) => call[0].actionType);
            expect(actions).toEqual(['inbox_item_created', 'inbox_item_answered']);
        });
    });
});

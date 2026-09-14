import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { composeFleetAnswerMessage, InboxService } from '../inbox.service';
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
        findOpenQuestionByRunId: jest.fn(async (agentRunId: string) => {
            return (
                [...rows.values()].find(
                    (row) =>
                        row.agentRunId === agentRunId &&
                        row.kind === 'question' &&
                        row.status === 'open',
                ) ?? null
            );
        }),
        listForUser: jest.fn(async (userId: string, options: { taskId?: string } = {}) => {
            const owned = [...rows.values()].filter(
                (row) =>
                    row.userId === userId &&
                    row.status !== 'archived' &&
                    (!options.taskId || row.taskId === options.taskId),
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
        stampFirstViewed: jest.fn(async (id: string, userId: string) => {
            const row = rows.get(id);
            if (!row || row.userId !== userId || row.firstViewedAt) return false;
            row.firstViewedAt = new Date('2026-08-01T12:00:00.000Z');
            return true;
        }),
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

    describe('questionRaised (fleet run, slice Q)', () => {
        const fleetInput = () => ({
            userId: 'u1',
            agentRunId: 'run-1',
            question: 'Use Postgres?\nOr SQLite?',
            context: 'Work so far: pushed on branch `task/x`.',
            sourceMeta: {
                nodeId: 'node-1',
                nodeName: 'everdesk2',
                branch: 'task/x',
                taskTitle: 'Fix the thing',
            },
        });

        it('files a fleet-run question with links from the OWNED run row, parks the run and keeps the provenance', async () => {
            const runs = makeRuns({
                id: 'run-1',
                userId: 'u1',
                agentId: 'a1',
                taskId: 't1',
                workId: 'w1',
                organizationId: 'o1',
            });
            const notifications = { notifyInboxItem: jest.fn(async () => undefined) };
            const { service, store } = build({ runs, notifications });

            await service.questionRaised(fleetInput());

            const created = store.create.mock.calls[0][0];
            expect(created).toMatchObject({
                userId: 'u1',
                kind: 'question',
                sourceType: 'fleet-run',
                // No caller-supplied agent id → the run row's.
                agentId: 'a1',
                agentRunId: 'run-1',
                taskId: 't1',
                workId: 'w1',
                organizationId: 'o1',
                sourceMeta: {
                    nodeId: 'node-1',
                    nodeName: 'everdesk2',
                    branch: 'task/x',
                    taskTitle: 'Fix the thing',
                },
            });
            expect(created.title).toBe('Use Postgres?');
            expect(created.body).toBe(
                'Use Postgres?\nOr SQLite?\n\nWork so far: pushed on branch `task/x`.',
            );
            expect(runs.setAwaitingInput).toHaveBeenCalledWith('run-1', true);
            expect(notifications.notifyInboxItem).toHaveBeenCalledTimes(1);
            expect(notifications.notifyInboxItem).toHaveBeenCalledWith(
                expect.objectContaining({ kind: 'question', title: 'Use Postgres?' }),
            );
        });

        it('is idempotent per run — a second call while the question is open files nothing', async () => {
            const runs = makeRuns({ id: 'run-1', userId: 'u1', taskId: 't1' });
            const { service, store } = build({ runs });

            await service.questionRaised(fleetInput());
            await service.questionRaised(fleetInput());

            expect(store.create).toHaveBeenCalledTimes(1);
            expect(runs.setAwaitingInput).toHaveBeenCalledTimes(1);
        });

        it('files the item WITHOUT run links and does not park when the run belongs to someone else', async () => {
            const runs = makeRuns({ id: 'run-1', userId: 'someone-else', taskId: 't1' });
            const { service, store } = build({ runs });

            await service.questionRaised({ ...fleetInput(), agentId: 'a9' });

            expect(store.create.mock.calls[0][0]).toMatchObject({
                sourceType: 'fleet-run',
                agentId: 'a9',
                agentRunId: null,
                taskId: null,
            });
            expect(runs.setAwaitingInput).not.toHaveBeenCalled();
        });

        it('files nothing for a blank question (best-effort by the port contract)', async () => {
            const { service, store, runs } = build({});
            await expect(
                service.questionRaised({ ...fleetInput(), question: '   ' }),
            ).resolves.toBeUndefined();
            expect(store.create).not.toHaveBeenCalled();
            expect(runs.setAwaitingInput).not.toHaveBeenCalled();
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

        it('resumes a parked FLEET run with the question folded into the answer (slice Q)', async () => {
            // The node that executes the answer has no session that
            // remembers the question, so the resume message restates it;
            // the item itself records only the human's words.
            const store = makeStore([
                makeRow({
                    id: 'i1',
                    agentRunId: 'run-1',
                    sourceType: 'fleet-run',
                    title: 'Which DB?',
                }),
            ]);
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
            expect(steering.resume).toHaveBeenCalledWith(
                'run-1',
                'u1',
                composeFleetAnswerMessage('Which DB?', 'Use Postgres'),
            );
            const [, , resumeMessage] = steering.resume.mock.calls[0] as unknown as [
                string,
                string,
                string,
            ];
            expect(resumeMessage).toBe(
                "Your question from the previous run: Which DB?\n\nOwner's answer: Use Postgres",
            );
            expect(outcome.routed).toBe('resumed');
            expect(outcome.runId).toBe('run-2');
            expect(outcome.item.answerText).toBe('Use Postgres');
        });

        it('reopens the item and leaves the fleet run parked when the resume throws (slice Q)', async () => {
            // The planner can refuse (done / cancelled Task, no repository)
            // or the runtime can be off; the owner must be able to answer
            // again or archive, so neither the claim nor the parked flag
            // may be consumed.
            const store = makeStore([
                makeRow({ id: 'i1', agentRunId: 'run-1', sourceType: 'fleet-run' }),
            ]);
            const runs = makeRuns({
                id: 'run-1',
                userId: 'u1',
                status: 'completed',
                awaitingInput: true,
                taskId: 't1',
            });
            const steering = makeSteering();
            steering.resume.mockRejectedValue(
                new ConflictException('Resume could not be dispatched — dispatch-failed'),
            );
            const { service } = build({ store, runs, steering });

            await expect(
                service.reply('u1', 'i1', { text: 'Use Postgres' }),
            ).rejects.toBeInstanceOf(ConflictException);

            expect(store.rows.get('i1')?.status).toBe('open');
            expect(runs.setAwaitingInput).not.toHaveBeenCalled();
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

        it('forwards the Task filter to the store (the Task page open-question lookup, slice Q)', async () => {
            const store = makeStore([
                makeRow({ id: 'i1', taskId: 't1', sourceType: 'fleet-run' }),
                makeRow({ id: 'i2', taskId: 't2' }),
            ]);
            const { service } = build({ store });

            const result = await service.list('u1', { taskId: 't1', status: 'open' });

            expect(store.listForUser).toHaveBeenCalledWith(
                'u1',
                expect.objectContaining({ taskId: 't1', status: 'open' }),
            );
            expect(result.items.map((item) => item.id)).toEqual(['i1']);
            expect(result.items[0].sourceType).toBe('fleet-run');
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

        describe('dismissing a parked FLEET run (slice Q)', () => {
            // A run parked on a fleet question has no other exit: cancel
            // refuses terminal rows and the sweeper never reaps an
            // awaiting row. Archiving / deleting the OPEN question is the
            // owner's "drop this run".
            const fleetQuestion = () =>
                makeRow({ id: 'i1', sourceType: 'fleet-run', agentRunId: 'run-1', taskId: 't1' });

            it('archiving an open fleet question clears the parked run', async () => {
                const store = makeStore([fleetQuestion()]);
                const runs = makeRuns();
                const { service } = build({ store, runs });

                expect((await service.setArchived('i1', 'u1', true)).status).toBe('archived');

                expect(runs.setAwaitingInput).toHaveBeenCalledTimes(1);
                expect(runs.setAwaitingInput).toHaveBeenCalledWith('run-1', false);
            });

            it('un-archiving it re-parks the run', async () => {
                const store = makeStore([fleetQuestion()]);
                const runs = makeRuns();
                const { service } = build({ store, runs });

                await service.setArchived('i1', 'u1', true);
                expect((await service.setArchived('i1', 'u1', false)).status).toBe('open');

                expect(runs.setAwaitingInput).toHaveBeenLastCalledWith('run-1', true);
                expect(runs.setAwaitingInput).toHaveBeenCalledTimes(2);
            });

            it('deleting an open fleet question clears the parked run', async () => {
                const store = makeStore([fleetQuestion()]);
                const runs = makeRuns();
                const { service } = build({ store, runs });

                await service.delete('i1', 'u1');

                expect(store.rows.has('i1')).toBe(false);
                expect(runs.setAwaitingInput).toHaveBeenCalledWith('run-1', false);
            });

            it('archiving a cloud (agent-run) question leaves its run untouched', async () => {
                const store = makeStore([makeRow({ id: 'i1', agentRunId: 'run-1' })]);
                const runs = makeRuns();
                const { service } = build({ store, runs });

                await service.setArchived('i1', 'u1', true);
                await service.setArchived('i1', 'u1', false);
                await service.delete('i1', 'u1');

                expect(runs.setAwaitingInput).not.toHaveBeenCalled();
            });

            it('archiving an already-ANSWERED fleet question leaves the run untouched', async () => {
                // The reply already resumed (or cleared) the run; there is
                // nothing parked to drop.
                const store = makeStore([
                    makeRow({
                        id: 'i1',
                        sourceType: 'fleet-run',
                        agentRunId: 'run-1',
                        status: 'answered',
                        answeredAt: new Date('2026-08-02'),
                    }),
                ]);
                const runs = makeRuns();
                const { service } = build({ store, runs });

                await service.setArchived('i1', 'u1', true);
                expect((await service.setArchived('i1', 'u1', false)).status).toBe('answered');

                expect(runs.setAwaitingInput).not.toHaveBeenCalled();
            });

            it('a failing un-park never fails the archive', async () => {
                const store = makeStore([fleetQuestion()]);
                const runs = makeRuns();
                runs.setAwaitingInput.mockRejectedValue(new Error('db down'));
                const { service } = build({ store, runs });

                await expect(service.setArchived('i1', 'u1', true)).resolves.toMatchObject({
                    status: 'archived',
                });
            });
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

/**
 * My Decisions — the decision view of the Inbox and the doors that close it.
 *
 * The queue is the Inbox (no second record), so these pin what the service
 * adds on top of the store: the DTO mapping of the decision context, the
 * opt-in reason rule, the first-view stamp, what happened to the WORK after
 * an answer (`restart`), and that a decision taken through another door
 * closes the mirror exactly once and restarts the work exactly once.
 */
describe('InboxService — My Decisions', () => {
    const APPROVAL_OPTIONS = [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
    ];

    function silenceWarnings(service: InboxService): void {
        jest.spyOn(
            (service as never as { logger: { warn: () => void } }).logger,
            'warn',
        ).mockImplementation(() => undefined);
    }

    function parkedRun(overrides: Record<string, unknown> = {}) {
        return makeRuns({
            id: 'run-1',
            userId: 'u1',
            status: 'completed',
            awaitingInput: true,
            taskId: 't1',
            ...overrides,
        });
    }

    const emptyContext = {
        runStatus: null,
        runParked: false,
        taskId: null,
        taskTitle: null,
        taskStatus: null,
        missionId: null,
        reasonCode: null,
        confidence: null,
        confidenceSource: 'ai-judge',
        attempted: null,
        actionType: null,
        riskFlags: null,
        agentName: null,
    };

    describe('listDecisions / decisionCounts', () => {
        it('maps the linked context and returns the header counts', async () => {
            const createdAt = new Date('2026-08-01T00:00:00.000Z');
            const store = {
                ...makeStore(),
                listDecisionsForUser: jest.fn(async () => ({
                    rows: [
                        {
                            item: makeRow({ id: 'i1', kind: 'escalation', createdAt }),
                            runStatus: 'completed',
                            runParked: true,
                            taskId: 't1',
                            taskTitle: 'Refresh the pricing page',
                            taskStatus: 'in_progress',
                            missionId: 'm1',
                            reasonCode: 'budget-stop',
                            confidence: 1.7,
                            confidenceSource: 'heuristic',
                            attempted: [
                                { label: 'fetch', outcome: '402' },
                                { label: 42 },
                                'garbage',
                            ],
                            actionType: null,
                            riskFlags: null,
                            agentName: 'Researcher',
                        },
                    ],
                    total: 1,
                })),
                countDecisionsForUser: jest.fn(async () => ({
                    open: 3,
                    blocking: 1,
                    lastRaisedAt: createdAt,
                })),
            };
            const { service } = build({ store: store as never });

            const result = await service.listDecisions('u1', { kind: 'escalation', limit: 10 });

            expect(store.listDecisionsForUser).toHaveBeenCalledWith('u1', {
                kind: 'escalation',
                limit: 10,
            });
            expect(result.total).toBe(1);
            expect(result.counts).toEqual({
                open: 3,
                blocking: 1,
                lastRaisedAt: '2026-08-01T00:00:00.000Z',
            });
            expect(result.items[0].decision).toEqual({
                blocking: true,
                blockingReason: 'run-parked',
                // Clamped into 0..1 — a score is a probability, whatever the store holds.
                confidence: 1,
                confidenceSource: 'heuristic',
                reasonCode: 'budget-stop',
                attempted: [{ label: 'fetch', outcome: '402' }],
                actionType: null,
                riskFlags: [],
                agentName: 'Researcher',
                taskId: 't1',
                taskTitle: 'Refresh the pricing page',
                taskStatus: 'in_progress',
                missionId: 'm1',
                runStatus: 'completed',
                dormant: false,
            });
        });

        it('links only a Task the owner-scoped read resolved, never the raw id on the item', async () => {
            const store = {
                ...makeStore(),
                listDecisionsForUser: jest.fn(async () => ({
                    rows: [
                        {
                            // The item still names a Task that was deleted or
                            // belongs to someone else: the join found nothing.
                            ...emptyContext,
                            item: makeRow({ id: 'stale', taskId: 'task-gone' }),
                        },
                        {
                            ...emptyContext,
                            taskId: 't-run',
                            taskTitle: 'From the run',
                            item: makeRow({ id: 'via-run', taskId: null }),
                        },
                    ],
                    total: 2,
                    hasMore: false,
                })),
                countDecisionsForUser: jest.fn(async () => ({
                    open: 2,
                    blocking: 0,
                    lastRaisedAt: null,
                })),
            };
            const { service } = build({ store: store as never });

            const { items } = await service.listDecisions('u1');

            expect(items[0].decision.taskId).toBeNull();
            expect(items[0].decision.taskTitle).toBeNull();
            expect(items[1].decision.taskId).toBe('t-run');
        });

        it('flags an old open decision with nothing live behind it as dormant, never a blocking or live one', async () => {
            const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
            const store = {
                ...makeStore(),
                listDecisionsForUser: jest.fn(async () => ({
                    rows: [
                        { ...emptyContext, item: makeRow({ id: 'dormant', createdAt: old }) },
                        {
                            ...emptyContext,
                            taskStatus: 'blocked',
                            item: makeRow({ id: 'blocking', createdAt: old }),
                        },
                        {
                            ...emptyContext,
                            runStatus: 'running',
                            item: makeRow({ id: 'live', createdAt: old }),
                        },
                    ],
                    total: 3,
                })),
                countDecisionsForUser: jest.fn(async () => ({
                    open: 3,
                    blocking: 1,
                    lastRaisedAt: null,
                })),
            };
            const { service } = build({ store: store as never });

            const { items, counts } = await service.listDecisions('u1');

            expect(items.map((item) => [item.id, item.decision.dormant])).toEqual([
                ['dormant', true],
                ['blocking', false],
                ['live', false],
            ]);
            expect(items[1].decision.blockingReason).toBe('task-blocked');
            // No score, no source — a source with no number describes nothing.
            expect(items[0].decision.confidenceSource).toBeNull();
            expect(counts.lastRaisedAt).toBeNull();
        });

        it('hands back a cursor after the last row only while more follows, and pages from it', async () => {
            const lastCreated = new Date('2026-08-05T00:00:00.000Z');
            const pageRows = [
                {
                    ...emptyContext,
                    blockingRank: 1,
                    confidenceRank: 0.5,
                    item: makeRow({ id: '11111111-1111-4111-8111-111111111111' }),
                },
                {
                    ...emptyContext,
                    blockingRank: 0,
                    confidenceRank: 0.8,
                    item: makeRow({
                        id: '22222222-2222-4222-8222-222222222222',
                        createdAt: lastCreated,
                    }),
                },
            ];
            const store = {
                ...makeStore(),
                listDecisionsForUser: jest
                    .fn()
                    .mockResolvedValueOnce({ rows: pageRows, total: 5, hasMore: true })
                    .mockResolvedValueOnce({
                        rows: pageRows.slice(0, 1),
                        total: 5,
                        hasMore: false,
                    }),
                countDecisionsForUser: jest.fn(async () => ({
                    open: 5,
                    blocking: 1,
                    lastRaisedAt: null,
                })),
            };
            const { service } = build({ store: store as never });

            const first = await service.listDecisions('u1', { limit: 2 });
            expect(first.nextCursor).toEqual(expect.any(String));

            const second = await service.listDecisions('u1', {
                limit: 2,
                cursor: first.nextCursor!,
            });
            expect(store.listDecisionsForUser).toHaveBeenLastCalledWith('u1', {
                limit: 2,
                after: {
                    id: '22222222-2222-4222-8222-222222222222',
                    blockingRank: 0,
                    confidenceRank: 0.8,
                    sortAt: lastCreated,
                },
            });
            // Nothing ranks after the last page: no cursor to follow.
            expect(second.nextCursor).toBeNull();
        });

        it('refuses a cursor that does not decode for the tab, before reading anything', async () => {
            const store = {
                ...makeStore(),
                listDecisionsForUser: jest.fn(),
                countDecisionsForUser: jest.fn(),
            };
            const { service } = build({ store: store as never });

            await expect(
                service.listDecisions('u1', { cursor: 'bm90IGpzb24' }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(store.listDecisionsForUser).not.toHaveBeenCalled();
            expect(store.countDecisionsForUser).not.toHaveBeenCalled();
        });
    });

    describe('first view', () => {
        it('stamps the first view on the first read flip and keeps it on later flips', async () => {
            const store = makeStore([makeRow({ id: 'i1' })]);
            const { service } = build({ store });

            const read = await service.setUnread('i1', 'u1', false);
            expect(read.firstViewedAt).toBe('2026-08-01T12:00:00.000Z');

            await service.setUnread('i1', 'u1', true);
            const again = await service.setUnread('i1', 'u1', false);
            expect(again.firstViewedAt).toBe('2026-08-01T12:00:00.000Z');
            expect(store.stampFirstViewed).toHaveBeenCalledTimes(2);
        });

        it('marking unread never stamps a view', async () => {
            const store = makeStore([makeRow({ id: 'i1', unread: false })]);
            const { service } = build({ store });

            await service.setUnread('i1', 'u1', true);

            expect(store.stampFirstViewed).not.toHaveBeenCalled();
        });

        it('answering stamps the view, and a failing stamp never fails the answer', async () => {
            const store = makeStore([makeRow({ id: 'i1', kind: 'notice' })]);
            store.stampFirstViewed.mockRejectedValue(new Error('db hiccup'));
            const { service } = build({ store });
            silenceWarnings(service);

            const outcome = await service.reply('u1', 'i1', { text: 'seen' });

            expect(outcome.item.status).toBe('answered');
            expect(store.stampFirstViewed).toHaveBeenCalledWith('i1', 'u1');
        });
    });

    describe('reply — the opt-in reason rule', () => {
        it('refuses a rejection without a reason, before claiming anything', async () => {
            const store = makeStore([
                makeRow({
                    id: 'i1',
                    kind: 'approval',
                    proposalId: 'p1',
                    options: APPROVAL_OPTIONS,
                }),
            ]);
            const approvals = { decide: jest.fn() };
            const { service } = build({ store, approvals });

            await expect(
                service.reply('u1', 'i1', { optionId: 'reject', requireReason: true }),
            ).rejects.toBeInstanceOf(BadRequestException);

            expect(store.markAnswered).not.toHaveBeenCalled();
            expect(approvals.decide).not.toHaveBeenCalled();
        });

        it('accepts the rejection with a reason and records it as the answer text', async () => {
            const store = makeStore([
                makeRow({
                    id: 'i1',
                    kind: 'approval',
                    proposalId: 'p1',
                    options: APPROVAL_OPTIONS,
                }),
            ]);
            const approvals = { decide: jest.fn(async () => ({ id: 'p1' })) };
            const { service } = build({ store, approvals });

            const outcome = await service.reply('u1', 'i1', {
                optionId: 'reject',
                text: 'Budget is capped this quarter.',
                requireReason: true,
            });

            expect(outcome.routed).toBe('rejected');
            expect(outcome.item.answerText).toBe('Budget is capped this quarter.');
        });

        it('refuses a non-recommended option without a reason, and allows the recommended one', async () => {
            const options = [
                { id: 'pro', label: 'Pro', recommended: true },
                { id: 'standard', label: 'Standard' },
            ];
            const store = makeStore([
                makeRow({ id: 'i1', options }),
                makeRow({ id: 'i2', options }),
            ]);
            const { service } = build({ store });

            await expect(
                service.reply('u1', 'i1', { optionId: 'standard', requireReason: true }),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                service.reply('u1', 'i2', { optionId: 'pro', requireReason: true }),
            ).resolves.toMatchObject({ item: { status: 'answered' } });
        });

        it('without the opt-in, a bare rejection is accepted exactly as before', async () => {
            const store = makeStore([
                makeRow({
                    id: 'i1',
                    kind: 'approval',
                    proposalId: 'p1',
                    options: APPROVAL_OPTIONS,
                }),
            ]);
            const approvals = { decide: jest.fn(async () => ({ id: 'p1' })) };
            const { service } = build({ store, approvals });

            const outcome = await service.reply('u1', 'i1', { optionId: 'reject' });

            expect(outcome.routed).toBe('rejected');
        });
    });

    describe('reply — what happened to the work (restart)', () => {
        it('reports injected for a steered question', async () => {
            const runs = makeRuns({ id: 'run-1', userId: 'u1', status: 'running', taskId: 't1' });
            const store = makeStore([makeRow({ id: 'i1', agentRunId: 'run-1' })]);
            const { service } = build({ store, runs, steering: makeSteering() });

            await expect(service.reply('u1', 'i1', { text: 'Postgres' })).resolves.toMatchObject({
                routed: 'steered',
                restart: 'injected',
            });
        });

        it('reports queued when the resumed run waits for a free slot', async () => {
            const steering = {
                ...makeSteering(),
                resume: jest.fn(async () => ({ runId: 'run-2', queued: true })),
            };
            const store = makeStore([makeRow({ id: 'i1', agentRunId: 'run-1' })]);
            const { service } = build({ store, runs: parkedRun(), steering });

            await expect(service.reply('u1', 'i1', { text: 'Postgres' })).resolves.toMatchObject({
                routed: 'resumed',
                restart: 'queued',
                runId: 'run-2',
            });
        });

        it('injects an escalation answer into the run that is still going', async () => {
            const store = makeStore([
                makeRow({ id: 'i1', kind: 'escalation', escalationId: 'e1', agentRunId: 'run-1' }),
            ]);
            const runs = makeRuns({ id: 'run-1', userId: 'u1', status: 'running', taskId: 't1' });
            const steering = makeSteering();
            const escalations = { resolve: jest.fn(async () => true) };
            const { service } = build({ store, runs, steering, escalations });

            const outcome = await service.reply('u1', 'i1', { text: 'Use the cached copy' });

            expect(steering.steer).toHaveBeenCalledWith({
                runId: 'run-1',
                userId: 'u1',
                message: 'Use the cached copy',
            });
            expect(steering.resume).not.toHaveBeenCalled();
            expect(outcome).toMatchObject({ restart: 'injected', runId: 'run-1' });
        });

        it('reports failed, and keeps the escalation answered, when the restart throws', async () => {
            const store = makeStore([
                makeRow({ id: 'i1', kind: 'escalation', escalationId: 'e1', agentRunId: 'run-1' }),
            ]);
            const steering = makeSteering();
            steering.resume.mockRejectedValue(new Error('no job runtime'));
            const escalations = { resolve: jest.fn(async () => true) };
            const { service } = build({ store, runs: parkedRun(), steering, escalations });
            silenceWarnings(service);

            const outcome = await service.reply('u1', 'i1', { text: 'Carry on' });

            expect(outcome.restart).toBe('failed');
            expect(outcome.item.status).toBe('answered');
        });

        it('reports failed when work is waiting but no steering runtime is bound', async () => {
            const store = makeStore([
                makeRow({ id: 'i1', kind: 'escalation', escalationId: 'e1', agentRunId: 'run-1' }),
            ]);
            const escalations = { resolve: jest.fn(async () => true) };
            const { service } = build({ store, runs: parkedRun(), escalations });

            await expect(service.reply('u1', 'i1', { text: 'Carry on' })).resolves.toMatchObject({
                routed: 'escalation-resolved',
                restart: 'failed',
            });
        });

        it('resumes a run that parked waiting for an approval', async () => {
            const steering = makeSteering();
            const approvals = { decide: jest.fn(async () => ({ id: 'p1' })) };
            const store = makeStore([
                makeRow({
                    id: 'i1',
                    kind: 'approval',
                    proposalId: 'p1',
                    agentRunId: 'run-1',
                    options: APPROVAL_OPTIONS,
                }),
            ]);
            const { service } = build({ store, runs: parkedRun(), steering, approvals });

            const outcome = await service.reply('u1', 'i1', { optionId: 'approve' });

            expect(steering.resume).toHaveBeenCalledWith('run-1', 'u1', 'Approve');
            expect(outcome).toMatchObject({
                routed: 'approved',
                restart: 'resumed',
                runId: 'run-2',
            });
        });

        it('leaves a run that never parked for the approval alone', async () => {
            const steering = makeSteering();
            const approvals = { decide: jest.fn(async () => ({ id: 'p1' })) };
            const store = makeStore([
                makeRow({
                    id: 'i1',
                    kind: 'approval',
                    proposalId: 'p1',
                    agentRunId: 'run-1',
                    options: APPROVAL_OPTIONS,
                }),
            ]);
            const runs = parkedRun({ awaitingInput: false, status: 'running' });
            const { service } = build({ store, runs, steering, approvals });

            await expect(service.reply('u1', 'i1', { optionId: 'approve' })).resolves.toMatchObject(
                { routed: 'approved', restart: 'none' },
            );
            expect(steering.resume).not.toHaveBeenCalled();
            expect(steering.steer).not.toHaveBeenCalled();
        });
    });

    describe('other doors — escalationResolved / proposalDecided', () => {
        it('closes the escalation mirror with the note and resumes the parked run once', async () => {
            const store = makeStore([
                makeRow({ id: 'i1', kind: 'escalation', escalationId: 'e1', agentRunId: 'run-1' }),
            ]);
            const steering = makeSteering();
            const activityLog = {
                log: jest.fn(async (_entry: { details: Record<string, unknown> }) => undefined),
            };
            const { service } = build({ store, runs: parkedRun(), steering, activityLog });
            const input = {
                escalationId: 'e1',
                resolvedByUserId: 'u1',
                note: 'Raised the budget',
            };

            await service.escalationResolved(input);
            await service.escalationResolved(input);

            const row = store.rows.get('i1')!;
            expect(row.status).toBe('answered');
            expect(row.answerText).toBe('Raised the budget');
            expect(steering.resume).toHaveBeenCalledTimes(1);
            expect(steering.resume).toHaveBeenCalledWith('run-1', 'u1', 'Raised the budget');
            await new Promise((resolve) => setImmediate(resolve));
            const details = activityLog.log.mock.calls.at(-1)![0].details;
            expect(details).toMatchObject({ via: 'escalation', restart: 'resumed' });
            // Shapes only: the note never lands in the activity trail.
            expect(JSON.stringify(details)).not.toContain('Raised the budget');
        });

        it('is a no-op when the Inbox reply already closed the item: one answer, one restart', async () => {
            const store = makeStore([
                makeRow({ id: 'i1', kind: 'escalation', escalationId: 'e1', agentRunId: 'run-1' }),
            ]);
            const steering = makeSteering();
            // The real escalation service calls back into the Inbox from
            // `resolve`; model that loop, so the reply's own claim is what
            // stops a second restart.
            let service: InboxService | undefined;
            const escalations = {
                resolve: jest.fn(async (escalationId: string, userId: string, note: string) => {
                    await service!.escalationResolved({
                        escalationId,
                        resolvedByUserId: userId,
                        note,
                    });
                    return true;
                }),
            };
            service = build({ store, runs: parkedRun(), steering, escalations }).service;

            await service.reply('u1', 'i1', { text: 'Carry on' });

            expect(escalations.resolve).toHaveBeenCalledTimes(1);
            expect(steering.resume).toHaveBeenCalledTimes(1);
        });

        it('does nothing for an unknown escalation', async () => {
            const store = makeStore();
            const { service } = build({ store });

            await expect(
                service.escalationResolved({ escalationId: 'nope', resolvedByUserId: 'u1' }),
            ).resolves.toBeUndefined();
            expect(store.markAnswered).not.toHaveBeenCalled();
        });

        it('closes the approval mirror with the decided option and leaves an unparked run alone', async () => {
            const store = makeStore([
                makeRow({
                    id: 'i1',
                    kind: 'approval',
                    proposalId: 'p1',
                    agentRunId: 'run-1',
                    options: APPROVAL_OPTIONS,
                }),
            ]);
            const runs = makeRuns({ id: 'run-1', userId: 'u1', status: 'running', taskId: 't1' });
            const steering = makeSteering();
            const { service } = build({ store, runs, steering });

            await service.proposalDecided({
                proposalId: 'p1',
                decision: 'rejected',
                decidedByUserId: 'u1',
            });

            const row = store.rows.get('i1')!;
            expect(row.status).toBe('answered');
            expect(row.answerOptionId).toBe('reject');
            expect(steering.steer).not.toHaveBeenCalled();
            expect(steering.resume).not.toHaveBeenCalled();
        });

        it('records the first view when a decision is made through another door', async () => {
            const store = makeStore([
                makeRow({ id: 'esc-item', kind: 'escalation', escalationId: 'e1' }),
                makeRow({
                    id: 'approval-item',
                    kind: 'approval',
                    proposalId: 'p1',
                    options: APPROVAL_OPTIONS,
                }),
            ]);
            const { service } = build({ store });

            await service.escalationResolved({ escalationId: 'e1', resolvedByUserId: 'u1' });
            await service.proposalDecided({
                proposalId: 'p1',
                decision: 'approved',
                decidedByUserId: 'u1',
            });

            for (const id of ['esc-item', 'approval-item']) {
                const row = store.rows.get(id)!;
                expect(row.status).toBe('answered');
                expect(row.answeredAt).not.toBeNull();
                expect(row.firstViewedAt).toEqual(new Date('2026-08-01T12:00:00.000Z'));
            }
            expect(store.stampFirstViewed).toHaveBeenCalledWith('esc-item', 'u1');
            expect(store.stampFirstViewed).toHaveBeenCalledWith('approval-item', 'u1');
        });

        it('keeps a view recorded earlier, stamps nothing on a lost claim, and never fails on a stamp error', async () => {
            const earlier = new Date('2026-07-30T08:00:00.000Z');
            const store = makeStore([
                makeRow({
                    id: 'seen',
                    kind: 'escalation',
                    escalationId: 'e1',
                    firstViewedAt: earlier,
                }),
                makeRow({ id: 'gone', kind: 'escalation', escalationId: 'e2' }),
                makeRow({
                    id: 'flaky',
                    kind: 'approval',
                    proposalId: 'p1',
                    options: APPROVAL_OPTIONS,
                }),
            ]);
            const { service } = build({ store });
            silenceWarnings(service);

            await service.escalationResolved({ escalationId: 'e1', resolvedByUserId: 'u1' });
            expect(store.rows.get('seen')!.firstViewedAt).toEqual(earlier);

            // Another door claimed it between the read and the claim.
            store.markAnswered.mockResolvedValueOnce(false);
            store.stampFirstViewed.mockClear();
            await service.escalationResolved({ escalationId: 'e2', resolvedByUserId: 'u1' });
            expect(store.stampFirstViewed).not.toHaveBeenCalled();

            store.stampFirstViewed.mockRejectedValueOnce(new Error('db hiccup'));
            await expect(
                service.proposalDecided({
                    proposalId: 'p1',
                    decision: 'rejected',
                    decidedByUserId: 'u1',
                }),
            ).resolves.toBeUndefined();
            expect(store.rows.get('flaky')!.answerOptionId).toBe('reject');
        });

        it('leaves an archived mirror archived', async () => {
            const store = makeStore([
                makeRow({ id: 'i1', kind: 'approval', proposalId: 'p1', status: 'archived' }),
            ]);
            const { service } = build({ store });

            await service.proposalDecided({
                proposalId: 'p1',
                decision: 'approved',
                decidedByUserId: 'u1',
            });

            expect(store.rows.get('i1')!.status).toBe('archived');
            expect(store.markAnswered).not.toHaveBeenCalled();
        });
    });

    describe('proposalPending — the Task link', () => {
        it('keeps the producer’s own Task link', async () => {
            const store = makeStore();
            const { service } = build({ store });

            await service.proposalPending({
                userId: 'u1',
                proposalId: 'p1',
                title: 'Merge #12',
                actionType: 'merge_pull_request',
                taskId: 't-merge',
            });

            expect(store.create.mock.calls[0][0].taskId).toBe('t-merge');
        });

        it('falls back to the owned proposing run’s Task', async () => {
            const store = makeStore();
            const runs = makeRuns({ id: 'run-1', userId: 'u1', taskId: 't1' });
            const { service } = build({ store, runs });

            await service.proposalPending({
                userId: 'u1',
                proposalId: 'p1',
                title: 't',
                actionType: 'send_message',
                runId: 'run-1',
            });

            expect(store.create.mock.calls[0][0].taskId).toBe('t1');
        });

        it('never links a foreign run’s Task', async () => {
            const store = makeStore();
            const runs = makeRuns({ id: 'run-1', userId: 'someone-else', taskId: 't9' });
            const { service } = build({ store, runs });

            await service.proposalPending({
                userId: 'u1',
                proposalId: 'p2',
                title: 't',
                actionType: 'send_message',
                runId: 'run-1',
            });

            expect(store.create.mock.calls[0][0].taskId).toBeNull();
        });
    });
});

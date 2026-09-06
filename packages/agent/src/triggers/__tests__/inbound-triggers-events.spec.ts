import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InboundTriggersService } from '../inbound-triggers.service';
import { TriggerEventFiringService } from '../trigger-event-firing.service';
import { WebhookSubscriptionSecretService } from '../../services/webhook-subscription-secret.service';
import { TRIGGER_TEST_LABEL } from '../inbound-trigger.types';
import type { InboundTrigger } from '../../entities/inbound-trigger.entity';
import type { IngestedEvent } from '../../entities/ingested-event.entity';

/**
 * Task Triggers — event-source firing, test-fire and the new
 * create/update validation. Same fixture conventions as
 * `inbound-triggers.service.spec.ts` (real secret service in its
 * documented test-env passthrough mode), extended with the fire-ledger
 * repository and a fake task-template lookup.
 */

const SCOPE = { userId: 'user-1', organizationId: null };

function makeRepo() {
    const rows = new Map<string, InboundTrigger>();
    let seq = 0;
    return {
        _rows: rows,
        create: jest.fn((partial: Partial<InboundTrigger>) => ({ ...partial })),
        save: jest.fn(async (row: Partial<InboundTrigger>) => {
            const id = row.id ?? `trigger-${++seq}`;
            const saved = {
                createdAt: new Date('2026-08-14T00:00:00.000Z'),
                updatedAt: new Date('2026-08-14T00:00:00.000Z'),
                ...row,
                id,
            } as InboundTrigger;
            rows.set(id, saved);
            return saved;
        }),
        find: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
            return [...rows.values()].filter((row) => {
                if (where.userId && row.userId !== where.userId) return false;
                if (where.sourceType && row.sourceType !== where.sourceType) return false;
                if (where.status && row.status !== where.status) return false;
                // `IsNull()` FindOperator (personal scope) vs plain org id.
                const wantOrg = where.organizationId;
                const rowOrg = row.organizationId ?? null;
                if (wantOrg !== undefined) {
                    if (typeof wantOrg === 'object' && wantOrg !== null) {
                        if (rowOrg !== null) return false;
                    } else if (rowOrg !== wantOrg) {
                        return false;
                    }
                }
                return true;
            });
        }),
        findOne: jest.fn(async ({ where }: { where: { id: string } }) => {
            return rows.get(where.id) ?? null;
        }),
        update: jest.fn(async (id: string, patch: Record<string, unknown>) => {
            const row = rows.get(id) as unknown as Record<string, unknown> | undefined;
            if (!row) return;
            for (const [key, value] of Object.entries(patch)) {
                row[key] = typeof value === 'function' ? ((row[key] as number) ?? 0) + 1 : value;
            }
        }),
        delete: jest.fn(async (id: string) => {
            rows.delete(id);
        }),
    };
}

function makeTasks() {
    let seq = 0;
    return {
        create: jest.fn(async (_userId: string, input: { title: string }) => ({
            id: `task-${++seq}`,
            slug: `T-${seq}`,
            title: input.title,
        })),
        addAssignee: jest.fn(async () => ({ id: 'assignee-1' })),
        runTask: jest.fn(async () => ({ taskId: 'task-1', agentId: 'agent-1' })),
    };
}

function makeAgents(known: string[] = ['agent-1']) {
    return {
        findByIdAndUser: jest.fn(async (agentId: string, _userId: string) =>
            known.includes(agentId) ? { id: agentId } : null,
        ),
    };
}

/** In-memory (triggerId, dedupeKey) claim ledger with the repository contract. */
function makeFires() {
    const rows = new Map<string, { id: string; taskId: string | null; firedAt: Date }>();
    let seq = 0;
    return {
        _rows: rows,
        claim: jest.fn(
            async (triggerId: string, dedupeKey: string, origin: string, windowMs?: number) => {
                const key = `${triggerId}|${dedupeKey}`;
                const existing = rows.get(key);
                if (existing) {
                    const age = Date.now() - existing.firedAt.getTime();
                    if (windowMs === undefined || age <= windowMs) {
                        return { fire: { ...existing, origin }, won: false };
                    }
                    const reclaimed = { ...existing, taskId: null, firedAt: new Date() };
                    rows.set(key, reclaimed);
                    return { fire: { ...reclaimed, origin }, won: true };
                }
                const fire = { id: `fire-${++seq}`, taskId: null, firedAt: new Date() };
                rows.set(key, fire);
                return { fire: { ...fire, origin }, won: true };
            },
        ),
        complete: jest.fn(async () => undefined),
        listRecent: jest.fn(async () => []),
    };
}

function makeEvent(overrides: Partial<IngestedEvent> = {}): IngestedEvent {
    return {
        id: 'event-1',
        userId: 'user-1',
        organizationId: null,
        workId: null,
        source: 'github',
        sourceEventId: 'src-1',
        kind: 'github.push',
        occurredAt: new Date('2026-08-14T12:00:00.000Z'),
        actorName: 'ada',
        subjectType: null,
        subjectExternalId: null,
        title: 'Pushed 3 commits',
        sourceUrl: 'https://github.com/acme/widgets',
        payload: { repoFullName: 'acme/widgets', commitCount: 3 },
        processedAt: null,
        dedupeKey: 'dedupe-1',
        createdAt: new Date('2026-08-14T12:00:01.000Z'),
        ...overrides,
    } as IngestedEvent;
}

interface MakeServiceOptions {
    agents?: ReturnType<typeof makeAgents>;
    fires?: ReturnType<typeof makeFires> | null;
    templates?: { findBySlug: jest.Mock } | null;
}

function makeService(overrides: MakeServiceOptions = {}) {
    const repo = makeRepo();
    const tasks = makeTasks();
    const agents = overrides.agents ?? makeAgents();
    const fires = overrides.fires === undefined ? makeFires() : overrides.fires;
    const secrets = new WebhookSubscriptionSecretService();
    jest.spyOn(
        (secrets as unknown as { logger: { warn: (msg: string) => void } }).logger,
        'warn',
    ).mockImplementation(() => undefined);
    const service = new InboundTriggersService(
        repo as never,
        secrets,
        tasks as never,
        agents as never,
        (fires ?? undefined) as never,
        (overrides.templates ?? undefined) as never,
    );
    return { service, repo, tasks, agents, fires };
}

const MATCH_ALL_GITHUB = { eventMatcher: { kind: 'github.*' }, sourceType: 'event' as const };

describe('InboundTriggersService — event-sourced triggers', () => {
    const ORIGINAL_KEY = process.env.PLATFORM_ENCRYPTION_KEY;

    beforeEach(() => {
        delete process.env.PLATFORM_ENCRYPTION_KEY;
    });

    afterEach(() => {
        if (ORIGINAL_KEY === undefined) {
            delete process.env.PLATFORM_ENCRYPTION_KEY;
        } else {
            process.env.PLATFORM_ENCRYPTION_KEY = ORIGINAL_KEY;
        }
        jest.restoreAllMocks();
    });

    describe('create/update validation', () => {
        it('defaults to a webhook trigger with no matcher (regression)', async () => {
            const { service } = makeService();
            const { trigger } = await service.create(SCOPE, { name: 'Hook' });
            expect(trigger.sourceType).toBe('webhook');
            expect(trigger.eventMatcher).toBeNull();
        });

        it('rejects an event trigger without a usable matcher (400)', async () => {
            const { service } = makeService();
            await expect(
                service.create(SCOPE, { name: 'E', sourceType: 'event' }),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                service.create(SCOPE, { name: 'E', sourceType: 'event', eventMatcher: {} }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects a matcher on a webhook trigger (400)', async () => {
            const { service } = makeService();
            await expect(
                service.create(SCOPE, { name: 'W', eventMatcher: { kind: '*' } }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects a non-uuid eventMatcher.workId (400)', async () => {
            const { service } = makeService();
            await expect(
                service.create(SCOPE, {
                    name: 'E',
                    sourceType: 'event',
                    eventMatcher: { workId: 'not-a-uuid' },
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects templates with unsupported placeholders at save time (400)', async () => {
            const { service } = makeService();
            await expect(
                service.create(SCOPE, { name: 'X', taskTitleTemplate: '{{user.email}}' }),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                service.create(SCOPE, {
                    name: 'X',
                    taskDescriptionTemplate: '{{event.payload.a.b}}',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects a malformed taskTemplateSlug (400) and accepts a kebab-case one', async () => {
            const { service } = makeService();
            await expect(
                service.create(SCOPE, { name: 'X', taskTemplateSlug: 'Not A Slug' }),
            ).rejects.toBeInstanceOf(BadRequestException);
            const { trigger } = await service.create(SCOPE, {
                name: 'X',
                taskTemplateSlug: 'bug-triage',
            });
            expect(trigger.taskTemplateSlug).toBe('bug-triage');
        });

        it('update: eventMatcher on a webhook trigger 400s; on an event trigger it replaces', async () => {
            const { service } = makeService();
            const { trigger: hook } = await service.create(SCOPE, { name: 'W' });
            await expect(
                service.update(SCOPE, hook.id, { eventMatcher: { kind: '*' } }),
            ).rejects.toBeInstanceOf(BadRequestException);

            const { trigger: ev } = await service.create(SCOPE, {
                name: 'E',
                ...MATCH_ALL_GITHUB,
            });
            const updated = await service.update(SCOPE, ev.id, {
                eventMatcher: { source: 'slack-connector' },
            });
            expect(updated.eventMatcher).toEqual({ source: 'slack-connector' });
            // Clearing to null is rejected — a matcher stays required.
            await expect(
                service.update(SCOPE, ev.id, { eventMatcher: null }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('fireForEvent', () => {
        it('fires a matching active trigger: task from templates, counters bumped, claim recorded', async () => {
            const { service, repo, tasks, fires } = makeService();
            const { trigger } = await service.create(SCOPE, {
                name: 'Pushes',
                sourceType: 'event',
                eventMatcher: { kind: 'github.*' },
                taskTitleTemplate: 'Push on {{event.payload.repoFullName}}',
                taskDescriptionTemplate: 'By {{event.actorName}} — {{event.title}}',
            });

            const result = await service.fireForEvent(makeEvent());

            expect(result).toEqual({ fired: 1, deduped: 0, failed: 0, refused: 0 });
            expect(tasks.create).toHaveBeenCalledWith(
                'user-1',
                expect.objectContaining({
                    title: 'Push on acme/widgets',
                    description: 'By ada — Pushed 3 commits',
                }),
                { tenantId: null, organizationId: null },
            );
            const row = repo._rows.get(trigger.id) as InboundTrigger;
            expect(row.fireCount).toBe(1);
            expect(row.lastFiredAt).toBeInstanceOf(Date);
            expect(fires!.claim).toHaveBeenCalledWith(trigger.id, 'event-1', 'event');
            expect(fires!.complete).toHaveBeenCalledWith('fire-1', 'done', { taskId: 'task-1' });
        });

        it('is idempotent per (trigger, event): the second offer dedupes, no second task', async () => {
            const { service, repo, tasks } = makeService();
            const { trigger } = await service.create(SCOPE, {
                name: 'Pushes',
                ...MATCH_ALL_GITHUB,
            });

            const first = await service.fireForEvent(makeEvent());
            const second = await service.fireForEvent(makeEvent());

            expect(first.fired).toBe(1);
            expect(second).toEqual({ fired: 0, deduped: 1, failed: 0, refused: 0 });
            expect(tasks.create).toHaveBeenCalledTimes(1);
            expect((repo._rows.get(trigger.id) as InboundTrigger).fireCount).toBe(1);
        });

        it('a DIFFERENT event fires the same trigger again', async () => {
            const { service, tasks } = makeService();
            await service.create(SCOPE, { name: 'Pushes', ...MATCH_ALL_GITHUB });

            await service.fireForEvent(makeEvent({ id: 'event-1' }));
            await service.fireForEvent(makeEvent({ id: 'event-2' }));
            expect(tasks.create).toHaveBeenCalledTimes(2);
        });

        /**
         * The per-(trigger, event) claim above dedupes RETRIES of one row;
         * it says nothing about a source that emits many rows for ONE
         * subject. `{ kind: 'incident' }` — the configuration the
         * integrations page itself recommends — therefore used to file a
         * Task per Sentry alert AND, whenever `targetAgentId` is set with
         * the default `autoStart: 'always'`, dispatch an agent RUN per
         * alert. One flapping issue was a Task storm and an agent-run
         * storm; documenting that in a warning box did not close it.
         *
         * The trigger already carried the knob and the event path simply
         * never applied it: inside `replayWindowSec`, many rows about one
         * subject are one fire.
         */
        describe('subject coalescing (a chatty source is not a Task storm)', () => {
            const incident = (id: string, issueId = '4501') =>
                makeEvent({
                    id,
                    source: 'sentry',
                    kind: 'incident',
                    subjectType: 'issue',
                    subjectExternalId: issueId,
                    payload: { provider: 'sentry', issueId, resource: 'event_alert' },
                });

            const INCIDENTS = {
                sourceType: 'event' as const,
                eventMatcher: { kind: 'incident' },
            };

            it('files ONE Task for twenty alerts about the same issue', async () => {
                const { service, tasks } = makeService();
                await service.create(SCOPE, { name: 'Incidents', ...INCIDENTS });

                let deduped = 0;
                for (let i = 0; i < 20; i += 1) {
                    deduped += (await service.fireForEvent(incident(`row-${i}`))).deduped;
                }

                expect(tasks.create).toHaveBeenCalledTimes(1);
                expect(deduped).toBe(19);
            });

            it('does not swallow a DIFFERENT issue', async () => {
                const { service, tasks } = makeService();
                await service.create(SCOPE, { name: 'Incidents', ...INCIDENTS });

                await service.fireForEvent(incident('row-a', '4501'));
                await service.fireForEvent(incident('row-b', '9999'));

                expect(tasks.create).toHaveBeenCalledTimes(2);
            });

            it('fires the same subject again once the replay window has passed', async () => {
                const { service, tasks, fires } = makeService();
                await service.create(SCOPE, {
                    name: 'Incidents',
                    ...INCIDENTS,
                    replayWindowSec: 10,
                });

                await service.fireForEvent(incident('row-a'));
                // Age every ledger row past the window.
                for (const row of fires!._rows.values()) {
                    row.firedAt = new Date(Date.now() - 60_000);
                }
                await service.fireForEvent(incident('row-b'));

                expect(tasks.create).toHaveBeenCalledTimes(2);
            });

            it('leaves subject-less events (a push, a chat message) firing per event', async () => {
                const { service, tasks } = makeService();
                await service.create(SCOPE, { name: 'Pushes', ...MATCH_ALL_GITHUB });

                await service.fireForEvent(makeEvent({ id: 'event-1' }));
                await service.fireForEvent(makeEvent({ id: 'event-2' }));

                expect(tasks.create).toHaveBeenCalledTimes(2);
            });
        });

        it('skips non-matching, paused, and webhook-sourced triggers', async () => {
            const { service, tasks } = makeService();
            await service.create(SCOPE, {
                name: 'Slack only',
                sourceType: 'event',
                eventMatcher: { source: 'slack-connector' },
            });
            const { trigger: paused } = await service.create(SCOPE, {
                name: 'Paused',
                ...MATCH_ALL_GITHUB,
            });
            await service.pause(SCOPE, paused.id);
            await service.create(SCOPE, { name: 'Webhook', taskTitleTemplate: 'W' });

            const result = await service.fireForEvent(makeEvent());
            expect(result).toEqual({ fired: 0, deduped: 0, failed: 0, refused: 0 });
            expect(tasks.create).not.toHaveBeenCalled();
        });

        it("never fires across scope: another user's (or org's) event is invisible", async () => {
            const { service, tasks } = makeService();
            await service.create(SCOPE, { name: 'Mine', ...MATCH_ALL_GITHUB });

            const foreign = await service.fireForEvent(makeEvent({ userId: 'user-2' }));
            const otherOrg = await service.fireForEvent(makeEvent({ organizationId: 'org-1' }));
            expect(foreign.fired).toBe(0);
            expect(otherOrg.fired).toBe(0);
            expect(tasks.create).not.toHaveBeenCalled();
        });

        it('assigns and dispatches through the gated runTask path when a target agent is set', async () => {
            const { service, tasks } = makeService();
            await service.create(SCOPE, {
                name: 'Pushes',
                targetAgentId: 'agent-1',
                ...MATCH_ALL_GITHUB,
            });

            await service.fireForEvent(makeEvent());
            expect(tasks.addAssignee).toHaveBeenCalledWith('user-1', 'task-1', 'agent', 'agent-1');
            expect(tasks.runTask).toHaveBeenCalledWith('user-1', 'task-1', {
                agentId: 'agent-1',
            });
        });

        it('a refused dispatch (gate) does not undo the fire', async () => {
            const { service, repo, tasks } = makeService();
            const { trigger } = await service.create(SCOPE, {
                name: 'Pushes',
                targetAgentId: 'agent-1',
                ...MATCH_ALL_GITHUB,
            });
            tasks.runTask.mockRejectedValueOnce(new BadRequestException('no credits'));

            const result = await service.fireForEvent(makeEvent());
            expect(result.fired).toBe(1);
            expect((repo._rows.get(trigger.id) as InboundTrigger).fireCount).toBe(1);
        });

        it('one broken trigger cannot block the others (failed counted, rest fire)', async () => {
            const { service, tasks } = makeService();
            await service.create(SCOPE, { name: 'A', ...MATCH_ALL_GITHUB });
            await service.create(SCOPE, { name: 'B', ...MATCH_ALL_GITHUB });
            tasks.create.mockRejectedValueOnce(new Error('boom'));

            const result = await service.fireForEvent(makeEvent());
            expect(result.fired).toBe(1);
            expect(result.failed).toBe(1);
        });

        it('without the fire ledger bound it refuses to fire (no idempotency = no fire)', async () => {
            const { service, tasks } = makeService({ fires: null });
            await service.create(SCOPE, { name: 'Pushes', ...MATCH_ALL_GITHUB });
            const result = await service.fireForEvent(makeEvent());
            expect(result).toEqual({ fired: 0, deduped: 0, failed: 0, refused: 0 });
            expect(tasks.create).not.toHaveBeenCalled();
        });

        it('resolves taskTemplateSlug through the lookup when bound (feature-I seam)', async () => {
            const templates = {
                findBySlug: jest.fn(async () => ({
                    titleTemplate: 'From template: {{event.kind}}',
                    descriptionTemplate: 'Templated body',
                })),
            };
            const { service, tasks } = makeService({ templates });
            await service.create(SCOPE, {
                name: 'Linked',
                taskTemplateSlug: 'bug-triage',
                taskTitleTemplate: 'Own title',
                ...MATCH_ALL_GITHUB,
            });

            await service.fireForEvent(makeEvent());
            expect(templates.findBySlug).toHaveBeenCalledWith('user-1', 'bug-triage');
            expect(tasks.create).toHaveBeenCalledWith(
                'user-1',
                expect.objectContaining({
                    title: 'From template: github.push',
                    description: 'Templated body',
                }),
                { tenantId: null, organizationId: null },
            );
        });

        it('a failing template lookup degrades to the trigger’s own templates', async () => {
            const templates = {
                findBySlug: jest.fn(async () => {
                    throw new Error('templates table missing');
                }),
            };
            const { service, tasks } = makeService({ templates });
            await service.create(SCOPE, {
                name: 'Linked',
                taskTemplateSlug: 'bug-triage',
                taskTitleTemplate: 'Own title',
                ...MATCH_ALL_GITHUB,
            });

            const result = await service.fireForEvent(makeEvent());
            expect(result.fired).toBe(1);
            expect(tasks.create).toHaveBeenCalledWith(
                'user-1',
                expect.objectContaining({ title: 'Own title' }),
                { tenantId: null, organizationId: null },
            );
        });
    });

    describe('testFire', () => {
        it('creates a REAL task labelled trigger-test without touching the counters', async () => {
            const { service, repo, tasks } = makeService();
            const { trigger } = await service.create(SCOPE, {
                name: 'Pushes',
                sourceType: 'event',
                eventMatcher: { kind: 'github.*' },
                taskTitleTemplate: 'Push: {{event.kind}}',
            });

            const result = await service.testFire(SCOPE, trigger.id);

            expect(result.ok).toBe(true);
            // The sample event derives its kind from the matcher (wildcard stripped).
            expect(result.taskTitle).toBe('Push: github.sample');
            expect(tasks.create).toHaveBeenCalledWith(
                'user-1',
                expect.objectContaining({ labels: [TRIGGER_TEST_LABEL] }),
                { tenantId: null, organizationId: null },
            );
            const row = repo._rows.get(trigger.id) as InboundTrigger;
            expect(row.fireCount).toBe(0);
            expect(row.lastFiredAt).toBeNull();
        });

        it('does not dispatch a run — rehearsals must not spend credits', async () => {
            const { service, tasks } = makeService();
            const { trigger } = await service.create(SCOPE, {
                name: 'Pushes',
                targetAgentId: 'agent-1',
                ...MATCH_ALL_GITHUB,
            });

            await service.testFire(SCOPE, trigger.id);
            expect(tasks.addAssignee).toHaveBeenCalled();
            expect(tasks.runTask).not.toHaveBeenCalled();
        });

        it('is ownership-gated like every management route (404 cross-user)', async () => {
            const { service } = makeService();
            const { trigger } = await service.create(SCOPE, { name: 'Mine' });
            await expect(
                service.testFire({ userId: 'user-2', organizationId: null }, trigger.id),
            ).rejects.toBeInstanceOf(NotFoundException);
        });
    });
});

describe('TriggerEventFiringService', () => {
    it('registers a wildcard processor that forwards drained events to fireForEvent', async () => {
        const registered: {
            kinds: readonly string[];
            process: (e: IngestedEvent) => Promise<void>;
        }[] = [];
        const eventIngest = {
            registerKindProcessor: jest.fn((p: (typeof registered)[number]) => registered.push(p)),
        };
        const triggers = {
            fireForEvent: jest.fn(async () => ({ fired: 1, deduped: 0, failed: 0, refused: 0 })),
        };

        const bridge = new TriggerEventFiringService(triggers as never, eventIngest as never);
        bridge.onModuleInit();

        expect(registered).toHaveLength(1);
        expect(registered[0].kinds).toEqual(['*']);

        const event = makeEvent();
        await registered[0].process(event);
        expect(triggers.fireForEvent).toHaveBeenCalledWith(event);
    });

    it('is a no-op when the ingest spine is not mounted', () => {
        const triggers = { fireForEvent: jest.fn() };
        const bridge = new TriggerEventFiringService(triggers as never, undefined);
        expect(() => bridge.onModuleInit()).not.toThrow();
    });
});

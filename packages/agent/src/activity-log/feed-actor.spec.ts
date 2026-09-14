import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import {
    ACTIVITY_ACTOR_LABEL_MAX_LENGTH,
    actorAgentIdOf,
    referencedAgentId,
    resolveFeedActor,
    storableActorLabel,
    subjectAgentIdOf,
    withDerivedActor,
} from './feed-actor';
import { resolveFeedTarget } from './feed-target';

const IVY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WREN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TASK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MISSION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const WORK = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const INBOX = '99999999-9999-4999-8999-999999999999';
const IDEA = '88888888-8888-4888-8888-888888888888';

const entry = (details?: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    userId: 'u-1',
    actionType: ActivityActionType.AGENT_PAUSED,
    action: 'agent_paused',
    status: ActivityStatus.COMPLETED,
    summary: 's',
    details,
    ...extra,
});

describe('feed actor', () => {
    describe('referencedAgentId', () => {
        it('reads the agent resource pair, then an agentId, and only accepts uuids', () => {
            expect(referencedAgentId({ resourceType: 'agent', resourceId: IVY })).toBe(IVY);
            expect(
                referencedAgentId({ resourceType: 'task', resourceId: TASK, agentId: WREN }),
            ).toBe(WREN);
            expect(
                referencedAgentId({ resourceType: 'agent', resourceId: 'not-a-uuid' }),
            ).toBeNull();
            expect(referencedAgentId({ agentId: 42 })).toBeNull();
            expect(referencedAgentId(null)).toBeNull();
            expect(referencedAgentId([] as never)).toBeNull();
        });
    });

    describe('withDerivedActor (write time)', () => {
        it('stamps the agent a writer referenced in details', () => {
            expect(
                withDerivedActor(entry({ resourceType: 'agent', resourceId: IVY })),
            ).toMatchObject({
                actorKind: 'agent',
                actorAgentId: IVY,
            });
        });

        it('returns the same object when there is nothing to derive', () => {
            const payload = entry({ resourceType: 'task', resourceId: TASK });
            expect(withDerivedActor(payload)).toBe(payload);
            const bare = entry();
            expect(withDerivedActor(bare)).toBe(bare);
        });

        it('never overrides an actor the caller passed', () => {
            const payload = entry({ agentId: IVY }, { actorKind: 'user', actorLabel: 'Me' });
            expect(withDerivedActor(payload)).toBe(payload);
        });

        it('keeps the agent a person acted on as the subject, stamping the person as the actor', () => {
            for (const actionType of [
                ActivityActionType.AGENT_EXPORTED,
                ActivityActionType.AGENT_IMPORTED,
            ]) {
                const derived = withDerivedActor(
                    entry({ resourceType: 'agent', resourceId: IVY }, { actionType }),
                );
                expect(derived.actorKind).toBe('user');
                expect(derived.actorAgentId).toBeUndefined();
            }
            // An agent id in details of a person's action is the subject too.
            expect(
                withDerivedActor(
                    entry(
                        { action: 'run', agentId: IVY },
                        { actionType: ActivityActionType.TASK_TRANSITIONED },
                    ),
                ),
            ).toMatchObject({ actorKind: 'user' });
            // A caller that knows an agent acted still says so.
            expect(
                withDerivedActor(
                    entry(
                        { resourceType: 'agent', resourceId: IVY },
                        { actionType: ActivityActionType.AGENT_IMPORTED, actorAgentId: WREN },
                    ),
                ),
            ).toMatchObject({ actorKind: 'agent', actorAgentId: WREN });
        });

        it('records a file save or a refused save as the person, with the agent as its subject', () => {
            for (const actionType of [
                ActivityActionType.AGENT_FILE_EDITED,
                ActivityActionType.AGENT_FILE_REVERTED,
            ]) {
                // The payload the Instructions tab save writes (no actor passed).
                const derived = withDerivedActor(
                    entry({ agentId: IVY, name: 'SOUL.md' }, { actionType }),
                );
                expect(derived.actorKind).toBe('user');
                expect(derived.actorAgentId).toBeUndefined();
                // The agent's own edit tool names itself, and that still wins.
                expect(
                    withDerivedActor(
                        entry(
                            { agentId: IVY, name: 'SOUL.md' },
                            { actionType, actorKind: 'agent', actorAgentId: IVY },
                        ),
                    ),
                ).toMatchObject({ actorKind: 'agent', actorAgentId: IVY });
            }
        });

        it('fills in the kind when only the acting agent was passed', () => {
            expect(withDerivedActor(entry(undefined, { actorAgentId: WREN }))).toMatchObject({
                actorKind: 'agent',
                actorAgentId: WREN,
            });
        });
    });

    describe('resolveFeedActor (read time ladder)', () => {
        const agents = new Map([[IVY, { id: IVY, name: 'Ivy', avatarMode: 'initials' }]]);

        it('rung 1 — the stamped acting agent, keeping the name captured at write time', () => {
            expect(
                resolveFeedActor(
                    {
                        actionType: 'agent_run_completed',
                        actorKind: 'agent',
                        actorAgentId: IVY,
                        actorLabel: 'Ivy v1',
                    },
                    agents,
                ),
            ).toEqual({ kind: 'agent', agentId: IVY, label: 'Ivy v1', avatarMode: 'initials' });
        });

        it('rung 2 — an agent referenced by an older row, named from the lookup', () => {
            expect(
                resolveFeedActor(
                    {
                        actionType: 'agent_paused',
                        details: { resourceType: 'agent', resourceId: IVY },
                    },
                    agents,
                ),
            ).toEqual({ kind: 'agent', agentId: IVY, label: 'Ivy', avatarMode: 'initials' });
            // A deleted agent without a captured name keeps its id but no label.
            expect(
                resolveFeedActor(
                    { actionType: 'agent_paused', details: { agentId: WREN } },
                    agents,
                ),
            ).toEqual({ kind: 'agent', agentId: WREN, label: null, avatarMode: null });
        });

        it('rung 3 — the signed-in user for actions a person takes', () => {
            expect(
                resolveFeedActor({ actionType: ActivityActionType.TASK_CREATED }, agents),
            ).toEqual({
                kind: 'user',
                label: null,
            });
        });

        it('rung 4 — the external source, as data', () => {
            expect(
                resolveFeedActor(
                    {
                        actionType: ActivityActionType.EXTERNAL_EVENT_INGESTED,
                        metadata: { source: 'repo-host' },
                    },
                    agents,
                ),
            ).toEqual({ kind: 'external', label: 'repo-host' });
            expect(
                resolveFeedActor(
                    {
                        actionType: ActivityActionType.WEBSITE_ITEM_SUBMITTED,
                        work: { name: 'Analytics tools' },
                    },
                    agents,
                ),
            ).toEqual({ kind: 'external', label: 'Analytics tools' });
        });

        it('rung 5 — the platform for everything else', () => {
            expect(
                resolveFeedActor({ actionType: ActivityActionType.MISSION_TICK }, agents),
            ).toEqual({
                kind: 'system',
                label: null,
            });
            expect(resolveFeedActor({ actionType: 'totally_unknown' }, agents)).toEqual({
                kind: 'system',
                label: null,
            });
        });

        it('honours an explicit non-agent actor even when details reference an agent', () => {
            const row = {
                actionType: 'agent_file_edited',
                actorKind: 'user' as const,
                details: { agentId: IVY },
            };
            expect(actorAgentIdOf(row)).toBeNull();
            expect(resolveFeedActor(row, agents)).toEqual({ kind: 'user', label: null });
        });

        it('resolves an older export or import to the person, with the agent as its subject', () => {
            const exported = {
                actionType: ActivityActionType.AGENT_EXPORTED,
                details: { resourceType: 'agent', resourceId: IVY },
            };
            expect(actorAgentIdOf(exported)).toBeNull();
            expect(subjectAgentIdOf(exported)).toBe(IVY);
            expect(resolveFeedActor(exported, agents)).toEqual({ kind: 'user', label: null });

            const paused = {
                actionType: ActivityActionType.AGENT_PAUSED,
                details: { resourceType: 'agent', resourceId: IVY },
            };
            expect(actorAgentIdOf(paused)).toBe(IVY);
            // The agent that acted is not also its own subject.
            expect(subjectAgentIdOf(paused)).toBeNull();
            expect(subjectAgentIdOf({ actionType: 'x' })).toBeNull();
        });

        it('resolves an older file save to the person, and an agent-authored one to the agent', () => {
            for (const actionType of [
                ActivityActionType.AGENT_FILE_EDITED,
                ActivityActionType.AGENT_FILE_REVERTED,
            ]) {
                const saved = { actionType, details: { agentId: IVY, name: 'SOUL.md' } };
                expect(actorAgentIdOf(saved)).toBeNull();
                expect(subjectAgentIdOf(saved)).toBe(IVY);
                expect(resolveFeedActor(saved, agents)).toEqual({ kind: 'user', label: null });

                const byAgent = {
                    ...saved,
                    actorKind: 'agent' as const,
                    actorAgentId: IVY,
                    actorLabel: 'Ivy',
                };
                expect(resolveFeedActor(byAgent, agents)).toEqual({
                    kind: 'agent',
                    agentId: IVY,
                    label: 'Ivy',
                    avatarMode: 'initials',
                });
                expect(subjectAgentIdOf(byAgent)).toBeNull();
            }
        });

        it('keeps the name captured at write time after a rename and after a deletion', () => {
            const row = {
                actionType: 'agent_run_completed',
                actorKind: 'agent' as const,
                actorAgentId: IVY,
                actorLabel: 'Ivy (then)',
            };
            const renamed = new Map([[IVY, { id: IVY, name: 'Ivy (now)' }]]);
            expect(resolveFeedActor(row, renamed).label).toBe('Ivy (then)');
            expect(resolveFeedActor(row, new Map()).label).toBe('Ivy (then)');
        });

        it('sanitizes a stored label', () => {
            expect(
                resolveFeedActor(
                    { actionType: 'x', actorKind: 'external', actorLabel: '<img>Hook' },
                    agents,
                ),
            ).toEqual({ kind: 'external', label: 'imgHook' });
        });
    });
});

describe('storableActorLabel', () => {
    it('trims, cuts to the column length by characters, and drops what is unusable', () => {
        expect(storableActorLabel('  Ivy ')).toBe('Ivy');
        const long = '\u{1F916}'.repeat(ACTIVITY_ACTOR_LABEL_MAX_LENGTH + 5);
        expect(Array.from(storableActorLabel(long) as string)).toHaveLength(
            ACTIVITY_ACTOR_LABEL_MAX_LENGTH,
        );
        expect(storableActorLabel('   ')).toBeNull();
        expect(storableActorLabel(null)).toBeNull();
        expect(storableActorLabel(42)).toBeNull();
    });
});

describe('feed target', () => {
    const agentActor = { kind: 'agent' as const, agentId: IVY, label: 'Ivy' };
    const userActor = { kind: 'user' as const, label: null };

    it('sends a decision to the inbox item first', () => {
        expect(
            resolveFeedTarget(
                {
                    actionType: ActivityActionType.INBOX_ITEM_CREATED,
                    details: { inboxItemId: INBOX, agentRunId: RUN },
                },
                agentActor,
                true,
            ),
        ).toEqual({ type: 'inbox', id: INBOX });
    });

    it('then a run receipt, then the task, mission and idea', () => {
        const details = { runId: RUN, taskId: TASK, missionId: MISSION, ideaId: IDEA };
        expect(resolveFeedTarget({ actionType: 'x', details }, agentActor, true)).toEqual({
            type: 'run',
            id: RUN,
        });
        expect(
            resolveFeedTarget(
                { actionType: 'x', details: { ...details, runId: undefined } },
                agentActor,
                true,
            ),
        ).toEqual({
            type: 'task',
            id: TASK,
        });
        expect(
            resolveFeedTarget(
                { actionType: 'x', details: { resourceType: 'task', resourceId: TASK } },
                userActor,
                false,
            ),
        ).toEqual({ type: 'task', id: TASK });
        expect(
            resolveFeedTarget(
                { actionType: 'x', details: { missionId: MISSION, ideaId: IDEA } },
                userActor,
                false,
            ),
        ).toEqual({
            type: 'mission',
            id: MISSION,
        });
        expect(
            resolveFeedTarget({ actionType: 'x', details: { proposalId: IDEA } }, userActor, false),
        ).toEqual({
            type: 'idea',
            id: IDEA,
        });
    });

    it('then the acting agent while it exists, then the Work, then the skill', () => {
        expect(resolveFeedTarget({ actionType: 'x', workId: WORK }, agentActor, true)).toEqual({
            type: 'agent',
            id: IVY,
        });
        expect(resolveFeedTarget({ actionType: 'x', workId: WORK }, agentActor, false)).toEqual({
            type: 'work',
            id: WORK,
        });
        expect(
            resolveFeedTarget(
                { actionType: 'x', details: { resourceType: 'skill', resourceId: TASK } },
                userActor,
                false,
            ),
        ).toEqual({ type: 'skill', id: TASK });
    });

    it('opens the agent a person acted on while it exists, after the task and before the Work', () => {
        expect(resolveFeedTarget({ actionType: 'x', workId: WORK }, userActor, false, IVY)).toEqual(
            { type: 'agent', id: IVY },
        );
        expect(
            resolveFeedTarget(
                { actionType: 'x', details: { taskId: TASK } },
                userActor,
                false,
                IVY,
            ),
        ).toEqual({ type: 'task', id: TASK });
        expect(
            resolveFeedTarget({ actionType: 'x', workId: WORK }, userActor, false, null),
        ).toEqual({ type: 'work', id: WORK });
        expect(resolveFeedTarget({ actionType: 'x' }, userActor, false, 'not-a-uuid')).toBeNull();
    });

    it('offers nothing to open for a deleted agent, including its runs', () => {
        expect(
            resolveFeedTarget({ actionType: 'x', details: { runId: RUN } }, agentActor, false),
        ).toBeNull();
        expect(resolveFeedTarget({ actionType: 'x' }, agentActor, false)).toBeNull();
    });

    it('ignores ids that are not uuids', () => {
        expect(
            resolveFeedTarget(
                {
                    actionType: 'x',
                    workId: 'javascript:alert(1)',
                    details: { runId: '../../etc', taskId: 7 },
                },
                userActor,
                false,
            ),
        ).toBeNull();
    });
});

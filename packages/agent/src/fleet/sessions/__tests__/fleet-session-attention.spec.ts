import { fleetSessionAttentionKey, type FleetSessionAttention } from '@ever-works/contracts';
import type { FleetSession } from '../../../entities/fleet-session.entity';
import { FleetSessionService } from '../fleet-session.service';
import { FleetSessionStateService } from '../fleet-session-state.service';
import { readFleetSessionError } from '../fleet-session.errors';

/**
 * FL-05 P2 — attention on the platform (spec FR-24 … FR-31, FR-48 … FR-50;
 * ACC-FL05-12 … 17, 29 … 31): one key everywhere, acknowledgement, the
 * answer's refusals, the sink on raise / clear / end.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const NODE = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';

function permission(overrides: Partial<FleetSessionAttention> = {}): FleetSessionAttention {
    return {
        key: fleetSessionAttentionKey(SESSION, 'permission', 'tu1'),
        reason: 'permission',
        prompt: 'Allow Bash(pnpm db:migrate)?',
        options: [
            { id: '1', label: 'Allow', primary: true },
            { id: '2', label: 'Deny', deny: true },
        ],
        raisedAt: '2026-10-21T10:00:00.000Z',
        acknowledgedAt: null,
        ...overrides,
    };
}

function row(overrides: Partial<FleetSession> = {}): FleetSession {
    return {
        id: SESSION,
        nodeId: NODE,
        userId: OWNER,
        organizationId: null,
        kind: 'owner',
        provider: 'claude-code',
        agentId: null,
        agentRunId: null,
        checkoutId: null,
        cwd: '~/code/api',
        title: 'api tests',
        state: 'needs_you',
        outcome: null,
        daemonSessionId: SESSION,
        providerSessionId: null,
        firstMessage: null,
        lastScreen: null,
        restartOfSessionId: null,
        startedBy: `user:${OWNER}`,
        lastActivityAt: new Date('2026-10-21T10:00:00.000Z'),
        startedAt: new Date('2026-10-21T09:00:00.000Z'),
        endedAt: null,
        endedReason: null,
        exitCode: null,
        recordingState: 'off',
        attention: permission(),
        stateChangedAt: new Date('2026-10-21T10:00:00.000Z'),
        hooks: null,
        lastEvidence: null,
        boundaryUntil: null,
        createdAt: new Date('2026-10-21T09:00:00.000Z'),
        updatedAt: new Date('2026-10-21T10:00:00.000Z'),
        ...overrides,
    } as FleetSession;
}

function harness(options: { row?: FleetSession; stopped?: boolean; connected?: boolean; nodeError?: unknown } = {}) {
    let current = options.row ?? row();
    const repo = {
        findById: jest.fn(async () => current),
        findByDaemonId: jest.fn(async () => current),
        update: jest.fn(async (_id: string, patch: Partial<FleetSession>) => {
            current = { ...current, ...patch } as FleetSession;
        }),
        updateIfLive: jest.fn(async (_id: string, patch: Partial<FleetSession>) => {
            if (current.state === 'ended') return false;
            current = { ...current, ...patch } as FleetSession;
            return true;
        }),
    };
    const node = { id: NODE, userId: OWNER, name: 'build-01', organizationId: null };
    const access = { resolveForFamily: jest.fn(async () => ({ node, role: 'owner' })), listSharedWith: jest.fn() };
    const killSwitch = { isStopped: jest.fn(async () => options.stopped === true) };
    const audit = { tryRecord: jest.fn(async () => undefined) };
    const port = {
        isConnected: jest.fn(() => options.connected !== false),
        liveConsents: jest.fn(),
        request: jest.fn(async () => {
            if (options.nodeError) throw options.nodeError;
            return { answered: true };
        }),
        ack: jest.fn(),
    };
    const sink = { attentionRaised: jest.fn(async () => undefined), attentionCleared: jest.fn(async () => undefined) };
    const state = new FleetSessionStateService(repo as never, sink);
    const agents = { findById: jest.fn(async () => ({ id: AGENT, permissions: {} })) };
    const service = new FleetSessionService(
        repo as never,
        { findById: jest.fn(async () => node), findByUser: jest.fn(async () => [node]) } as never,
        access as never,
        killSwitch as never,
        audit as never,
        port as never,
        agents as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        state,
    );
    return { service, state, repo, port, audit, sink, current: () => current };
}

async function refusal(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (error) {
        return readFleetSessionError(error);
    }
    throw new Error('expected a refusal');
}

describe('FleetSessionService.answer', () => {
    it('types the option, clears the attention everywhere, and audits the option — never text', async () => {
        const h = harness();
        await h.service.answer(SESSION, { userId: OWNER }, { key: permission().key, optionId: '1' }, 'card');
        expect(h.port.request).toHaveBeenCalledWith(
            expect.objectContaining({ verb: 'session.answer', params: { key: permission().key, answer: { optionId: '1' } } }),
        );
        expect(h.current().attention).toBeNull();
        expect(h.current().state).toBe('working');
        expect(h.sink.attentionCleared).toHaveBeenCalledTimes(1);
        const details = ((h.audit.tryRecord.mock.calls.at(-1) as unknown[] | undefined)?.[0] as { details?: unknown } | undefined)
            ?.details;
        expect(details).toMatchObject({ key: permission().key, optionId: '1', outcome: 'answered', source: 'card' });
        expect(JSON.stringify(details)).not.toContain('"text"');
    });

    it('refuses a stale key with "Already answered" (FR-29, U6)', async () => {
        const h = harness();
        const error = await refusal(h.service.answer(SESSION, { userId: OWNER }, { key: 'fleet-session:x:permission:9', optionId: '1' }, 'card'));
        expect(error).toMatchObject({ code: 'invalid', hint: 'Already answered' });
    });

    it('refuses an Agent on a permission prompt, always (FR-30)', async () => {
        const h = harness();
        const error = await refusal(
            h.service.answer(SESSION, { userId: OWNER, agentId: AGENT }, { key: permission().key, optionId: '1' }, 'tool'),
        );
        expect(error?.code).toBe('permission_denied');
        expect(h.port.request).not.toHaveBeenCalled();
    });

    it('refuses an Agent on another session’s question unless its owner allowed it (R-32)', async () => {
        const question = permission({ key: fleetSessionAttentionKey(SESSION, 'question', 'q1'), reason: 'question' });
        const h = harness({ row: row({ attention: question }) });
        const error = await refusal(
            h.service.answer(SESSION, { userId: OWNER, agentId: AGENT }, { key: question.key, optionId: '1' }, 'tool'),
        );
        expect(error).toMatchObject({ code: 'permission_denied', details: { setting: 'canAnswerOtherSessions' } });
    });

    it('refuses under the kill switch and while the computer is away, keeping the prompt (FR-29, FR-50)', async () => {
        const stopped = harness({ stopped: true });
        expect((await refusal(stopped.service.answer(SESSION, { userId: OWNER }, { key: permission().key, optionId: '1' }, 'card')))?.code).toBe(
            'kill_switch',
        );
        const away = harness({ connected: false });
        expect((await refusal(away.service.answer(SESSION, { userId: OWNER }, { key: permission().key, optionId: '1' }, 'card')))?.code).toBe(
            'unreachable',
        );
        expect(away.current().attention).not.toBeNull();
    });

    it('refuses text where the prompt takes only options', async () => {
        const h = harness();
        expect((await refusal(h.service.answer(SESSION, { userId: OWNER }, { key: permission().key, text: 'yes' }, 'card')))?.code).toBe(
            'invalid',
        );
    });
});

describe('acknowledge (FR-26)', () => {
    it('clears unread, keeps the attention, and refuses a key that moved on', async () => {
        const h = harness();
        const view = await h.service.acknowledge(SESSION, { userId: OWNER }, permission().key);
        expect(view.attention?.acknowledgedAt).not.toBeNull();
        expect(h.current().attention?.key).toBe(permission().key);
        expect((await refusal(h.service.acknowledge(SESSION, { userId: OWNER }, 'fleet-session:x:question:1')))?.code).toBe(
            'invalid',
        );
    });
});

describe('FleetSessionStateService', () => {
    it('keeps raisedAt / acknowledgedAt for the same key, and delivers a NEW key once', async () => {
        const acknowledged = permission({ acknowledgedAt: '2026-10-21T10:01:00.000Z' });
        const h = harness({ row: row({ attention: acknowledged }) });
        await h.state.applyAttention(NODE, {
            type: 'session.attention',
            sessionId: SESSION,
            seq: 10,
            attention: permission({ raisedAt: '2026-10-21T10:05:00.000Z', prompt: 'Allow Bash(pnpm db:migrate)? (again)' }),
        });
        expect(h.current().attention?.acknowledgedAt).toBe('2026-10-21T10:01:00.000Z');
        expect(h.sink.attentionRaised).not.toHaveBeenCalled();

        const next = permission({ key: fleetSessionAttentionKey(SESSION, 'permission', 'tu2') });
        await h.state.applyAttention(NODE, { type: 'session.attention', sessionId: SESSION, seq: 11, attention: next });
        expect(h.sink.attentionCleared).toHaveBeenCalledTimes(1);
        expect(h.sink.attentionRaised).toHaveBeenCalledTimes(1);
    });

    it('a session that ends expires its prompt and raises a failed notice on a failure (U14, R-12)', async () => {
        const h = harness();
        const before = h.current();
        await h.state.sessionEnded(before, { ...before, state: 'ended', outcome: 'failure', exitCode: 1, attention: null } as FleetSession);
        expect(h.sink.attentionCleared).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: 'permission' }), null);
        expect(h.sink.attentionRaised).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ reason: 'failed', prompt: 'exit code 1' }),
            { finished: false },
        );
    });

    it('ignores a status report that is not newer, and a shell claiming needs_you (U5, FR-19)', async () => {
        const h = harness({
            row: row({
                provider: 'shell',
                state: 'working',
                attention: null,
                lastEvidence: { source: 'hook', at: '2026-10-21T10:00:00.000Z', detail: { event: 'prompt', seq: 50 } },
            }),
        });
        const report = {
            type: 'session.status' as const,
            sessionId: SESSION,
            seq: 40,
            state: 'idle' as const,
            outcome: null,
            stateChangedAt: '2026-10-21T10:30:00.000Z',
            lastEvidence: { source: 'exit' as const, at: '2026-10-21T10:30:00.000Z', detail: { event: 'silence' as const, seq: 40 } },
            boundaryUntil: null,
        };
        await h.state.applyStatus(NODE, report);
        expect(h.repo.updateIfLive).not.toHaveBeenCalled();
        await h.state.applyStatus(NODE, { ...report, seq: 60, state: 'needs_you' });
        expect(h.repo.updateIfLive).not.toHaveBeenCalled();
    });
});

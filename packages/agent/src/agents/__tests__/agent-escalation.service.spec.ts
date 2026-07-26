import { AgentEscalationService, toAgentEscalationDto } from '../agent-escalation.service';
import { normalizeAttempts } from '../../database/repositories/agent-escalation.repository';
import type { AgentEscalation } from '../../entities/agent-escalation.entity';

/**
 * Escalation logging schema (judgment layer G3).
 *
 * Everything here is best-effort BY CONTRACT: every call site is already
 * on an error path (the gate gave up, a guardrail refused, a budget
 * stopped the work), so an escalation that throws would replace a
 * specific, useful failure with a generic one. The tests below pin that,
 * plus the idempotency key that stops one give-up becoming five cards.
 */
describe('AgentEscalationService (G3)', () => {
    const ENV_KEY = 'AGENT_ESCALATION_LOGGING_ENABLED';
    let saved: string | undefined;
    let repository: any;

    function makeSvc(): AgentEscalationService {
        const svc = new AgentEscalationService(repository);
        for (const level of ['warn', 'log'] as const) {
            jest.spyOn(
                (svc as never as { logger: Record<string, () => void> }).logger,
                level,
            ).mockImplementation(() => undefined);
        }
        return svc;
    }

    const input = {
        userId: 'u1',
        reasonCode: 'gate-exhausted' as const,
        summary: 'Checks still red after 2 attempts.',
        decisionNeeded: 'Fix by hand or raise the attempt budget.',
        runId: 'run-1',
        taskId: 'task-1',
    };

    beforeEach(() => {
        saved = process.env[ENV_KEY];
        delete process.env[ENV_KEY];
        repository = {
            record: jest.fn().mockResolvedValue({ id: 'e1' }),
            listForTask: jest.fn().mockResolvedValue([]),
            listOpenForUser: jest.fn().mockResolvedValue([]),
            countOpenForWork: jest.fn().mockResolvedValue(0),
            resolve: jest.fn().mockResolvedValue(true),
        };
    });

    afterEach(() => {
        if (saved === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = saved;
        jest.restoreAllMocks();
    });

    it("records an escalation with the caller's reason code and context", async () => {
        const row = await makeSvc().record(input);
        expect(row).toEqual({ id: 'e1' });
        expect(repository.record).toHaveBeenCalledWith(expect.objectContaining(input));
    });

    it('⭐ NEVER throws — an escalation describes a failure, it must not cause one', async () => {
        // THE BEST-EFFORT TEST. Every call site is already reporting a
        // specific failure; if this threw, that specific failure would be
        // replaced by "escalation store unavailable".
        repository.record.mockRejectedValue(new Error('db down'));
        await expect(makeSvc().record(input)).resolves.toBeNull();
    });

    it('writes nothing when logging is switched off', async () => {
        process.env[ENV_KEY] = 'false';
        await expect(makeSvc().record(input)).resolves.toBeNull();
        expect(repository.record).not.toHaveBeenCalled();
    });

    it('delegates the Task feed, digest feed, count and resolve', async () => {
        const svc = makeSvc();
        await svc.listForTask('task-1');
        await svc.listOpenForUser('u1', new Date(0));
        await svc.countOpenForWork('work-1');
        await svc.resolve('e1', 'u1', 'raised the budget');
        expect(repository.listForTask).toHaveBeenCalledWith('task-1', 20);
        expect(repository.listOpenForUser).toHaveBeenCalledWith('u1', expect.any(Date), 20);
        expect(repository.countOpenForWork).toHaveBeenCalledWith('work-1');
        expect(repository.resolve).toHaveBeenCalledWith('e1', 'u1', 'raised the budget');
    });
});

describe('normalizeAttempts — untrusted attempt trail', () => {
    it('⭐ caps every axis an untrusted producer controls', () => {
        // THE DOS TEST. `attempted[].detail` is a build log tail — the one
        // field where an unbounded producer meets a simple-json column.
        const attempts = Array.from({ length: 50 }, (_, i) => ({
            label: 'x'.repeat(500),
            outcome: 'y'.repeat(5000),
            detail: 'z'.repeat(50_000),
        })).map((a, i) => ({ ...a, label: `${a.label}${i}` }));

        const normalized = normalizeAttempts(attempts)!;

        expect(normalized.length).toBeLessThanOrEqual(20);
        expect(normalized[0].label.length).toBeLessThanOrEqual(64);
        expect(normalized[0].outcome.length).toBeLessThanOrEqual(300);
        expect(normalized[0].detail!.length).toBeLessThanOrEqual(1000);
    });

    it('returns null for an absent or empty trail rather than an empty array', () => {
        expect(normalizeAttempts(undefined)).toBeNull();
        expect(normalizeAttempts([])).toBeNull();
    });

    it('omits `detail` entirely when the producer sent none', () => {
        const normalized = normalizeAttempts([{ label: 'lint', outcome: 'exit code 1' }])!;
        expect(normalized[0]).toEqual({ label: 'lint', outcome: 'exit code 1' });
        expect('detail' in normalized[0]).toBe(false);
    });
});

describe('toAgentEscalationDto', () => {
    it('projects dates to ISO and normalizes every nullable', () => {
        const row = {
            id: 'e1',
            userId: 'u1',
            reasonCode: 'merge-refused',
            status: 'open',
            summary: 's',
            decisionNeeded: 'd',
            attempted: null,
            createdAt: new Date('2026-07-25T10:00:00.000Z'),
        } as unknown as AgentEscalation;

        expect(toAgentEscalationDto(row)).toEqual({
            id: 'e1',
            reasonCode: 'merge-refused',
            status: 'open',
            runId: null,
            taskId: null,
            workId: null,
            agentId: null,
            summary: 's',
            decisionNeeded: 'd',
            attempted: [],
            resolvedByUserId: null,
            resolutionNote: null,
            resolvedAt: null,
            createdAt: '2026-07-25T10:00:00.000Z',
        });
    });
});

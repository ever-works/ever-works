import { AgentBrakeService } from '../agent-brake.service';
import { AgentHaltService } from '../agent-halt.service';
import { AgentHaltReason, AgentStatus } from '../../entities/agent.entity';
import type { AgentRepository } from '../../database/repositories/agent.repository';

/**
 * AW-23 — the halt RECORD, and the brake that reads it.
 *
 * The two behaviours these cases exist to protect:
 *
 *  - pressing Pause twice must not rewrite the first pause's story; and
 *  - a resume that fixes nothing must still let the card say "halted for
 *    this reason twice", which is how a halt/resume loop stops being
 *    mysterious.
 */
describe('AgentHaltService (AW-23)', () => {
    type Row = {
        id: string;
        status: AgentStatus;
        haltReason?: AgentHaltReason | null;
        haltRepeatCount: number;
        haltRepeatReason?: AgentHaltReason | null;
    };

    const makeRepo = (row: Row | null) => {
        const stored = row;
        const repo = {
            findById: jest.fn().mockResolvedValue(stored),
            // Mirrors the real CAS: refuses while the agent is ALREADY
            // halted for this same reason.
            writeHalt: jest.fn(async (_id: string, patch: { haltReason: AgentHaltReason }) => {
                if (stored && stored.haltReason === patch.haltReason) return false;
                return true;
            }),
            clearHalt: jest.fn().mockResolvedValue(undefined),
            transitionStatus: jest.fn().mockResolvedValue(true),
        };
        return repo as unknown as AgentRepository & typeof repo;
    };

    const row = (over: Partial<Row> = {}): Row => ({
        id: 'agent-1',
        status: AgentStatus.ACTIVE,
        haltReason: null,
        haltRepeatCount: 0,
        haltRepeatReason: null,
        ...over,
    });

    it('records the reason, the time, the author and the run, and stops the agent', async () => {
        const repo = makeRepo(row());
        const result = await new AgentHaltService(repo).halt('agent-1', AgentHaltReason.USER, {
            note: 'holding until the rebrand ships Friday',
            byUserId: 'user-9',
        });

        expect(result).toEqual({ written: true, repeatCount: 1, transitioned: true });
        expect(repo.writeHalt).toHaveBeenCalledWith(
            'agent-1',
            expect.objectContaining({
                haltReason: AgentHaltReason.USER,
                haltNote: 'holding until the rebrand ships Friday',
                haltedByUserId: 'user-9',
                haltRepeatCount: 1,
            }),
        );
        expect(repo.transitionStatus).toHaveBeenCalledWith(
            'agent-1',
            AgentStatus.ACTIVE,
            AgentStatus.PAUSED,
        );
    });

    it('is a NO-OP when the agent is already halted for the same reason', async () => {
        // A stale browser tab re-posting a pause must not overwrite the
        // first note with an empty one, must not move the timestamp and
        // must not relabel the author — and the caller is told so, so it
        // writes no second activity row either.
        const repo = makeRepo(
            row({
                status: AgentStatus.PAUSED,
                haltReason: AgentHaltReason.USER,
                haltRepeatCount: 1,
                haltRepeatReason: AgentHaltReason.USER,
            }),
        );
        const result = await new AgentHaltService(repo).halt('agent-1', AgentHaltReason.USER, {});

        expect(result.written).toBe(false);
        expect(result.repeatCount).toBe(1);
        expect(repo.transitionStatus).not.toHaveBeenCalled();
    });

    it('counts a SECOND consecutive halt for the same reason after a resume', async () => {
        // The credential loop: halted, resumed without fixing anything,
        // halted again. `haltReason` was cleared by the resume;
        // `haltRepeatReason` is what survives so the counter can say 2.
        const repo = makeRepo(
            row({
                haltReason: null,
                haltRepeatCount: 1,
                haltRepeatReason: AgentHaltReason.CREDENTIAL,
            }),
        );
        const result = await new AgentHaltService(repo).halt(
            'agent-1',
            AgentHaltReason.CREDENTIAL,
            {
                runId: 'run-7',
                detail: { subjectLabel: 'Model provider', subjectKind: 'model-provider' },
            },
        );

        expect(result.repeatCount).toBe(2);
        expect(repo.writeHalt).toHaveBeenCalledWith(
            'agent-1',
            expect.objectContaining({ haltRepeatCount: 2, haltedRunId: 'run-7' }),
        );
    });

    it('resets the counter when the NEXT halt carries a different reason', async () => {
        const repo = makeRepo(
            row({
                haltReason: null,
                haltRepeatCount: 4,
                haltRepeatReason: AgentHaltReason.CREDENTIAL,
            }),
        );
        const result = await new AgentHaltService(repo).halt('agent-1', AgentHaltReason.FAILURES);
        expect(result.repeatCount).toBe(1);
    });

    it('overwrites a user pause when a DIFFERENT reason lands on top of it', async () => {
        // A credential rejection on an agent a person had already paused
        // is genuinely new information about why it is not working.
        const repo = makeRepo(
            row({ status: AgentStatus.PAUSED, haltReason: AgentHaltReason.USER }),
        );
        const result = await new AgentHaltService(repo).halt('agent-1', AgentHaltReason.CREDENTIAL);
        expect(result.written).toBe(true);
        // Already paused — no second transition.
        expect(repo.transitionStatus).not.toHaveBeenCalled();
    });

    it('leaves an ARCHIVED agent alone — archived has no outgoing transition', async () => {
        const repo = makeRepo(row({ status: AgentStatus.ARCHIVED, haltRepeatCount: 2 }));
        const result = await new AgentHaltService(repo).halt('agent-1', AgentHaltReason.USER);
        expect(result).toEqual({ written: false, repeatCount: 2, transitioned: false });
        expect(repo.writeHalt).not.toHaveBeenCalled();
    });

    it('does nothing for an agent that no longer exists', async () => {
        const repo = makeRepo(null);
        const result = await new AgentHaltService(repo).halt('gone', AgentHaltReason.USER);
        expect(result).toEqual({ written: false, repeatCount: 0, transitioned: false });
    });

    it('clear() never throws, so a resume can never fail on it', async () => {
        const repo = makeRepo(row());
        (repo.clearHalt as jest.Mock).mockRejectedValue(new Error('db down'));
        await expect(new AgentHaltService(repo).clear('agent-1')).resolves.toBeUndefined();
    });

    it('records the halt even when the status transition fails', async () => {
        // A missing reason is a degraded label. A failed pause would be a
        // lie — so the reason is written first and reported either way.
        const repo = makeRepo(row());
        (repo.transitionStatus as jest.Mock).mockRejectedValue(new Error('conflict'));
        const result = await new AgentHaltService(repo).halt('agent-1', AgentHaltReason.USER);
        expect(result.written).toBe(true);
        expect(result.transitioned).toBe(false);
    });
});

describe('AgentBrakeService (AW-23)', () => {
    const makeRepo = (findById: jest.Mock) =>
        ({ findById }) as unknown as AgentRepository & { findById: jest.Mock };

    it('halts for a paused agent and reports the stored reason for the log line', async () => {
        const repo = makeRepo(
            jest.fn().mockResolvedValue({
                id: 'a',
                status: AgentStatus.PAUSED,
                haltReason: AgentHaltReason.CREDENTIAL,
            }),
        );
        await expect(new AgentBrakeService(repo).shouldHaltForAgent('a')).resolves.toEqual({
            halted: true,
            reason: AgentHaltReason.CREDENTIAL,
        });
    });

    it('halts for an archived agent', async () => {
        const repo = makeRepo(
            jest.fn().mockResolvedValue({ id: 'a', status: AgentStatus.ARCHIVED }),
        );
        await expect(new AgentBrakeService(repo).shouldHaltForAgent('a')).resolves.toEqual({
            halted: true,
        });
    });

    it('does NOT halt an active agent', async () => {
        const repo = makeRepo(jest.fn().mockResolvedValue({ id: 'a', status: AgentStatus.ACTIVE }));
        await expect(new AgentBrakeService(repo).shouldHaltForAgent('a')).resolves.toEqual({
            halted: false,
        });
    });

    it('does NOT halt an errored agent — this epic leaves that path alone', async () => {
        const repo = makeRepo(jest.fn().mockResolvedValue({ id: 'a', status: AgentStatus.ERROR }));
        await expect(new AgentBrakeService(repo).shouldHaltForAgent('a')).resolves.toEqual({
            halted: false,
        });
    });

    it('FAILS CLOSED when the agent cannot be read', async () => {
        const repo = makeRepo(jest.fn().mockRejectedValue(new Error('db down')));
        await expect(new AgentBrakeService(repo).shouldHaltForAgent('a')).resolves.toEqual({
            halted: true,
        });
    });

    it('does not halt for an agent that does not exist', async () => {
        // Refusing would turn a missing-agent bug into a permanent park
        // with no surface anywhere to unpause it.
        const repo = makeRepo(jest.fn().mockResolvedValue(null));
        await expect(new AgentBrakeService(repo).shouldHaltForAgent('gone')).resolves.toEqual({
            halted: false,
        });
    });
});

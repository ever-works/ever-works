import { TerminalSessionLauncher } from '../terminal-session-launcher.service';
import {
    TERMINAL_SESSION_COMMAND_DEFAULT,
    TERMINAL_SESSION_COMMAND_ENV,
    resolveTerminalSessionCommand,
} from '../terminal-session-dispatcher';
import type { AgentRunRepository } from '../../database/repositories/agent-run.repository';
import type { TerminalSessionDispatcher } from '../terminal-session-dispatcher';

const USER = 'user-1';
const AGENT = '11111111-2222-4333-8444-555555555555';
const RUN = '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';

function makeRun(over: Record<string, unknown> = {}) {
    return {
        id: RUN,
        userId: USER,
        agentId: AGENT,
        status: 'running',
        persistent: false,
        terminalState: null,
        workspaceMeta: null,
        ...over,
    };
}

describe('TerminalSessionLauncher', () => {
    let runs: {
        findByIdAndUser: jest.Mock;
        casClaimTerminalSession: jest.Mock;
        releaseTerminalSessionClaim: jest.Mock;
    };
    let dispatcher: { enqueue: jest.Mock };

    beforeEach(() => {
        runs = {
            findByIdAndUser: jest.fn().mockResolvedValue(makeRun()),
            casClaimTerminalSession: jest.fn().mockResolvedValue(true),
            releaseTerminalSessionClaim: jest.fn().mockResolvedValue(undefined),
        };
        dispatcher = { enqueue: jest.fn().mockResolvedValue({ jobRunId: 'job_run_1' }) };
    });

    function makeLauncher(withDispatcher = true) {
        return new TerminalSessionLauncher(
            runs as unknown as AgentRunRepository,
            withDispatcher ? (dispatcher as unknown as TerminalSessionDispatcher) : undefined,
        );
    }

    it('dispatches terminal-session with the payload the task contract expects', async () => {
        const outcome = await makeLauncher().startForRun({
            userId: USER,
            agentId: AGENT,
            runId: RUN,
            markPersistent: true,
        });

        expect(outcome).toEqual({ started: true, runId: RUN, jobRunId: 'job_run_1' });
        expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
        expect(dispatcher.enqueue).toHaveBeenCalledWith({
            runId: RUN,
            userId: USER,
            agentId: AGENT,
            command: [...TERMINAL_SESSION_COMMAND_DEFAULT],
            cwd: '.',
            persistent: true,
        });
    });

    it('claims the terminal slot (and flags the run persistent) BEFORE dispatching', async () => {
        const order: string[] = [];
        runs.casClaimTerminalSession.mockImplementation(async () => {
            order.push('claim');
            return true;
        });
        dispatcher.enqueue.mockImplementation(async () => {
            order.push('enqueue');
            return { jobRunId: 'job_run_1' };
        });

        await makeLauncher().startForRun({
            userId: USER,
            agentId: AGENT,
            runId: RUN,
            markPersistent: true,
        });

        expect(order).toEqual(['claim', 'enqueue']);
        expect(runs.casClaimTerminalSession).toHaveBeenCalledWith(RUN, { persistent: true });
    });

    it('refuses a duplicate start when a session is already resident on the run', async () => {
        runs.findByIdAndUser.mockResolvedValue(makeRun({ terminalState: 'attached' }));

        const outcome = await makeLauncher().startForRun({
            userId: USER,
            agentId: AGENT,
            runId: RUN,
            markPersistent: true,
        });

        expect(outcome).toEqual({ started: false, reason: 'session-already-live' });
        expect(runs.casClaimTerminalSession).not.toHaveBeenCalled();
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('refuses the racing duplicate that loses the CAS claim', async () => {
        // Both callers read `terminalState: null`; only one UPDATE lands.
        runs.casClaimTerminalSession.mockResolvedValueOnce(false);

        const outcome = await makeLauncher().startForRun({
            userId: USER,
            agentId: AGENT,
            runId: RUN,
            markPersistent: true,
        });

        expect(outcome).toEqual({ started: false, reason: 'session-already-live' });
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('does NOT spawn a session for a non-persistent run on the automatic path', async () => {
        runs.findByIdAndUser.mockResolvedValue(makeRun({ persistent: false }));

        const outcome = await makeLauncher().startForRun({
            userId: USER,
            agentId: AGENT,
            runId: RUN,
            requirePersistent: true,
        });

        expect(outcome).toEqual({ started: false, reason: 'not-persistent' });
        expect(runs.casClaimTerminalSession).not.toHaveBeenCalled();
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('DOES spawn a session for a persistent run on the automatic path', async () => {
        runs.findByIdAndUser.mockResolvedValue(makeRun({ persistent: true }));

        const outcome = await makeLauncher().startForRun({
            userId: USER,
            agentId: AGENT,
            runId: RUN,
            requirePersistent: true,
        });

        expect(outcome).toMatchObject({ started: true });
        expect(dispatcher.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ persistent: true }),
        );
        // The automatic path does not re-flag the run — it only honours a
        // flag that is already there.
        expect(runs.casClaimTerminalSession).toHaveBeenCalledWith(RUN, { persistent: undefined });
    });

    it('reports run-not-found (no existence leak) for a foreign or cross-agent run', async () => {
        runs.findByIdAndUser.mockResolvedValueOnce(null);
        await expect(
            makeLauncher().startForRun({ userId: USER, agentId: AGENT, runId: RUN }),
        ).resolves.toEqual({ started: false, reason: 'run-not-found' });

        runs.findByIdAndUser.mockResolvedValueOnce(makeRun({ agentId: 'another-agent' }));
        await expect(
            makeLauncher().startForRun({ userId: USER, agentId: AGENT, runId: RUN }),
        ).resolves.toEqual({ started: false, reason: 'run-not-found' });

        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('refuses to attach a shell to a run that has already finished', async () => {
        for (const status of ['completed', 'failed', 'cancelled']) {
            runs.findByIdAndUser.mockResolvedValueOnce(makeRun({ status }));
            await expect(
                makeLauncher().startForRun({ userId: USER, agentId: AGENT, runId: RUN }),
            ).resolves.toEqual({ started: false, reason: 'run-not-live' });
        }
        expect(runs.casClaimTerminalSession).not.toHaveBeenCalled();
    });

    it('reports dispatcher-unavailable (and claims nothing) with no job runtime bound', async () => {
        const outcome = await makeLauncher(false).startForRun({
            userId: USER,
            agentId: AGENT,
            runId: RUN,
        });

        expect(outcome).toEqual({ started: false, reason: 'dispatcher-unavailable' });
        expect(runs.casClaimTerminalSession).not.toHaveBeenCalled();
        expect(makeLauncher(false).isAvailable()).toBe(false);
        expect(makeLauncher().isAvailable()).toBe(true);
    });

    it('releases the claim (and rethrows) when the enqueue fails', async () => {
        dispatcher.enqueue.mockRejectedValueOnce(new Error('job runtime down'));

        await expect(
            makeLauncher().startForRun({ userId: USER, agentId: AGENT, runId: RUN }),
        ).rejects.toThrow('job runtime down');

        expect(runs.releaseTerminalSessionClaim).toHaveBeenCalledWith(RUN, 'crashed');
    });

    it('uses the run’s isolated worktree as cwd when it has one', async () => {
        runs.findByIdAndUser.mockResolvedValue(
            makeRun({
                workspaceMeta: {
                    provider: 'sandbox-workspace',
                    path: '/work/task-42',
                    baseSha: 'abc',
                    branchRef: 'refs/heads/task-42',
                    reused: false,
                },
            }),
        );

        await makeLauncher().startForRun({ userId: USER, agentId: AGENT, runId: RUN });

        expect(dispatcher.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ cwd: '/work/task-42' }),
        );
    });
});

describe('resolveTerminalSessionCommand', () => {
    const saved = process.env[TERMINAL_SESSION_COMMAND_ENV];
    afterEach(() => {
        if (saved === undefined) delete process.env[TERMINAL_SESSION_COMMAND_ENV];
        else process.env[TERMINAL_SESSION_COMMAND_ENV] = saved;
    });

    it('defaults to the Linux worker shell when unset or blank', () => {
        expect(resolveTerminalSessionCommand(undefined)).toEqual([
            ...TERMINAL_SESSION_COMMAND_DEFAULT,
        ]);
        expect(resolveTerminalSessionCommand('   ')).toEqual([...TERMINAL_SESSION_COMMAND_DEFAULT]);
    });

    it('accepts a JSON array or a whitespace-separated argv', () => {
        expect(resolveTerminalSessionCommand('["/usr/bin/zsh","-l"]')).toEqual([
            '/usr/bin/zsh',
            '-l',
        ]);
        expect(resolveTerminalSessionCommand('/bin/sh -i')).toEqual(['/bin/sh', '-i']);
    });

    it('falls back to the default for unparseable or empty configuration', () => {
        // A typo in an env var must not make the feature un-startable.
        expect(resolveTerminalSessionCommand('[not json')).toEqual([
            ...TERMINAL_SESSION_COMMAND_DEFAULT,
        ]);
        expect(resolveTerminalSessionCommand('[]')).toEqual([...TERMINAL_SESSION_COMMAND_DEFAULT]);
    });

    it('caps a pathological argv instead of forwarding a payload bomb', () => {
        const huge = Array.from({ length: 200 }, (_, i) => `arg${i}`).join(' ');
        expect(resolveTerminalSessionCommand(huge).length).toBe(32);
    });
});

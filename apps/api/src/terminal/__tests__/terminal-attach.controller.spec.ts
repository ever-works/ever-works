import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { TerminalAttachController } from '../terminal-attach.controller';
import { TerminalAttachService, resolveRequestedAttachRole } from '../terminal-attach.service';
import { TerminalRelayRegistry } from '../terminal-relay.registry';
import type { AgentsService, TerminalSessionLauncher } from '@ever-works/agent/agents';
import type { AgentRunRepository } from '@ever-works/agent/database';
import type { AuthenticatedUser } from '../../auth/types/auth.types';

const AGENT = '11111111-2222-4333-8444-555555555555';
const RUN = '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';
const AUTH = { userId: 'user-1' } as AuthenticatedUser;

describe('TerminalAttachController — run-scoped authorization', () => {
    const saved = process.env.TERMINAL_ATTACH_SECRET;
    let agents: { getOne: jest.Mock };
    let runs: { findByIdAndUser: jest.Mock };
    let controller: TerminalAttachController;

    beforeEach(() => {
        process.env.TERMINAL_ATTACH_SECRET = 'controller-spec-secret-value';
        agents = { getOne: jest.fn().mockResolvedValue({ id: AGENT }) };
        runs = {
            findByIdAndUser: jest.fn().mockResolvedValue({ id: RUN, agentId: AGENT }),
        };
        controller = new TerminalAttachController(
            agents as unknown as AgentsService,
            runs as unknown as AgentRunRepository,
            new TerminalAttachService(),
            new TerminalRelayRegistry(),
        );
    });

    afterEach(() => {
        if (saved === undefined) delete process.env.TERMINAL_ATTACH_SECRET;
        else process.env.TERMINAL_ATTACH_SECRET = saved;
    });

    it('mints a driver token for the run owner (mirrors GET runs/:runId authz)', async () => {
        const result = await controller.mintAttachToken(AUTH, AGENT, RUN);

        expect(agents.getOne).toHaveBeenCalledWith('user-1', AGENT);
        expect(runs.findByIdAndUser).toHaveBeenCalledWith(RUN, 'user-1');
        expect(result.role).toBe('driver');
        expect(result.wsPath).toBe(`/ws/terminal/${RUN}`);
        const claims = new TerminalAttachService().verify(result.token);
        expect(claims).toMatchObject({ userId: 'user-1', runId: RUN, role: 'driver' });
    });

    /**
     * The relay has always refused viewer input and the pane has always
     * rendered a read-only badge, but nothing ever MINTED a viewer token
     * — the role was decorative. These pin the mint side.
     */
    describe('viewer role', () => {
        it('mints a read-only viewer token when the caller asks for one', async () => {
            const result = await controller.mintAttachToken(AUTH, AGENT, RUN, 'viewer');

            expect(result.role).toBe('viewer');
            expect(new TerminalAttachService().verify(result.token)).toMatchObject({
                userId: 'user-1',
                runId: RUN,
                role: 'viewer',
            });
        });

        it('still runs the SAME run-ownership authorization for a viewer mint', async () => {
            runs.findByIdAndUser.mockResolvedValueOnce(null);
            await expect(
                controller.mintAttachToken(AUTH, AGENT, RUN, 'viewer'),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('clamps every other requested role to driver — a request can only downgrade', async () => {
            for (const requested of ['worker', 'admin', 'DRIVER', '', undefined]) {
                const result = await controller.mintAttachToken(AUTH, AGENT, RUN, requested);
                expect(result.role).toBe('driver');
            }
        });

        it('resolveRequestedAttachRole is case/whitespace tolerant but fail-closed', () => {
            expect(resolveRequestedAttachRole('viewer')).toBe('viewer');
            expect(resolveRequestedAttachRole('  VIEWER ')).toBe('viewer');
            expect(resolveRequestedAttachRole('worker')).toBe('driver');
            expect(resolveRequestedAttachRole(null)).toBe('driver');
            expect(resolveRequestedAttachRole(undefined)).toBe('driver');
        });
    });

    it('404s (no existence leak) when the run is cross-user or cross-agent', async () => {
        runs.findByIdAndUser.mockResolvedValueOnce(null);
        await expect(controller.mintAttachToken(AUTH, AGENT, RUN)).rejects.toBeInstanceOf(
            NotFoundException,
        );

        runs.findByIdAndUser.mockResolvedValueOnce({ id: RUN, agentId: 'another-agent' });
        await expect(controller.mintAttachToken(AUTH, AGENT, RUN)).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });

    it('status endpoint runs the SAME authorization before reading the registry', async () => {
        const status = await controller.status(AUTH, AGENT, RUN);
        expect(status.exists).toBe(false);

        runs.findByIdAndUser.mockResolvedValueOnce(null);
        await expect(controller.status(AUTH, AGENT, RUN)).rejects.toBeInstanceOf(NotFoundException);
    });

    /**
     * Now that `cliSessionId` actually gets written, the presence-only
     * exposure rule stops being theoretical: the resume key is a
     * credential-shaped handle and must never ride a status payload.
     */
    it('reports cliSessionId PRESENCE only — never the value', async () => {
        runs.findByIdAndUser.mockResolvedValue({
            id: RUN,
            agentId: AGENT,
            cliSessionId: 'pty-local:secret-session:4242',
        });

        const status = await controller.status(AUTH, AGENT, RUN);

        expect(status.run.hasCliSession).toBe(true);
        expect(JSON.stringify(status)).not.toContain('secret-session');
        expect(JSON.stringify(status)).not.toContain('cliSessionId');

        runs.findByIdAndUser.mockResolvedValue({ id: RUN, agentId: AGENT, cliSessionId: null });
        expect((await controller.status(AUTH, AGENT, RUN)).run.hasCliSession).toBe(false);
    });

    /**
     * `POST …/terminal/start` is the user action that finally produces a
     * `terminal-session` job — before it, the whole terminal stack pointed at
     * a session nothing ever launched.
     */
    describe('POST start', () => {
        let launcher: { startForRun: jest.Mock };

        function makeController(withLauncher = true) {
            return new TerminalAttachController(
                agents as unknown as AgentsService,
                runs as unknown as AgentRunRepository,
                new TerminalAttachService(),
                new TerminalRelayRegistry(),
                withLauncher ? (launcher as unknown as TerminalSessionLauncher) : undefined,
            );
        }

        beforeEach(() => {
            launcher = {
                startForRun: jest
                    .fn()
                    .mockResolvedValue({ started: true, runId: RUN, jobRunId: 'job_1' }),
            };
        });

        it('starts a session for the run owner and flags the run persistent', async () => {
            const result = await makeController().start(AUTH, AGENT, RUN);

            expect(agents.getOne).toHaveBeenCalledWith('user-1', AGENT);
            expect(launcher.startForRun).toHaveBeenCalledWith({
                userId: 'user-1',
                agentId: AGENT,
                runId: RUN,
                markPersistent: true,
            });
            expect(result).toEqual({ started: true, runId: RUN, state: 'starting' });
        });

        it('404s (no existence leak) before the launcher is ever consulted', async () => {
            runs.findByIdAndUser.mockResolvedValueOnce(null);
            await expect(makeController().start(AUTH, AGENT, RUN)).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(launcher.startForRun).not.toHaveBeenCalled();
        });

        it('409s when a session is already live for the run', async () => {
            launcher.startForRun.mockResolvedValueOnce({
                started: false,
                reason: 'session-already-live',
            });
            await expect(makeController().start(AUTH, AGENT, RUN)).rejects.toBeInstanceOf(
                ConflictException,
            );
        });

        it('409s when the run has already finished', async () => {
            launcher.startForRun.mockResolvedValueOnce({ started: false, reason: 'run-not-live' });
            await expect(makeController().start(AUTH, AGENT, RUN)).rejects.toBeInstanceOf(
                ConflictException,
            );
        });

        it('503s (not 500) when no job runtime is wired on this install', async () => {
            await expect(makeController(false).start(AUTH, AGENT, RUN)).rejects.toBeInstanceOf(
                ServiceUnavailableException,
            );

            launcher.startForRun.mockResolvedValueOnce({
                started: false,
                reason: 'dispatcher-unavailable',
            });
            await expect(makeController().start(AUTH, AGENT, RUN)).rejects.toBeInstanceOf(
                ServiceUnavailableException,
            );
        });
    });
});

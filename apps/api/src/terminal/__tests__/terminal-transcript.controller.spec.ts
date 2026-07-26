// Stub the auth barrel so its transitive `@ever-works/agent/database`
// import is not pulled into this controller test (same pattern as the
// sibling internal-controller spec).
jest.mock('../../auth', () => ({
    Public: () => () => undefined,
}));

import { NotFoundException } from '@nestjs/common';
import { TerminalAttachController } from '../terminal-attach.controller';
import { TerminalAttachService } from '../terminal-attach.service';
import { TerminalInternalController } from '../terminal-internal.controller';
import { TerminalRelayRegistry } from '../terminal-relay.registry';
import type { AgentsService, TerminalSessionLauncher } from '@ever-works/agent/agents';
import type { AgentRunRepository } from '@ever-works/agent/database';
import type { AuthenticatedUser } from '../../auth/types/auth.types';

const AGENT = '11111111-2222-4333-8444-555555555555';
const RUN = '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';
const AUTH = { userId: 'user-1' } as AuthenticatedUser;

const emptyPage = {
    runId: RUN,
    chunks: [] as Array<{ seq: number; direction: 'out'; text: string; createdAt: string }>,
    lastSeq: null as number | null,
    hasMore: false,
    total: 0,
};

/**
 * Streaming-terminal M9 / founder decision D1 — the two ends of the
 * transcript feature at the HTTP boundary:
 *
 *   - the internal publish endpoint persists what the relay accepted,
 *     best-effort, without ever failing the session;
 *   - the owner-scoped replay endpoint serves it back, paginated.
 */
describe('Terminal transcripts — HTTP surface (M9)', () => {
    describe('GET …/terminal/transcript (replay)', () => {
        const saved = process.env.TERMINAL_ATTACH_SECRET;
        let agents: { getOne: jest.Mock };
        let runs: { findByIdAndUser: jest.Mock };
        let transcripts: { getTranscriptPage: jest.Mock };
        let controller: TerminalAttachController;

        beforeEach(() => {
            process.env.TERMINAL_ATTACH_SECRET = 'controller-spec-secret-value';
            agents = { getOne: jest.fn().mockResolvedValue({ id: AGENT }) };
            runs = { findByIdAndUser: jest.fn().mockResolvedValue({ id: RUN, agentId: AGENT }) };
            transcripts = { getTranscriptPage: jest.fn().mockResolvedValue(emptyPage) };
            controller = new TerminalAttachController(
                agents as unknown as AgentsService,
                runs as unknown as AgentRunRepository,
                new TerminalAttachService(),
                new TerminalRelayRegistry(),
                undefined as unknown as TerminalSessionLauncher,
                transcripts as never,
            );
        });

        afterEach(() => {
            if (saved === undefined) delete process.env.TERMINAL_ATTACH_SECRET;
            else process.env.TERMINAL_ATTACH_SECRET = saved;
        });

        it('runs the SAME owner-scoped authorization as every other run route', async () => {
            await controller.transcript(AUTH, AGENT, RUN);

            expect(agents.getOne).toHaveBeenCalledWith('user-1', AGENT);
            expect(runs.findByIdAndUser).toHaveBeenCalledWith(RUN, 'user-1');
        });

        it('404s with no existence leak for a cross-user or cross-agent run', async () => {
            runs.findByIdAndUser.mockResolvedValueOnce(null);
            await expect(controller.transcript(AUTH, AGENT, RUN)).rejects.toBeInstanceOf(
                NotFoundException,
            );

            runs.findByIdAndUser.mockResolvedValueOnce({ id: RUN, agentId: 'another-agent' });
            await expect(controller.transcript(AUTH, AGENT, RUN)).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('never reads the transcript store before authorization passes', async () => {
            runs.findByIdAndUser.mockResolvedValueOnce(null);
            await expect(controller.transcript(AUTH, AGENT, RUN)).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(transcripts.getTranscriptPage).not.toHaveBeenCalled();
        });

        it('forwards fromSeq + limit as parsed integers', async () => {
            await controller.transcript(AUTH, AGENT, RUN, '120', '50');

            expect(transcripts.getTranscriptPage).toHaveBeenCalledWith(RUN, {
                fromSeq: 120,
                limit: 50,
            });
        });

        it('drops garbage / negative query params so the service applies its own caps', async () => {
            await controller.transcript(AUTH, AGENT, RUN, 'abc', '-3');

            expect(transcripts.getTranscriptPage).toHaveBeenCalledWith(RUN, {
                fromSeq: undefined,
                limit: undefined,
            });
        });

        it('returns an empty page (never 500) on an install with no transcript module', async () => {
            const bare = new TerminalAttachController(
                agents as unknown as AgentsService,
                runs as unknown as AgentRunRepository,
                new TerminalAttachService(),
                new TerminalRelayRegistry(),
            );

            await expect(bare.transcript(AUTH, AGENT, RUN)).resolves.toEqual({
                runId: RUN,
                chunks: [],
                lastSeq: null,
                hasMore: false,
                total: 0,
            });
        });
    });

    describe('POST /api/internal/terminal/:runId/frames (persistence)', () => {
        const ENV_KEYS = ['TRIGGER_INTERNAL_SECRET', 'TERMINAL_ATTACH_SECRET'] as const;
        const savedEnv: Record<string, string | undefined> = {};
        const bearer = 'Bearer internal-secret-value';
        let registry: TerminalRelayRegistry;
        let transcripts: { persistFrames: jest.Mock };
        let controller: TerminalInternalController;

        beforeEach(() => {
            for (const k of ENV_KEYS) {
                savedEnv[k] = process.env[k];
                delete process.env[k];
            }
            process.env.TRIGGER_INTERNAL_SECRET = 'internal-secret-value';
            process.env.TERMINAL_ATTACH_SECRET = 'terminal-attach-secret-value';
            registry = new TerminalRelayRegistry();
            transcripts = { persistFrames: jest.fn().mockResolvedValue(1) };
            controller = new TerminalInternalController(
                registry,
                new TerminalAttachService(),
                { updateTerminalColumns: jest.fn() } as never,
                transcripts as never,
            );
        });

        afterEach(() => {
            for (const k of ENV_KEYS) {
                if (savedEnv[k] === undefined) delete process.env[k];
                else process.env[k] = savedEnv[k];
            }
        });

        it('persists exactly the frames the relay ACCEPTED', async () => {
            const result = controller.publishFrames(bearer, undefined, RUN, [
                { kind: 'stdout', seq: 0, data: 'aGk=' },
                { kind: 'stdout', seq: 1, data: 'aGk=' },
                { kind: 'stdout', seq: 1, data: 'aGk=' }, // dup seq → relay refuses
                { nonsense: true }, // shape-invalid → dropped
            ]);

            expect(result).toEqual({ accepted: 2, dropped: 2 });
            await Promise.resolve();
            expect(transcripts.persistFrames).toHaveBeenCalledTimes(1);
            const [runId, frames] = transcripts.persistFrames.mock.calls[0];
            expect(runId).toBe(RUN);
            expect(frames.map((f: { seq: number }) => f.seq)).toEqual([0, 1]);
        });

        it('does not call the store when every frame was rejected', () => {
            controller.publishFrames(bearer, undefined, RUN, [{ nonsense: true }]);
            expect(transcripts.persistFrames).not.toHaveBeenCalled();
        });

        it('a store failure NEVER fails the publish (best-effort by contract)', () => {
            transcripts.persistFrames.mockRejectedValue(new Error('db down'));

            expect(() =>
                controller.publishFrames(bearer, undefined, RUN, [
                    { kind: 'stdout', seq: 0, data: 'aGk=' },
                ]),
            ).not.toThrow();
        });

        it('a store that throws SYNCHRONOUSLY also never fails the publish', () => {
            transcripts.persistFrames.mockImplementation(() => {
                throw new Error('boom');
            });

            expect(() =>
                controller.publishFrames(bearer, undefined, RUN, [
                    { kind: 'stdout', seq: 0, data: 'aGk=' },
                ]),
            ).not.toThrow();
        });

        it('relays normally when no transcript store is wired (M9 is additive to M3)', () => {
            const bare = new TerminalInternalController(
                new TerminalRelayRegistry(),
                new TerminalAttachService(),
                { updateTerminalColumns: jest.fn() } as never,
            );

            expect(
                bare.publishFrames(bearer, undefined, RUN, [
                    { kind: 'stdout', seq: 0, data: 'aGk=' },
                ]),
            ).toEqual({ accepted: 1, dropped: 0 });
        });
    });
});

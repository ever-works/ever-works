// Stub the auth barrel so its transitive `@ever-works/agent/database`
// import is not pulled into this controller test (same pattern as the
// health controller spec).
jest.mock('../../auth', () => ({
    Public: () => () => undefined,
}));

import { ForbiddenException } from '@nestjs/common';
import { TerminalInternalController } from '../terminal-internal.controller';
import { TerminalRelayRegistry } from '../terminal-relay.registry';
import { TerminalAttachService } from '../terminal-attach.service';

const RUN = '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';
const ENV_KEYS = ['TRIGGER_INTERNAL_SECRET', 'TERMINAL_ATTACH_SECRET'] as const;

describe('TerminalInternalController', () => {
    const saved: Record<string, string | undefined> = {};
    let controller: TerminalInternalController;
    let registry: TerminalRelayRegistry;
    let runsRepo: { updateTerminalColumns: jest.Mock };

    beforeEach(() => {
        for (const k of ENV_KEYS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
        registry = new TerminalRelayRegistry();
        runsRepo = { updateTerminalColumns: jest.fn().mockResolvedValue(undefined) };
        controller = new TerminalInternalController(
            registry,
            new TerminalAttachService(),
            runsRepo as never,
        );
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    function configure() {
        process.env.TRIGGER_INTERNAL_SECRET = 'internal-secret-value';
        process.env.TERMINAL_ATTACH_SECRET = 'terminal-attach-secret-value';
    }

    const bearer = 'Bearer internal-secret-value';

    it('FAIL-CLOSED: refuses every publish when the internal secret is unconfigured', () => {
        expect(() =>
            controller.publishFrames(bearer, undefined, RUN, [
                { kind: 'stdout', seq: 0, data: 'aGk=' },
            ]),
        ).toThrow(ForbiddenException);
    });

    it('refuses wrong/missing bearer secrets (constant-time compare path)', () => {
        configure();
        expect(() => controller.publishFrames('Bearer wrong', undefined, RUN, [])).toThrow(
            ForbiddenException,
        );
        expect(() => controller.publishFrames(undefined, undefined, RUN, [])).toThrow(
            ForbiddenException,
        );
        expect(() => controller.publishFrames('Basic abc', undefined, RUN, [])).toThrow(
            ForbiddenException,
        );
    });

    it('accepts valid frames, drops invalid ones, and counts both', () => {
        configure();
        const result = controller.publishFrames(bearer, undefined, RUN, [
            { kind: 'stdout', seq: 0, data: 'aGk=' },
            { kind: 'stdout', seq: 1, data: 'aGk=' },
            { kind: 'stdout', seq: 1, data: 'aGk=' }, // dup seq → registry refuses
            { kind: 'stdin', data: 'aGk=' }, // client-direction → refused
            { nonsense: true }, // shape-invalid → dropped
        ]);
        expect(result).toEqual({ accepted: 2, dropped: 3 });
        expect(registry.getStatus(RUN).lastSeq).toBe(1);
    });

    it('rejects malformed run ids before any registry touch', () => {
        configure();
        expect(() => controller.publishFrames(bearer, undefined, '../etc/passwd', [])).toThrow(
            ForbiddenException,
        );
    });

    it('mints a worker attach token behind the same gate', () => {
        configure();
        const result = controller.mintWorkerToken(bearer, undefined, RUN);
        expect(result.wsPath).toBe(`/ws/terminal/${RUN}`);
        const claims = new TerminalAttachService().verify(result.token);
        expect(claims).toMatchObject({ role: 'worker', runId: RUN });

        expect(() => controller.mintWorkerToken('Bearer wrong', undefined, RUN)).toThrow(
            ForbiddenException,
        );
    });
    it('heartbeat stamps the server clock and whitelists lifecycle fields', async () => {
        configure();
        await controller.heartbeat(bearer, undefined, RUN, {
            state: 'attached',
            providerId: 'pty-local',
            persistent: true,
            lastFrameSeq: 42,
            endedReason: 'not-a-reason',
        });
        expect(runsRepo.updateTerminalColumns).toHaveBeenCalledWith(
            RUN,
            expect.objectContaining({
                terminalState: 'attached',
                terminalProviderId: 'pty-local',
                persistent: true,
                lastFrameSeq: 42,
                lastHeartbeatAt: expect.any(Date),
            }),
        );
        // Unknown endedReason value was dropped by the enum whitelist.
        const patch = runsRepo.updateTerminalColumns.mock.calls[0][1];
        expect('terminalEndedReason' in patch).toBe(false);
    });

    /**
     * `cliSessionId` is the run's resume key. The session host now sends
     * it on the attached beat (it had no writer before), so this pins
     * the persistence half of that contract — plus the cap that keeps a
     * hostile worker from stuffing the column.
     */
    it('heartbeat persists the session-host cliSessionId, capped at 128 chars', async () => {
        configure();
        await controller.heartbeat(bearer, undefined, RUN, {
            state: 'attached',
            cliSessionId: 'pty-local:run-1:4242',
        });
        expect(runsRepo.updateTerminalColumns).toHaveBeenCalledWith(
            RUN,
            expect.objectContaining({ cliSessionId: 'pty-local:run-1:4242' }),
        );

        runsRepo.updateTerminalColumns.mockClear();
        await controller.heartbeat(bearer, undefined, RUN, {
            state: 'attached',
            cliSessionId: 'x'.repeat(129),
        });
        expect('cliSessionId' in runsRepo.updateTerminalColumns.mock.calls[0][1]).toBe(false);
    });

    it('heartbeat also honors the x-trigger-secret header (house internal-API convention)', async () => {
        configure();
        await controller.heartbeat(undefined, 'internal-secret-value', RUN, {
            state: 'ended',
            endedReason: 'parked',
        });
        expect(runsRepo.updateTerminalColumns).toHaveBeenCalledWith(
            RUN,
            expect.objectContaining({ terminalState: 'ended', terminalEndedReason: 'parked' }),
        );
    });
});

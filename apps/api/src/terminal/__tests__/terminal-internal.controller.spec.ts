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

    beforeEach(() => {
        for (const k of ENV_KEYS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
        registry = new TerminalRelayRegistry();
        controller = new TerminalInternalController(registry, new TerminalAttachService());
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
            controller.publishFrames(bearer, RUN, [{ kind: 'stdout', seq: 0, data: 'aGk=' }]),
        ).toThrow(ForbiddenException);
    });

    it('refuses wrong/missing bearer secrets (constant-time compare path)', () => {
        configure();
        expect(() => controller.publishFrames('Bearer wrong', RUN, [])).toThrow(ForbiddenException);
        expect(() => controller.publishFrames(undefined, RUN, [])).toThrow(ForbiddenException);
        expect(() => controller.publishFrames('Basic abc', RUN, [])).toThrow(ForbiddenException);
    });

    it('accepts valid frames, drops invalid ones, and counts both', () => {
        configure();
        const result = controller.publishFrames(bearer, RUN, [
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
        expect(() => controller.publishFrames(bearer, '../etc/passwd', [])).toThrow(
            ForbiddenException,
        );
    });

    it('mints a worker attach token behind the same gate', () => {
        configure();
        const result = controller.mintWorkerToken(bearer, RUN);
        expect(result.wsPath).toBe(`/ws/terminal/${RUN}`);
        const claims = new TerminalAttachService().verify(result.token);
        expect(claims).toMatchObject({ role: 'worker', runId: RUN });

        expect(() => controller.mintWorkerToken('Bearer wrong', RUN)).toThrow(ForbiddenException);
    });
});

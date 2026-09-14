import { ServiceUnavailableException } from '@nestjs/common';
import { TerminalAttachService } from '../terminal-attach.service';

const RUN = '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';
const ENV_KEYS = ['TERMINAL_ATTACH_SECRET', 'BETTER_AUTH_SECRET', 'AUTH_SECRET'] as const;

describe('TerminalAttachService', () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const k of ENV_KEYS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    function withSecret() {
        process.env.TERMINAL_ATTACH_SECRET = 'a-very-strong-terminal-secret';
        return new TerminalAttachService();
    }

    it('mints and verifies a round-trip token with the claims intact', () => {
        const svc = withSecret();
        const { token, expiresInSec } = svc.mint({ userId: 'u1', runId: RUN, role: 'driver' });
        expect(expiresInSec).toBe(60);

        const claims = svc.verify(token);
        expect(claims).toMatchObject({ userId: 'u1', runId: RUN, role: 'driver' });
        expect(claims!.exp).toBeGreaterThan(Date.now());
    });

    it('FAIL-CLOSED: minting without any secret throws 503; verification refuses everything', () => {
        const svc = new TerminalAttachService();
        expect(() => svc.mint({ userId: 'u1', runId: RUN, role: 'driver' })).toThrow(
            ServiceUnavailableException,
        );
        expect(svc.verify('anything.at-all')).toBeNull();
    });

    it('falls back to the Better Auth secret so local installs work out of the box', () => {
        process.env.BETTER_AUTH_SECRET = 'better-auth-secret-value-123';
        const svc = new TerminalAttachService();
        const { token } = svc.mint({ userId: 'u1', runId: RUN, role: 'viewer' });
        expect(svc.verify(token)).toMatchObject({ role: 'viewer' });
    });

    it('rejects tampered payloads and MACs (constant-time), null-never-throw', () => {
        const svc = withSecret();
        const { token } = svc.mint({ userId: 'u1', runId: RUN, role: 'driver' });
        const [body, mac] = token.split('.');

        // Flip the role inside the payload — MAC no longer matches.
        const forged = Buffer.from(
            JSON.stringify({ userId: 'u1', runId: RUN, role: 'worker', exp: Date.now() + 60000 }),
        ).toString('base64url');
        expect(svc.verify(`${forged}.${mac}`)).toBeNull();

        // Corrupt the MAC.
        expect(svc.verify(`${body}.${mac.slice(0, -2)}xx`)).toBeNull();

        // Garbage shapes never throw.
        expect(svc.verify('')).toBeNull();
        expect(svc.verify('no-dot')).toBeNull();
        expect(svc.verify('.only-mac')).toBeNull();
        expect(svc.verify('x'.repeat(5000))).toBeNull();
    });

    it('rejects expired tokens', () => {
        const svc = withSecret();
        const { token } = svc.mint({ userId: 'u1', runId: RUN, role: 'driver' });
        const [body] = token.split('.');
        const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        // Re-sign an already-expired copy using the service itself is not
        // possible (mint always uses now+TTL), so simulate time passing.
        const realNow = Date.now;
        try {
            Date.now = () => claims.exp + 1;
            expect(svc.verify(token)).toBeNull();
        } finally {
            Date.now = realNow;
        }
    });

    it('a different secret cannot verify tokens (no cross-install replay)', () => {
        const svc = withSecret();
        const { token } = svc.mint({ userId: 'u1', runId: RUN, role: 'driver' });
        process.env.TERMINAL_ATTACH_SECRET = 'a-completely-different-secret!';
        const other = new TerminalAttachService();
        expect(other.verify(token)).toBeNull();
    });

    /**
     * Agent computers ride this signer with a `computer` channel claim. A
     * terminal token must stay exactly what it was (no claim at all), and a
     * claim this service does not know must never verify.
     */
    describe('channel claim', () => {
        const decode = (token: string) =>
            JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));

        it('writes no channel claim on a terminal token', () => {
            const svc = withSecret();
            const { token } = svc.mint({ userId: 'u1', runId: RUN, role: 'driver' });
            expect(Object.keys(decode(token)).sort()).toEqual(['exp', 'role', 'runId', 'userId']);
            expect(svc.verify(token)?.channel).toBeUndefined();
        });

        it('round-trips the computer channel claim', () => {
            const svc = withSecret();
            const { token } = svc.mint({
                userId: 'u1',
                runId: RUN,
                role: 'viewer',
                channel: 'computer',
            });
            expect(svc.verify(token)).toMatchObject({
                runId: RUN,
                role: 'viewer',
                channel: 'computer',
            });
        });

        it('refuses a correctly signed token carrying an unknown channel', () => {
            const svc = withSecret();
            const { createHmac } = jest.requireActual('crypto') as typeof import('crypto');
            const body = Buffer.from(
                JSON.stringify({
                    userId: 'u1',
                    runId: RUN,
                    role: 'viewer',
                    channel: 'desktop',
                    exp: Date.now() + 60_000,
                }),
            ).toString('base64url');
            const mac = createHmac('sha256', 'a-very-strong-terminal-secret')
                .update(body)
                .digest('base64url');
            expect(svc.verify(`${body}.${mac}`)).toBeNull();
        });
    });
});

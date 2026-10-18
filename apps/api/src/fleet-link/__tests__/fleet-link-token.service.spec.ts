import { TerminalAttachService } from '../../terminal/terminal-attach.service';
import { ComputerAttachService } from '../../computer/computer-attach.service';
import { FleetLinkTokenService, InProcessFleetLinkReplayGuard } from '../fleet-link-token.service';
import { NODE_ID } from './link-test-kit';

/**
 * Link tokens (FL-02, spec FR-3, FR-5, ACC-FL02-02): five minutes, single
 * use, bound to one node, on the terminal's signer with their own channel
 * claim — so a link token opens nothing else, and nothing else opens a link.
 */

const ORIGINAL_SECRET = process.env.TERMINAL_ATTACH_SECRET;
const OTHER_NODE = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
    process.env.TERMINAL_ATTACH_SECRET = 'a-test-secret-of-sufficient-length';
});

afterEach(() => {
    jest.useRealTimers();
    if (ORIGINAL_SECRET === undefined) delete process.env.TERMINAL_ATTACH_SECRET;
    else process.env.TERMINAL_ATTACH_SECRET = ORIGINAL_SECRET;
});

describe('FleetLinkTokenService', () => {
    const signer = () => new TerminalAttachService();

    it('mints a five-minute token for the link path', () => {
        const grant = new FleetLinkTokenService(signer()).mint(NODE_ID);
        expect(grant).toMatchObject({ wsPath: '/ws/fleet/link', expiresInSec: 300 });
        expect(grant.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    });

    it('accepts a token once and refuses the replay (single use)', async () => {
        const tokens = new FleetLinkTokenService(signer());
        const { token } = tokens.mint(NODE_ID);
        await expect(tokens.consume(token, NODE_ID)).resolves.toBe(true);
        await expect(tokens.consume(token, NODE_ID)).resolves.toBe(false);
    });

    it('refuses a token minted for another node', async () => {
        const tokens = new FleetLinkTokenService(signer());
        const { token } = tokens.mint(OTHER_NODE);
        await expect(tokens.consume(token, NODE_ID)).resolves.toBe(false);
    });

    it('refuses an expired token', async () => {
        jest.useFakeTimers({ now: 1_760_000_000_000 });
        const tokens = new FleetLinkTokenService(signer());
        const { token } = tokens.mint(NODE_ID);
        jest.setSystemTime(1_760_000_000_000 + 300_001);
        await expect(tokens.consume(token, NODE_ID)).resolves.toBe(false);
    });

    it('refuses a live-view token and a terminal token; a link token opens neither of theirs', async () => {
        const terminal = signer();
        const tokens = new FleetLinkTokenService(terminal);
        const computer = new ComputerAttachService(terminal);
        const viewToken = computer.mint({ userId: 'u', sessionId: NODE_ID, role: 'worker' }).token;
        const terminalToken = terminal.mint({
            userId: `node:${NODE_ID}`,
            runId: NODE_ID,
            role: 'worker',
        }).token;
        await expect(tokens.consume(viewToken, NODE_ID)).resolves.toBe(false);
        await expect(tokens.consume(terminalToken, NODE_ID)).resolves.toBe(false);

        const link = tokens.mint(NODE_ID).token;
        expect(computer.verify(link)).toBeNull();
        // The terminal gateway refuses any token carrying a channel claim.
        expect(terminal.verify(link)?.channel).toBe('fleet-link');
    });

    it('refuses garbage and fails closed when the guard cannot answer', async () => {
        const tokens = new FleetLinkTokenService(signer(), {
            claim: () => {
                throw new Error('bus down');
            },
        });
        await expect(tokens.consume('not.a-token', NODE_ID)).resolves.toBe(false);
        await expect(tokens.consume(tokens.mint(NODE_ID).token, NODE_ID)).resolves.toBe(false);
    });

    it('refuses to mint without an attach secret (fail-closed)', () => {
        delete process.env.TERMINAL_ATTACH_SECRET;
        const original = { better: process.env.BETTER_AUTH_SECRET, auth: process.env.AUTH_SECRET };
        delete process.env.BETTER_AUTH_SECRET;
        delete process.env.AUTH_SECRET;
        try {
            expect(() => new FleetLinkTokenService(signer()).mint(NODE_ID)).toThrow();
        } finally {
            if (original.better !== undefined) process.env.BETTER_AUTH_SECRET = original.better;
            if (original.auth !== undefined) process.env.AUTH_SECRET = original.auth;
        }
    });
});

describe('InProcessFleetLinkReplayGuard', () => {
    it('admits an id once within its lifetime and again after it expired', () => {
        let now = 0;
        const guard = new InProcessFleetLinkReplayGuard(() => now);
        expect(guard.claim('jti-1', 1_000)).toBe(true);
        expect(guard.claim('jti-1', 1_000)).toBe(false);
        now = 1_001;
        expect(guard.claim('jti-1', 1_000)).toBe(true);
    });
});

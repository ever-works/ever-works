import { TerminalAttachService } from '../../terminal/terminal-attach.service';
import { ComputerAttachService } from '../../computer/computer-attach.service';
import {
    CacheEntryFleetLinkReplayGuard,
    FleetLinkTokenService,
    InProcessFleetLinkReplayGuard,
    fleetLinkCredentialGeneration,
} from '../fleet-link-token.service';
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

/**
 * Works-security (run-token scope, 2026-10-18) — finding 6.
 *
 *   - A link token is bound to the credential generation it was minted under:
 *     a rotation between mint and hello refuses it (it used to stay valid for
 *     the rest of its five minutes).
 *   - "Single use" holds across API replicas: the replay guard is the shared
 *     `cache_entries` table, not a per-process map (`FLEET_LINK_REPLAY_GUARD`
 *     was never bound, so every replica accepted the same token once).
 */
describe('FleetLinkTokenService — credential generation', () => {
    const signer = () => new TerminalAttachService();

    function nodesWith(hash: string | null) {
        const state = { hash };
        const nodes = {
            findById: jest.fn(async (id: string) =>
                id === NODE_ID ? { id, enrollmentTokenHash: state.hash } : null,
            ),
        };
        return { state, nodes };
    }

    it('accepts a token minted for the current credential, once', async () => {
        const { nodes } = nodesWith('hash-1');
        const tokens = new FleetLinkTokenService(signer(), undefined, nodes as never);
        const { token } = await tokens.mintForNode(NODE_ID);
        await expect(tokens.consume(token, NODE_ID)).resolves.toBe(true);
        await expect(tokens.consume(token, NODE_ID)).resolves.toBe(false);
    });

    it('refuses a token minted before a credential rotation', async () => {
        const { state, nodes } = nodesWith('hash-1');
        const tokens = new FleetLinkTokenService(signer(), undefined, nodes as never);
        const { token } = await tokens.mintForNode(NODE_ID);
        state.hash = 'hash-2'; // self-rotation or the owner's rotate replaced it
        await expect(tokens.consume(token, NODE_ID)).resolves.toBe(false);
        // A token minted after the rotation works.
        await expect(
            tokens.consume((await tokens.mintForNode(NODE_ID)).token, NODE_ID),
        ).resolves.toBe(true);
    });

    it('refuses a token that names no generation, and one for a node that is gone', async () => {
        const { state, nodes } = nodesWith('hash-1');
        const tokens = new FleetLinkTokenService(signer(), undefined, nodes as never);
        await expect(tokens.consume(tokens.mint(NODE_ID).token, NODE_ID)).resolves.toBe(false);
        const { token } = await tokens.mintForNode(NODE_ID);
        nodes.findById.mockResolvedValueOnce(null as never);
        await expect(tokens.consume(token, NODE_ID)).resolves.toBe(false);
        expect(state.hash).toBe('hash-1');
    });

    it('carries only a fingerprint of the credential hash, never the hash itself', async () => {
        const { nodes } = nodesWith('very-distinctive-credential-hash');
        const terminal = signer();
        const tokens = new FleetLinkTokenService(terminal, undefined, nodes as never);
        const { token } = await tokens.mintForNode(NODE_ID);
        const claims = terminal.verify(token);
        expect(claims?.cred).toBe(
            fleetLinkCredentialGeneration('very-distinctive-credential-hash'),
        );
        expect(token).not.toContain('very-distinctive');
        expect(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).not.toContain(
            'very-distinctive',
        );
    });
});

describe('CacheEntryFleetLinkReplayGuard — one store for every replica', () => {
    /** A `cache_entries` double: PK-keyed rows, a duplicate insert is `23505`. */
    function sharedTable() {
        const rows = new Map<string, { key: string; value: string; expiresAt: number }>();
        const repo = {
            rows,
            insert: jest.fn(async (row: { key: string; value: string; expiresAt: number }) => {
                if (rows.has(row.key)) {
                    throw Object.assign(
                        new Error('duplicate key value violates unique constraint'),
                        {
                            code: '23505',
                        },
                    );
                }
                rows.set(row.key, row);
            }),
            createQueryBuilder: jest.fn(() => {
                const filter: { key?: string; now?: number } = {};
                const qb = {
                    delete: () => qb,
                    where: (_sql: string, params: { key: string }) => {
                        filter.key = params.key;
                        return qb;
                    },
                    andWhere: (_sql: string, params: { now: number }) => {
                        filter.now = params.now;
                        return qb;
                    },
                    execute: async () => {
                        const row = filter.key ? rows.get(filter.key) : undefined;
                        if (row && filter.now !== undefined && row.expiresAt < filter.now) {
                            rows.delete(row.key);
                        }
                        return { affected: 0 };
                    },
                };
                return qb;
            }),
        };
        return repo;
    }

    it('refuses on replica B a token id already claimed on replica A', async () => {
        const table = sharedTable();
        const replicaA = new CacheEntryFleetLinkReplayGuard(table as never, () => 1_000);
        const replicaB = new CacheEntryFleetLinkReplayGuard(table as never, () => 1_001);
        await expect(replicaA.claim('jti-1', 300_000)).resolves.toBe(true);
        await expect(replicaB.claim('jti-1', 300_000)).resolves.toBe(false);
        expect(table.rows.get('fleet-link-jti:jti-1')?.expiresAt).toBe(301_000);
    });

    it('two services on two replicas accept one token exactly once between them', async () => {
        const table = sharedTable();
        const terminal = new TerminalAttachService();
        const a = new FleetLinkTokenService(
            terminal,
            new CacheEntryFleetLinkReplayGuard(table as never),
        );
        const b = new FleetLinkTokenService(
            terminal,
            new CacheEntryFleetLinkReplayGuard(table as never),
        );
        const { token } = a.mint(NODE_ID);
        await expect(a.consume(token, NODE_ID)).resolves.toBe(true);
        await expect(b.consume(token, NODE_ID)).resolves.toBe(false);
    });

    it('sweeps an expired claim, so the key space stays bounded', async () => {
        const table = sharedTable();
        let now = 0;
        const guard = new CacheEntryFleetLinkReplayGuard(table as never, () => now);
        await expect(guard.claim('jti-1', 1_000)).resolves.toBe(true);
        now = 1_001;
        await expect(guard.claim('jti-1', 1_000)).resolves.toBe(true);
    });

    it('rethrows a store failure that is not a duplicate (consume then refuses)', async () => {
        const table = sharedTable();
        table.insert.mockRejectedValueOnce(new Error('connection reset') as never);
        const guard = new CacheEntryFleetLinkReplayGuard(table as never);
        await expect(guard.claim('jti-x', 1_000)).rejects.toThrow('connection reset');

        table.insert.mockRejectedValueOnce(new Error('connection reset') as never);
        const tokens = new FleetLinkTokenService(new TerminalAttachService(), guard);
        await expect(tokens.consume(tokens.mint(NODE_ID).token, NODE_ID)).resolves.toBe(false);
    });
});

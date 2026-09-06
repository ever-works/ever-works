import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FLEET_DEFAULT_ENROLLMENT_TOKEN_TTL_MS } from '@ever-works/contracts';
import { FleetNode } from '../../entities/fleet-node.entity';
import { FleetService } from '../fleet.service';

/**
 * ONE source for the enrollment-token TTL (EW-799, defect 3).
 *
 * The TTL is an operator knob (`FLEET_ENROLLMENT_TOKEN_TTL_MS`, clamped)
 * read through `config.fleet.getEnrollmentTokenTtlMs()`. Two call sites
 * bypassed it and read the exported DEFAULT constant instead:
 *
 *   - `listOutstandingTokensForUser` computed `expiresAt` (and therefore
 *     `expired`) from the default, so with the env set the operator was
 *     shown an expiry the validator did not use — a token listed as live
 *     that `enroll` refuses, or the reverse;
 *   - `rotateCredentialForUser` reported `expiresInSec: 900` no matter
 *     what was configured, while the MINT route reported the real number.
 *
 * Two halves, deliberately. The behavioural half is the one that would
 * have caught the live bug; the source scan is what stops a third source
 * from appearing later, since a new bypass reads perfectly plausibly.
 */

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = 'user-1';

const SERVICE_SOURCE = join(__dirname, '..', 'fleet.service.ts');

/** Comment-stripped source, so a mention in prose is not a call site. */
function sourceWithoutComments(): string {
    return readFileSync(SERVICE_SOURCE, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
}

const node = (overrides: Partial<FleetNode> = {}): FleetNode =>
    ({
        id: NODE_ID,
        userId: OWNER,
        organizationId: null,
        name: 'everdesk2',
        kind: 'desktop-node',
        status: 'enrolling',
        enrollmentTokenHash: null,
        lastHeartbeatAt: null,
        credentialIssuedAt: new Date(),
        capabilities: [],
        capabilitiesPinned: false,
        platform: null,
        version: null,
        previousCredentialHash: null,
        previousCredentialExpiresAt: null,
        rotationRequestedAt: null,
        rotationRequestedByUserId: null,
        createdAt: new Date(),
        ...overrides,
    }) as FleetNode;

function build(row: FleetNode = node()) {
    let current = row;
    const repository = {
        create: jest.fn(async (data: Partial<FleetNode>) => {
            current = node({ ...data });
            return current;
        }),
        findById: jest.fn(async () => current),
        findByCredentialHash: jest.fn(async () => current),
        findByUser: jest.fn(async () => [current]),
        consumeEnrollment: jest.fn(async () => true),
        update: jest.fn(async (_id: string, patch: Partial<FleetNode>) => {
            current = { ...current, ...patch } as FleetNode;
        }),
        delete: jest.fn(async () => undefined),
        sweepOffline: jest.fn(async () => 0),
    };
    return { service: new FleetService(repository as never), repository, read: () => current };
}

describe('enrollment TTL: one source', () => {
    const ORIGINAL = process.env.FLEET_ENROLLMENT_TOKEN_TTL_MS;

    afterEach(() => {
        if (ORIGINAL === undefined) delete process.env.FLEET_ENROLLMENT_TOKEN_TTL_MS;
        else process.env.FLEET_ENROLLMENT_TOKEN_TTL_MS = ORIGINAL;
    });

    describe('source scan (stops a second source reappearing)', () => {
        it('mentions FLEET_ENROLLMENT_TOKEN_TTL_MS exactly once — its own export', () => {
            const source = sourceWithoutComments();
            const mentions = source.match(/\bFLEET_ENROLLMENT_TOKEN_TTL_MS\b/g) ?? [];
            expect(mentions).toHaveLength(1);
            // And that one mention IS the export line: the constant stays
            // exported (the node apps and the specs legitimately want the
            // DEFAULT), it just stops being read as the LIVE ttl.
            expect(source).toMatch(
                /export const FLEET_ENROLLMENT_TOKEN_TTL_MS = FLEET_DEFAULT_ENROLLMENT_TOKEN_TTL_MS;/,
            );
        });

        it('routes every TTL read through the config accessor', () => {
            const source = sourceWithoutComments();
            const reads = source.match(/config\.fleet\.getEnrollmentTokenTtlMs\(\)/g) ?? [];
            // mint, enroll-expiry check, the outstanding-token list and the
            // operator re-key. Four, and a fifth call site is fine — what is
            // not fine is a call site that reads the constant instead.
            expect(reads.length).toBeGreaterThanOrEqual(4);
        });
    });

    describe('behaviour (this is the half that would have caught the bug)', () => {
        const CUSTOM_TTL_MS = 3 * 60_000;

        beforeEach(() => {
            process.env.FLEET_ENROLLMENT_TOKEN_TTL_MS = String(CUSTOM_TTL_MS);
        });

        it('the MINT route reports the configured TTL', async () => {
            const { service } = build();
            const result = await service.createEnrollmentToken(OWNER, {
                name: 'everdesk2',
                kind: 'desktop-node',
            });
            expect(result.expiresInSec).toBe(CUSTOM_TTL_MS / 1000);
            expect(result.expiresInSec).not.toBe(FLEET_DEFAULT_ENROLLMENT_TOKEN_TTL_MS / 1000);
        });

        it('the ROTATE route reports the SAME number as the mint route', async () => {
            // It used to always answer 900 — the shipped default — while
            // the mint route answered the configured value.
            const { service } = build(node({ status: 'online' }));
            const result = await service.rotateCredentialForUser(OWNER, NODE_ID);
            expect(result.expiresInSec).toBe(CUSTOM_TTL_MS / 1000);
        });

        it('the token LIST shows the expiry enroll actually validates against', async () => {
            const issuedAt = new Date(Date.now() - CUSTOM_TTL_MS / 2);
            const { service } = build(node({ credentialIssuedAt: issuedAt }));

            const [listed] = await service.listOutstandingTokensForUser(OWNER);

            expect(listed.expiresAt).toBe(
                new Date(issuedAt.getTime() + CUSTOM_TTL_MS).toISOString(),
            );
            expect(listed.expired).toBe(false);
        });

        it('a token the list calls EXPIRED is one enroll refuses', async () => {
            const token = 'token-value-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
            // Older than the configured TTL, but younger than the DEFAULT:
            // the exact window in which the list and the validator used to
            // disagree.
            const issuedAt = new Date(Date.now() - CUSTOM_TTL_MS - 1_000);
            const { service } = build(
                node({ credentialIssuedAt: issuedAt, enrollmentTokenHash: sha256(token) }),
            );

            const [listed] = await service.listOutstandingTokensForUser(OWNER);
            expect(listed.expired).toBe(true);
            await expect(service.enroll(token)).resolves.toBeNull();
        });

        it('a token the list calls LIVE is one enroll accepts', async () => {
            const token = 'token-value-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
            const issuedAt = new Date(Date.now() - CUSTOM_TTL_MS / 2);
            const { service } = build(
                node({ credentialIssuedAt: issuedAt, enrollmentTokenHash: sha256(token) }),
            );

            const [listed] = await service.listOutstandingTokensForUser(OWNER);
            expect(listed.expired).toBe(false);
            await expect(service.enroll(token)).resolves.not.toBeNull();
        });
    });

    it('falls back to the documented default when the env var is unset', async () => {
        delete process.env.FLEET_ENROLLMENT_TOKEN_TTL_MS;
        const { service } = build();
        const result = await service.createEnrollmentToken(OWNER, {
            name: 'everdesk2',
            kind: 'desktop-node',
        });
        expect(result.expiresInSec).toBe(FLEET_DEFAULT_ENROLLMENT_TOKEN_TTL_MS / 1000);
    });

    it('a nonsense env value degrades to the default rather than to NaN', async () => {
        // NaN here would silently expire every token ever minted.
        process.env.FLEET_ENROLLMENT_TOKEN_TTL_MS = 'not-a-number';
        const { service } = build();
        const result = await service.createEnrollmentToken(OWNER, {
            name: 'everdesk2',
            kind: 'desktop-node',
        });
        expect(result.expiresInSec).toBe(FLEET_DEFAULT_ENROLLMENT_TOKEN_TTL_MS / 1000);
    });
});

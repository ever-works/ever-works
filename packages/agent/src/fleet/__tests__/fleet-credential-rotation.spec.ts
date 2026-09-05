import { createHash } from 'crypto';
import { FleetNode } from '../../entities/fleet-node.entity';
import { FleetService } from '../fleet.service';
import { redactAuditDetails } from '../fleet-audit.service';
import { matchNodeCredential, verifyNodeSecret } from '../fleet-node-credential';

/**
 * Node-initiated credential rotation with a bounded DUAL-ACCEPT window
 * (EW-799).
 *
 * The defect: the only rotation that existed killed the old secret the
 * instant the hash was replaced, so re-keying a machine meant walking to
 * it and typing a token that expires in 15 minutes. Across six machines
 * on six desks that ceremony never happens, so credentials never rotate.
 *
 * What has to be true for the replacement to be safe rather than merely
 * convenient — every one of these is a test below:
 *
 *   - BOTH credentials authenticate inside the window, at EVERY
 *     verification site. Three of four updated gives a node that
 *     heartbeats happily while its lease polls 401: a machine that looks
 *     healthy and does no work;
 *   - the old one is refused once the window passes, on the CLOCK alone —
 *     no callback, no confirmation, no sweeper;
 *   - a rotate presented with the PREVIOUS credential is refused, or a
 *     captured old secret renews itself forever;
 *   - a second rotation while a window is open is refused, or windows
 *     chain into a permanent overlap;
 *   - the loser of a concurrent rotation is refused (CAS), or one machine
 *     ends up holding a secret the row no longer knows;
 *   - the new secret is returned exactly once and never reaches an audit
 *     row or a log.
 */

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = 'user-1';
const CURRENT = 'current-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD = 'previous-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbb';

const node = (overrides: Partial<FleetNode> = {}): FleetNode =>
    ({
        id: NODE_ID,
        userId: OWNER,
        organizationId: null,
        name: 'everdesk2',
        kind: 'desktop-node',
        status: 'online',
        enrollmentTokenHash: sha256(CURRENT),
        lastHeartbeatAt: new Date(),
        credentialIssuedAt: new Date(),
        capabilities: [],
        capabilitiesPinned: false,
        platform: 'win32/x64',
        version: '1.0.0',
        cliVersion: null,
        diskFreeBytes: null,
        modelIdentity: null,
        dailyCostCeilingCents: null,
        dailyCostTrippedOn: null,
        previousCredentialHash: null,
        previousCredentialExpiresAt: null,
        rotationRequestedAt: null,
        rotationRequestedByUserId: null,
        createdAt: new Date(),
        ...overrides,
    }) as FleetNode;

function build(row: FleetNode | null = node()) {
    let current = row;
    const audit = {
        recordNodeAction: jest.fn(async (_input: Record<string, unknown>) => true),
    };
    const repository = {
        findById: jest.fn(async () => current),
        findByUser: jest.fn(async () => (current ? [current] : [])),
        findByCredentialHash: jest.fn(async () => current),
        create: jest.fn(async () => current),
        consumeEnrollment: jest.fn(
            async (_id: string, _expectedHash: string, _patch: Partial<FleetNode>) => true,
        ),
        update: jest.fn(async (_id: string, patch: Partial<FleetNode>) => {
            if (current) current = { ...current, ...patch } as FleetNode;
        }),
        delete: jest.fn(async () => undefined),
        sweepOffline: jest.fn(async () => 0),
        casRotateCredential: jest.fn(
            async (_id: string, expected: string, patch: Partial<FleetNode>) => {
                if (!current || current.enrollmentTokenHash !== expected) return false;
                current = { ...current, ...patch } as FleetNode;
                return true;
            },
        ),
        markRotationRequestedForUser: jest.fn(async () => 1),
    };
    const service = new FleetService(
        repository as never,
        undefined,
        undefined,
        // slice T (EW-776) appended the Inbox producer before this one;
        // notices are not what these cases are about.
        undefined,
        audit as never,
    );
    jest.spyOn(
        (service as never as { logger: Record<string, () => void> }).logger,
        'warn',
    ).mockImplementation(() => undefined);
    return { service, repository, audit, read: () => current };
}

describe('matchNodeCredential (the ONE dual-accept decision)', () => {
    const now = Date.parse('2026-09-05T10:00:00.000Z');
    const inWindow = new Date(now + 60_000);
    const expired = new Date(now - 1);

    const verify = (secret: string) => verifyNodeSecret(NODE_ID, secret)!;

    it('answers "current" for the live credential', () => {
        expect(matchNodeCredential(verify(CURRENT), node(), now)).toBe('current');
    });

    it('answers "previous" for the replaced credential while the window is open', () => {
        const row = node({
            previousCredentialHash: sha256(OLD),
            previousCredentialExpiresAt: inWindow,
        });
        expect(matchNodeCredential(verify(OLD), row, now)).toBe('previous');
    });

    it('refuses the replaced credential once the window has passed', () => {
        const row = node({
            previousCredentialHash: sha256(OLD),
            previousCredentialExpiresAt: expired,
        });
        // Only the clock moved. Nothing called back, nothing swept.
        expect(matchNodeCredential(verify(OLD), row, now)).toBeNull();
    });

    it('treats the exact expiry instant as OVER, not as still open', () => {
        const row = node({
            previousCredentialHash: sha256(OLD),
            previousCredentialExpiresAt: new Date(now),
        });
        expect(matchNodeCredential(verify(OLD), row, now)).toBeNull();
    });

    it('treats a MISSING expiry as expired, never as "no expiry"', () => {
        // Fail closed. A null here would otherwise be the most dangerous
        // value in the schema: a permanent second credential.
        const row = node({
            previousCredentialHash: sha256(OLD),
            previousCredentialExpiresAt: null,
        });
        expect(matchNodeCredential(verify(OLD), row, now)).toBeNull();
    });

    it('treats an unparseable expiry as expired', () => {
        const row = node({
            previousCredentialHash: sha256(OLD),
            previousCredentialExpiresAt: 'not-a-date' as never,
        });
        expect(matchNodeCredential(verify(OLD), row, now)).toBeNull();
    });

    it('accepts the sqlite STRING form of the expiry', () => {
        // better-sqlite3 (CI + e2e) hands timestamps back as strings while
        // Postgres hands back a Date. A matcher that understood only one
        // would fail open on the other driver.
        const row = node({
            previousCredentialHash: sha256(OLD),
            previousCredentialExpiresAt: inWindow.toISOString() as never,
        });
        expect(matchNodeCredential(verify(OLD), row, now)).toBe('previous');
    });

    it('refuses a credential that is neither', () => {
        const row = node({
            previousCredentialHash: sha256(OLD),
            previousCredentialExpiresAt: inWindow,
        });
        expect(
            matchNodeCredential(verify('some-other-secret-value-xxxxxxxx'), row, now),
        ).toBeNull();
    });

    it('refuses everything when the node has no credential at all', () => {
        const row = node({ enrollmentTokenHash: null, previousCredentialHash: null });
        expect(matchNodeCredential(verify(CURRENT), row, now)).toBeNull();
    });
});

describe('FleetService.rotateCredentialByCredential', () => {
    it('mints a new secret, keeps the node ONLINE, and opens the window', async () => {
        const { service, read } = build();

        const result = await service.rotateCredentialByCredential(NODE_ID, CURRENT);

        expect(result).not.toBeNull();
        expect(result!.secret).not.toBe(CURRENT);
        expect(result!.secret.length).toBeGreaterThanOrEqual(32);
        expect(result!.overlapSec).toBeGreaterThan(0);
        const row = read()!;
        // The live hash is the NEW secret's; the OLD one moved aside.
        expect(row.enrollmentTokenHash).toBe(sha256(result!.secret));
        expect(row.previousCredentialHash).toBe(sha256(CURRENT));
        expect(row.previousCredentialExpiresAt).toBeInstanceOf(Date);
        // Status untouched — unlike the operator re-key, the machine keeps
        // working straight through its own rotation.
        expect(row.status).toBe('online');
    });

    it('stores only hashes — the plaintext secret never reaches the row', async () => {
        const { service, read } = build();
        const result = await service.rotateCredentialByCredential(NODE_ID, CURRENT);
        const serialized = JSON.stringify(read());
        expect(serialized).not.toContain(result!.secret);
        expect(serialized).not.toContain(CURRENT);
    });

    it('never puts the new OR the old credential in the audit row', async () => {
        const { service, audit } = build();
        const result = await service.rotateCredentialByCredential(NODE_ID, CURRENT);

        expect(audit.recordNodeAction).toHaveBeenCalledTimes(1);
        const row = audit.recordNodeAction.mock.calls[0][0] as Record<string, unknown>;
        expect(row).toMatchObject({
            action: 'node.rotate-self',
            // The MACHINE rotated itself; no person was at that keyboard.
            actorUserId: null,
            ownerUserId: OWNER,
            nodeId: NODE_ID,
        });
        const serialized = JSON.stringify(row);
        for (const forbidden of [
            result!.secret,
            CURRENT,
            sha256(result!.secret),
            sha256(CURRENT),
        ]) {
            expect(serialized).not.toContain(forbidden);
        }
    });

    it('records WHEN the old credential dies, in a key the redaction belt keeps', async () => {
        // End-to-end through the real scrub, not just the call site: the
        // writer drops the value of any key whose NAME contains
        // "credential", so a field named after the column would have
        // stored `[redacted]` and thrown away the one fact this row
        // exists to record.
        const { service, audit } = build();
        const result = await service.rotateCredentialByCredential(NODE_ID, CURRENT);

        const call = audit.recordNodeAction.mock.calls[0][0] as {
            extra: Record<string, unknown>;
        };
        const scrubbed = redactAuditDetails(call.extra) as Record<string, unknown>;
        expect(scrubbed.overlapExpiresAt).toBe(result!.previousCredentialExpiresAt.toISOString());
        expect(scrubbed.overlapMs).toBe(result!.overlapSec * 1000);
        expect(JSON.stringify(scrubbed)).not.toContain('[redacted]');
    });

    it('returns the secret EXACTLY once — a second rotate does not re-issue it', async () => {
        const { service } = build();
        const first = await service.rotateCredentialByCredential(NODE_ID, CURRENT);
        expect(first).not.toBeNull();
        // The window is now open, so the immediate second attempt with the
        // NEW credential is refused (see below); there is no path that
        // hands the same secret back twice.
        const second = await service.rotateCredentialByCredential(NODE_ID, first!.secret);
        expect(second).toBeNull();
    });

    it('clears a queued rotate-all request that it satisfies', async () => {
        const { service, read } = build(
            node({ rotationRequestedAt: new Date(), rotationRequestedByUserId: OWNER }),
        );
        await service.rotateCredentialByCredential(NODE_ID, CURRENT);
        expect(read()!.rotationRequestedAt).toBeNull();
        expect(read()!.rotationRequestedByUserId).toBeNull();
    });

    it('lets a PAUSED or DISABLED node rotate — draining must not lock it out', async () => {
        for (const status of ['paused', 'disabled'] as const) {
            const { service, read } = build(node({ status }));
            const result = await service.rotateCredentialByCredential(NODE_ID, CURRENT);
            expect(result).not.toBeNull();
            // And the drain still stands afterwards.
            expect(read()!.status).toBe(status);
        }
    });

    describe('fail closed', () => {
        it('refuses a rotate presented with the PREVIOUS credential (replay)', async () => {
            const { service } = build(
                node({
                    previousCredentialHash: sha256(OLD),
                    previousCredentialExpiresAt: new Date(Date.now() + 60_000),
                }),
            );
            // The old secret still WORKS for heartbeat and lease — that is
            // the window. It must not work for rotating, or a captured
            // credential renews itself forever.
            await expect(service.rotateCredentialByCredential(NODE_ID, OLD)).resolves.toBeNull();
        });

        it('refuses a second rotation while a window is still open', async () => {
            const { service } = build(
                node({
                    previousCredentialHash: sha256(OLD),
                    previousCredentialExpiresAt: new Date(Date.now() + 60_000),
                }),
            );
            await expect(
                service.rotateCredentialByCredential(NODE_ID, CURRENT),
            ).resolves.toBeNull();
        });

        it('allows a rotation once the previous window has expired', async () => {
            const { service } = build(
                node({
                    previousCredentialHash: sha256(OLD),
                    previousCredentialExpiresAt: new Date(Date.now() - 1),
                }),
            );
            await expect(
                service.rotateCredentialByCredential(NODE_ID, CURRENT),
            ).resolves.not.toBeNull();
        });

        it('refuses a still-enrolling node (its hash is a token, not a secret)', async () => {
            const { service } = build(node({ status: 'enrolling' }));
            await expect(
                service.rotateCredentialByCredential(NODE_ID, CURRENT),
            ).resolves.toBeNull();
        });

        it('refuses an unknown node, a malformed id and a malformed secret', async () => {
            const { service } = build(null);
            await expect(
                service.rotateCredentialByCredential(NODE_ID, CURRENT),
            ).resolves.toBeNull();

            const live = build();
            await expect(
                live.service.rotateCredentialByCredential('not-a-uuid', CURRENT),
            ).resolves.toBeNull();
            await expect(
                live.service.rotateCredentialByCredential(NODE_ID, 'x'),
            ).resolves.toBeNull();
            // A malformed credential is refused BEFORE any database read.
            expect(live.repository.findById).not.toHaveBeenCalled();
        });

        it('refuses a wrong secret', async () => {
            const { service } = build();
            await expect(
                service.rotateCredentialByCredential(NODE_ID, 'wrong-secret-cccccccccccccccccccc'),
            ).resolves.toBeNull();
        });

        it('refuses the LOSER of two concurrent rotations (CAS on the presented hash)', async () => {
            const { service, repository, audit } = build();
            // Both callers present the same current credential; the CAS
            // predicate only matches for whichever write lands first.
            const [first, second] = await Promise.all([
                service.rotateCredentialByCredential(NODE_ID, CURRENT),
                service.rotateCredentialByCredential(NODE_ID, CURRENT),
            ]);
            const winners = [first, second].filter((result) => result !== null);
            expect(winners).toHaveLength(1);
            expect(repository.casRotateCredential).toHaveBeenCalledTimes(2);
            // And exactly one rotation is recorded, not two.
            expect(audit.recordNodeAction).toHaveBeenCalledTimes(1);
        });

        it('writes NO audit row when the rotation is refused', async () => {
            const { service, audit } = build(node({ status: 'enrolling' }));
            await service.rotateCredentialByCredential(NODE_ID, CURRENT);
            expect(audit.recordNodeAction).not.toHaveBeenCalled();
        });
    });
});

describe('a fresh enrollment carries no window from the row’s previous life', () => {
    it('clears the dual-accept columns as part of the enroll CAS', async () => {
        // Today the only route back to `enrolling` is the operator re-key,
        // which clears these itself — so this is a belt, and the point of
        // it is that "a just-enrolled node accepts exactly one credential"
        // stops depending on an argument about which call sites exist.
        const TOKEN = 'enrollment-token-ddddddddddddddddddddddddd';
        const { service, repository } = build(
            node({
                status: 'enrolling',
                enrollmentTokenHash: sha256(TOKEN),
                credentialIssuedAt: new Date(),
                previousCredentialHash: sha256(OLD),
                previousCredentialExpiresAt: new Date(Date.now() + 60_000),
            }),
        );

        const result = await service.enroll(TOKEN, {});

        expect(result).not.toBeNull();
        const patch = repository.consumeEnrollment.mock.calls[0][2] as Record<string, unknown>;
        expect(patch.previousCredentialHash).toBeNull();
        expect(patch.previousCredentialExpiresAt).toBeNull();
    });
});

describe('the window at every verification site', () => {
    it('heartbeat accepts BOTH credentials inside the window and refuses the old one after', async () => {
        const { service, read } = build();
        const rotated = await service.rotateCredentialByCredential(NODE_ID, CURRENT);
        expect(rotated).not.toBeNull();

        // Inside the window: the new secret and the one it replaced.
        await expect(service.heartbeat(NODE_ID, rotated!.secret)).resolves.not.toBeNull();
        await expect(service.heartbeat(NODE_ID, CURRENT)).resolves.not.toBeNull();

        // Advance ONLY the clock — nothing calls back, nothing sweeps.
        read()!.previousCredentialExpiresAt = new Date(Date.now() - 1);
        await expect(service.heartbeat(NODE_ID, CURRENT)).resolves.toBeNull();
        await expect(service.heartbeat(NODE_ID, rotated!.secret)).resolves.not.toBeNull();
    });

    it('the pause/unenroll path honours the same window', async () => {
        const { service, read } = build();
        const rotated = await service.rotateCredentialByCredential(NODE_ID, CURRENT);

        await expect(service.setPausedByCredential(NODE_ID, CURRENT, true)).resolves.not.toBeNull();
        await expect(
            service.setPausedByCredential(NODE_ID, rotated!.secret, false),
        ).resolves.not.toBeNull();

        read()!.previousCredentialExpiresAt = new Date(Date.now() - 1);
        await expect(service.setPausedByCredential(NODE_ID, CURRENT, true)).resolves.toBeNull();
        await expect(service.unenrollByCredential(NODE_ID, CURRENT)).resolves.toBe(false);
    });

    it('the heartbeat reports a queued rotation so the node knows to re-key', async () => {
        const { service } = build(
            node({ rotationRequestedAt: new Date(), rotationRequestedByUserId: OWNER }),
        );
        const beat = await service.heartbeat(NODE_ID, CURRENT);
        expect(beat!.rotationRequested).toBe(true);
        expect(beat!.node.rotationRequestedAt).toBeTruthy();
    });

    it('a node with no queued rotation is told so', async () => {
        const { service } = build();
        const beat = await service.heartbeat(NODE_ID, CURRENT);
        expect(beat!.rotationRequested).toBe(false);
        expect(beat!.node.rotationRequestedAt).toBeNull();
    });

    it('never leaks a credential hash into the node view', async () => {
        const { service } = build(
            node({
                previousCredentialHash: sha256(OLD),
                previousCredentialExpiresAt: new Date(Date.now() + 60_000),
            }),
        );
        const beat = await service.heartbeat(NODE_ID, CURRENT);
        const serialized = JSON.stringify(beat!.node);
        expect(serialized).not.toContain(sha256(CURRENT));
        expect(serialized).not.toContain(sha256(OLD));
    });
});

describe('FleetService.queueRotationForUser (rotate-all)', () => {
    it('QUEUES without rotating anything and mints no credential', async () => {
        const { service, repository, read } = build();

        const result = await service.queueRotationForUser(OWNER);

        expect(repository.markRotationRequestedForUser).toHaveBeenCalledWith(
            OWNER,
            OWNER,
            expect.any(Date),
        );
        // No credential was touched: the live hash is unchanged and no
        // window opened.
        expect(read()!.enrollmentTokenHash).toBe(sha256(CURRENT));
        expect(read()!.previousCredentialHash).toBeNull();
        expect(repository.casRotateCredential).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain(CURRENT);
        expect(result.queuedNodes).toBe(1);
    });

    it('skips nodes that are still enrolling — they hold a token, not a secret', async () => {
        const { service, repository } = build(node({ status: 'enrolling' }));
        repository.markRotationRequestedForUser.mockResolvedValue(0);

        const result = await service.queueRotationForUser(OWNER);

        expect(result.queuedNodes).toBe(0);
        expect(result.skippedNodes).toBe(1);
    });

    it('records ONE row for the decision, with no node id', async () => {
        const { service, audit } = build();
        await service.queueRotationForUser(OWNER);

        expect(audit.recordNodeAction).toHaveBeenCalledTimes(1);
        expect(audit.recordNodeAction).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'rotate-all',
                actorUserId: OWNER,
                ownerUserId: OWNER,
                nodeId: null,
                extra: expect.objectContaining({ queuedNodes: 1, skippedNodes: 0 }),
            }),
        );
    });

    it('reports auditFailed without undoing the queueing', async () => {
        const { service, audit, repository } = build();
        audit.recordNodeAction.mockResolvedValue(false);

        const result = await service.queueRotationForUser(OWNER);

        expect(result.auditFailed).toBe(true);
        expect(result.queuedNodes).toBe(1);
        expect(repository.markRotationRequestedForUser).toHaveBeenCalledTimes(1);
    });
});

import { createHash } from 'crypto';
import {
    FLEET_AUDIT_ACTIONS,
    FLEET_AUDIT_DEFAULT_LIMIT,
    FLEET_AUDIT_MAX_LIMIT,
} from '@ever-works/contracts';
import { FleetAuditService, redactAuditDetails } from '../fleet-audit.service';
import {
    COMPUTER_AUDIT_DETAIL_KEYS,
    computerAuditDetails,
    type ComputerAuditAction,
} from '../../computer/computer-audit';

/**
 * The ONE writer of `fleet_audit` (EW-778, extended by EW-799).
 *
 * Three properties are load-bearing and are what this suite pins:
 *
 *  1. **No audit row can contain a credential.** The scrub lives in the
 *     writer, not at the call sites, so it is a property of one function
 *     rather than a promise made by twenty. That is checkable; a promise
 *     is not.
 *  2. **`tryRecord` never throws.** Act first, then audit: a drain, a
 *     stop or a rotation must never be undone because bookkeeping failed.
 *  3. **The owner-scoped read is actually owner-scoped.** `recent()`
 *     reads the whole table and is platform-admin only; the per-node read
 *     must filter on BOTH the owner and the node.
 */

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function build() {
    const saved: Array<Record<string, unknown>> = [];
    const repository = {
        create: jest.fn((row: Record<string, unknown>) => row),
        save: jest.fn(async (row: Record<string, unknown>) => {
            saved.push(row);
            return { id: `audit-${saved.length}`, occurredAt: new Date(), ...row };
        }),
        find: jest.fn(async () => []),
    };
    const service = new FleetAuditService(repository as never);
    // The service logs a failed write at error level; keep the suite quiet.
    jest.spyOn(
        (service as never as { logger: Record<string, () => void> }).logger,
        'error',
    ).mockImplementation(() => undefined);
    return { service, repository, saved };
}

describe('FleetAuditService.record', () => {
    it('stores the action, actor, owner and node exactly as given', async () => {
        const { service, saved } = build();

        await service.record({
            action: 'node.rotate',
            actorUserId: 'user-1',
            ownerUserId: 'user-1',
            nodeId: 'node-1',
            details: { before: { status: 'online' }, after: { status: 'enrolling' } },
        });

        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({
            action: 'node.rotate',
            actorUserId: 'user-1',
            ownerUserId: 'user-1',
            nodeId: 'node-1',
        });
    });

    it('normalises a missing actor to NULL (a system row), not to undefined', async () => {
        const { service, saved } = build();
        await service.record({ action: 'node.enroll', actorUserId: null });
        expect(saved[0].actorUserId).toBeNull();
        expect(saved[0].ownerUserId).toBeNull();
        expect(saved[0].nodeId).toBeNull();
    });

    it('THROWS on a repository failure — the posture is the caller’s choice', async () => {
        const { service, repository } = build();
        repository.save.mockRejectedValueOnce(new Error('db down'));
        await expect(
            service.record({ action: 'drain-all', actorUserId: 'user-1' }),
        ).rejects.toThrow('db down');
    });
});

describe('FleetAuditService redaction belt', () => {
    it('drops the VALUE of any credential-named key, whatever it looks like', async () => {
        const { service, saved } = build();
        const secret = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';

        await service.record({
            action: 'node.rotate-self',
            actorUserId: null,
            nodeId: 'node-1',
            details: {
                // Every one of these is a credential artefact, and a
                // sha256 is not "secret-shaped" to any scanner — which is
                // exactly why the key, not just the value, is matched.
                secret,
                nodeSecret: secret,
                enrollmentTokenHash: sha256(secret),
                previousCredentialHash: sha256(secret),
                apiKey: 'anything',
                overlapMs: 900_000,
            },
        });

        const details = saved[0].details as Record<string, unknown>;
        expect(details.secret).toBe('[redacted]');
        expect(details.nodeSecret).toBe('[redacted]');
        expect(details.enrollmentTokenHash).toBe('[redacted]');
        expect(details.previousCredentialHash).toBe('[redacted]');
        expect(details.apiKey).toBe('[redacted]');
        // A non-credential key is untouched — the belt must not eat the
        // facts the row exists to record.
        expect(details.overlapMs).toBe(900_000);
        const serialized = JSON.stringify(saved[0]);
        expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain(sha256(secret));
    });

    it('scrubs credential-named keys nested inside before/after', async () => {
        const { service, saved } = build();

        await service.record({
            action: 'node.rotate',
            actorUserId: 'user-1',
            details: {
                before: { status: 'online', credentialHash: 'abc123' },
                after: { status: 'enrolling', nested: [{ token: 'ghp_reallylongtokenvalue' }] },
            },
        });

        const details = saved[0].details as Record<string, Record<string, unknown>>;
        expect(details.before.credentialHash).toBe('[redacted]');
        expect(details.before.status).toBe('online');
        const nested = details.after.nested as Array<Record<string, unknown>>;
        expect(nested[0].token).toBe('[redacted]');
        expect(JSON.stringify(saved[0])).not.toContain('ghp_reallylongtokenvalue');
    });

    it('runs surviving strings through the secret scanner', () => {
        // A token that reached a details blob under an innocent key is
        // still a token. `redactSecrets` is the same scanner
        // `sanitizeModelIdentity` already applies to node-reported text.
        const cleaned = redactAuditDetails({
            note: 'operator pasted ghp_0123456789abcdefghijklmnopqrstuvwxyzAB by mistake',
        }) as Record<string, string>;
        expect(cleaned.note).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB');
    });

    it('keeps null and undefined values as they are rather than masking them', () => {
        // `{ previousCredentialHash: null }` says "there is no previous
        // credential" — replacing that with a placeholder would invent one.
        const cleaned = redactAuditDetails({ previousCredentialHash: null }) as Record<
            string,
            unknown
        >;
        expect(cleaned.previousCredentialHash).toBeNull();
    });

    it('returns null for empty details rather than an empty object', () => {
        expect(redactAuditDetails(null)).toBeNull();
        expect(redactAuditDetails(undefined)).toBeNull();
    });

    it('normalises Dates so an exotic object cannot slip past the scrub', () => {
        const at = new Date('2026-09-05T10:00:00.000Z');
        const cleaned = redactAuditDetails({ at }) as Record<string, unknown>;
        expect(cleaned.at).toBe('2026-09-05T10:00:00.000Z');
    });

    it('does NOT eat the facts a rotation row exists to record', () => {
        // The belt matches on the key NAME, so an innocent field named
        // after a credential COLUMN (`previousCredentialExpiresAt`) is
        // silently replaced with the placeholder — throwing away the one
        // thing an operator opens a `node.rotate-self` row to learn:
        // when the old credential dies. The field is therefore named for
        // what it means, and this test is what keeps it that way.
        const iso = '2026-09-05T10:15:00.000Z';
        const eaten = redactAuditDetails({ previousCredentialExpiresAt: iso }) as Record<
            string,
            unknown
        >;
        expect(eaten.previousCredentialExpiresAt).toBe('[redacted]');

        const kept = redactAuditDetails({
            via: 'node',
            overlapMs: 900_000,
            overlapExpiresAt: iso,
            queuedByUserId: 'user-1',
        }) as Record<string, unknown>;
        expect(kept).toEqual({
            via: 'node',
            overlapMs: 900_000,
            overlapExpiresAt: iso,
            queuedByUserId: 'user-1',
        });
    });
});

describe('FleetAuditService.tryRecord', () => {
    it('returns true on success', async () => {
        const { service } = build();
        await expect(
            service.tryRecord({ action: 'node.delete', actorUserId: 'user-1' }),
        ).resolves.toBe(true);
    });

    it('returns false and NEVER throws when the row cannot be written', async () => {
        const { service, repository } = build();
        repository.save.mockRejectedValue(new Error('db down'));
        await expect(
            service.tryRecord({ action: 'node.delete', actorUserId: 'user-1', nodeId: 'node-1' }),
        ).resolves.toBe(false);
    });
});

describe('FleetAuditService.recordNodeAction', () => {
    it('normalises before/after under the same keys the kill-switch rows use', async () => {
        const { service, saved } = build();

        await service.recordNodeAction({
            action: 'node.pause',
            actorUserId: null,
            ownerUserId: 'user-1',
            nodeId: 'node-1',
            before: { status: 'online' },
            after: { status: 'paused' },
            extra: { via: 'node' },
        });

        expect(saved[0].details).toEqual({
            via: 'node',
            before: { status: 'online' },
            after: { status: 'paused' },
        });
    });

    it('writes a null details blob rather than an empty object', async () => {
        const { service, saved } = build();
        await service.recordNodeAction({
            action: 'rotate-all',
            actorUserId: 'user-1',
            ownerUserId: 'user-1',
        });
        expect(saved[0].details).toBeNull();
    });

    it('never throws — it is the tryRecord posture', async () => {
        const { service, repository } = build();
        repository.save.mockRejectedValue(new Error('db down'));
        await expect(
            service.recordNodeAction({
                action: 'node.rename',
                actorUserId: 'user-1',
                ownerUserId: 'user-1',
                nodeId: 'node-1',
            }),
        ).resolves.toBe(false);
    });
});

describe('FleetAuditService reads', () => {
    it('recent() is table-wide and bounded', async () => {
        const { service, repository } = build();
        await service.recent();
        expect(repository.find).toHaveBeenCalledWith({
            order: { occurredAt: 'DESC' },
            take: FLEET_AUDIT_DEFAULT_LIMIT,
        });

        await service.recent(10_000);
        expect(repository.find).toHaveBeenLastCalledWith({
            order: { occurredAt: 'DESC' },
            take: FLEET_AUDIT_MAX_LIMIT,
        });
    });

    it('recentForOwnerNode filters on BOTH the owner and the node', async () => {
        const { service, repository } = build();
        await service.recentForOwnerNode('user-1', 'node-1', 25);
        expect(repository.find).toHaveBeenCalledWith({
            where: { ownerUserId: 'user-1', nodeId: 'node-1' },
            order: { occurredAt: 'DESC' },
            take: 25,
        });
    });

    it('clamps a nonsense limit rather than trusting it', async () => {
        const { service, repository } = build();
        await service.recentForOwnerNode('user-1', 'node-1', -5);
        expect(repository.find).toHaveBeenLastCalledWith(expect.objectContaining({ take: 1 }));
        await service.recentForOwnerNode('user-1', 'node-1', Number.NaN);
        expect(repository.find).toHaveBeenLastCalledWith(
            expect.objectContaining({ take: FLEET_AUDIT_DEFAULT_LIMIT }),
        );
    });
});

/**
 * Agent computers — the eight computer actions are new VALUES through the
 * same writer, not a new writer. A live view handles pictures, typed text
 * and page selectors; none of them may reach a row, so each action records
 * a fixed set of facts, and every one of those facts must survive the
 * writer's key-based redaction intact (a key merely CONTAINING `hash` or
 * `token` would silently lose its value).
 */
describe('FleetAuditService — computer actions', () => {
    const SAMPLE: Record<ComputerAuditAction, Record<string, unknown>> = {
        'computer.session-open': {
            sessionId: 's-1',
            agentId: 'a-1',
            channels: ['screen'],
            quality: 'sharp',
            runId: null,
        },
        'computer.session-close': {
            sessionId: 's-1',
            agentId: 'a-1',
            closeReason: 'closed-by-user',
            durationMs: 61_000,
            frameCount: 480,
            recorded: false,
        },
        'computer.control-grant': { sessionId: 's-1', agentId: 'a-1' },
        'computer.control-release': {
            sessionId: 's-1',
            releaseReason: 'given-back',
            heldMs: 5_000,
        },
        'computer.control-refused': { sessionId: 's-1', policy: 'owner', holderPresent: true },
        'computer.teach-start': { demonstrationId: 'd-1', intent: 'file an expense report' },
        'computer.teach-finish': {
            demonstrationId: 'd-1',
            stepCount: 12,
            redactedStepCount: 1,
            stopReason: 'finished',
        },
        'computer.profile-reset': {
            agentId: 'a-1',
            profileRef: 'ab12cd34',
            signedInSiteCountBefore: 3,
        },
    };

    /** Keys that would carry what a live view must never write down. */
    const PAYLOAD_KEY_RE = /^(data|frame|frames|value|text|selector|screenshot|keys?|payload)$/i;
    const REDACTED_KEY_RE = /secret|token|credential|password|passphrase|hash|apikey|api_key/i;

    it('covers exactly the computer members of the action list', () => {
        const computerActions = FLEET_AUDIT_ACTIONS.filter((action) =>
            action.startsWith('computer.'),
        );
        expect(Object.keys(COMPUTER_AUDIT_DETAIL_KEYS).sort()).toEqual([...computerActions].sort());
        expect(computerActions).toHaveLength(8);
    });

    it.each(Object.keys(SAMPLE) as ComputerAuditAction[])(
        '%s writes a row whose facts survive intact',
        async (action) => {
            const { service, saved } = build();
            const details = computerAuditDetails(action, SAMPLE[action]);

            expect(
                await service.tryRecord({
                    action,
                    actorUserId: 'user-1',
                    ownerUserId: 'user-1',
                    nodeId: 'node-1',
                    details,
                }),
            ).toBe(true);

            expect(saved).toHaveLength(1);
            expect(saved[0]).toMatchObject({ action, nodeId: 'node-1' });
            expect(saved[0].details).toEqual(SAMPLE[action]);
            for (const key of COMPUTER_AUDIT_DETAIL_KEYS[action]) {
                expect(REDACTED_KEY_RE.test(key)).toBe(false);
                expect(PAYLOAD_KEY_RE.test(key)).toBe(false);
            }
        },
    );

    it('drops a picture, a typed value, a selector or any other extra field before the row is built', async () => {
        const { service, saved } = build();
        const details = computerAuditDetails('computer.session-close', {
            ...SAMPLE['computer.session-close'],
            data: 'iVBORw0KGgoAAAANSUhEUgAA',
            value: 'hunter2',
            selector: 'input[name=password]',
            frames: [{ kind: 'frame' }],
        });

        await service.tryRecord({ action: 'computer.session-close', actorUserId: null, details });

        const stored = saved[0].details as Record<string, unknown>;
        expect(stored).toEqual(SAMPLE['computer.session-close']);
        for (const key of Object.keys(stored)) {
            expect(PAYLOAD_KEY_RE.test(key)).toBe(false);
        }
    });

    it('refuses shapes that could smuggle a payload even under an allowed key', () => {
        expect(
            computerAuditDetails('computer.teach-start', {
                demonstrationId: 'd-1',
                intent: 'x'.repeat(500),
            }),
        ).toEqual({ demonstrationId: 'd-1' });
        expect(
            computerAuditDetails('computer.session-open', {
                sessionId: { nested: 'object' },
                channels: [{ kind: 'frame' }],
                quality: Number.NaN,
            }),
        ).toEqual({});
    });
});

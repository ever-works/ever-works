import { createHash } from 'crypto';
import { FleetNode } from '../../entities/fleet-node.entity';
import { FleetService } from '../fleet.service';
import { FleetAgentNodeAffinityService } from '../fleet-agent-node-affinity.service';
import { FleetExecutionPreferenceService } from '../fleet-execution-preference.service';

/**
 * Lifecycle audit coverage (EW-799, findings OPS-17 / OPS-18 / OPS-23).
 *
 * The defect: slice V audited the four PANIC actions and nothing else, so
 * every ordinary lifecycle write — enroll, rotate, revoke, rename,
 * capability edits, ceilings, pause, disable, delete, unenroll,
 * execution preferences, agent-node affinity — left no record of who did
 * it, when, or what changed. "Who drained that machine at 2am" had no
 * answer.
 *
 * Table-driven on purpose: the failure this suite exists to catch is a
 * write that quietly has NO row, and a per-method test invites the next
 * author to add a method without adding a test. Each case asserts the
 * same four things — exactly one row, the right action, the right ACTOR
 * (owner / node / system), and no credential anywhere in it.
 */

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const ORGANIZATION = '33333333-3333-4333-8333-333333333333';
const WORK_ID = '44444444-4444-4444-8444-444444444444';
const OWNER = 'user-1';
const SECRET = 'node-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN = 'enrollment-token-bbbbbbbbbbbbbbbbbbbbbbbbb';

const node = (overrides: Partial<FleetNode> = {}): FleetNode =>
    ({
        id: NODE_ID,
        userId: OWNER,
        organizationId: null,
        name: 'everdesk2',
        kind: 'desktop-node',
        status: 'online',
        enrollmentTokenHash: sha256(SECRET),
        lastHeartbeatAt: new Date(),
        credentialIssuedAt: new Date(),
        capabilities: ['workspace'],
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

type AuditRow = {
    action: string;
    actorUserId: string | null;
    ownerUserId?: string | null;
    nodeId?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    extra?: Record<string, unknown> | null;
};

function buildFleet(row: FleetNode = node()) {
    let current: FleetNode | null = row;
    const rows: AuditRow[] = [];
    const audit = {
        recordNodeAction: jest.fn(async (input: AuditRow) => {
            rows.push(input);
            return true;
        }),
    };
    const repository = {
        create: jest.fn(async (data: Partial<FleetNode>) => {
            current = node({ ...data, status: 'enrolling' });
            return current;
        }),
        findById: jest.fn(async () => current),
        findByCredentialHash: jest.fn(async () => current),
        findByUser: jest.fn(async () => (current ? [current] : [])),
        consumeEnrollment: jest.fn(async () => true),
        update: jest.fn(async (_id: string, patch: Partial<FleetNode>) => {
            if (current) current = { ...current, ...patch } as FleetNode;
        }),
        delete: jest.fn(async () => {
            current = null;
        }),
        sweepOffline: jest.fn(async () => 0),
        casRotateCredential: jest.fn(async () => true),
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
    return { service, repository, audit, rows };
}

/** Every plaintext and hash that must never appear in an audit row. */
const FORBIDDEN = [SECRET, TOKEN, sha256(SECRET), sha256(TOKEN)];

function assertNoCredential(rows: AuditRow[]): void {
    const serialized = JSON.stringify(rows);
    for (const value of FORBIDDEN) {
        expect(serialized).not.toContain(value);
    }
    // Belt: no key that NAMES a credential either, whatever its value.
    expect(serialized).not.toMatch(/"(enrollmentTokenHash|previousCredentialHash|secret|token)"/i);
}

describe('FleetService lifecycle audit', () => {
    const cases: Array<{
        name: string;
        action: string;
        actor: string | null;
        run: (fleet: ReturnType<typeof buildFleet>) => Promise<unknown>;
        row?: FleetNode;
    }> = [
        {
            name: 'createEnrollmentToken',
            action: 'node.create',
            actor: OWNER,
            run: ({ service }) =>
                service.createEnrollmentToken(OWNER, { name: 'everdesk2', kind: 'desktop-node' }),
        },
        {
            name: 'enroll (actor is the MACHINE, not its owner)',
            action: 'node.enroll',
            actor: null,
            row: node({ status: 'enrolling', enrollmentTokenHash: sha256(TOKEN) }),
            run: ({ service }) => service.enroll(TOKEN, { platform: 'win32/x64' }),
        },
        {
            name: 'revokeEnrollmentTokenForUser',
            action: 'node.token-revoke',
            actor: OWNER,
            row: node({ status: 'enrolling' }),
            run: ({ service }) => service.revokeEnrollmentTokenForUser(OWNER, NODE_ID),
        },
        {
            name: 'rotateCredentialForUser (the operator re-key)',
            action: 'node.rotate',
            actor: OWNER,
            run: ({ service }) => service.rotateCredentialForUser(OWNER, NODE_ID),
        },
        {
            name: 'renameForUser',
            action: 'node.rename',
            actor: OWNER,
            run: ({ service }) => service.renameForUser(OWNER, NODE_ID, 'everdesk3'),
        },
        {
            name: 'setCapabilitiesForUser',
            action: 'node.capabilities',
            actor: OWNER,
            run: ({ service }) => service.setCapabilitiesForUser(OWNER, NODE_ID, ['docker']),
        },
        {
            name: 'setDailyCostCeilingForUser',
            action: 'node.cost-ceiling',
            actor: OWNER,
            run: ({ service }) => service.setDailyCostCeilingForUser(OWNER, NODE_ID, 2_500),
        },
        {
            name: 'setPausedForUser',
            action: 'node.pause',
            actor: OWNER,
            run: ({ service }) => service.setPausedForUser(OWNER, NODE_ID, true),
        },
        {
            name: 'setPausedByCredential (actor is the MACHINE)',
            action: 'node.pause',
            actor: null,
            run: ({ service }) => service.setPausedByCredential(NODE_ID, SECRET, true),
        },
        {
            name: 'setDisabledForUser',
            action: 'node.disable',
            actor: OWNER,
            run: ({ service }) => service.setDisabledForUser(OWNER, NODE_ID, true),
        },
        {
            name: 'deleteForUser',
            action: 'node.delete',
            actor: OWNER,
            run: ({ service }) => service.deleteForUser(OWNER, NODE_ID),
        },
        {
            name: 'unenrollByCredential (actor is the MACHINE)',
            action: 'node.unenroll',
            actor: null,
            run: ({ service }) => service.unenrollByCredential(NODE_ID, SECRET),
        },
    ];

    it.each(cases.map((entry) => [entry.name, entry] as const))(
        '%s writes exactly one row with the right action and actor, and no credential',
        async (_name, entry) => {
            const fleet = buildFleet(entry.row ?? node());

            await entry.run(fleet);

            expect(fleet.rows).toHaveLength(1);
            expect(fleet.rows[0].action).toBe(entry.action);
            expect(fleet.rows[0].actorUserId).toBe(entry.actor);
            // Owner scope is always the machine's owner, even when the
            // machine itself acted — that is what makes the row findable.
            expect(fleet.rows[0].ownerUserId).toBe(OWNER);
            expect(fleet.rows[0].nodeId).toBe(NODE_ID);
            assertNoCredential(fleet.rows);
        },
    );

    it.each(
        cases
            .filter((entry) => !['node.create', 'node.enroll'].includes(entry.action))
            .map((entry) => [entry.name, entry] as const),
    )(
        '%s records a before/after delta rather than encoding direction in the verb',
        async (_name, entry) => {
            const fleet = buildFleet(entry.row ?? node());
            await entry.run(fleet);
            // `before` is always present for a change to an existing node;
            // `after` is null for the two deletions, which is the delta.
            expect(fleet.rows[0]).toHaveProperty('before');
            expect(fleet.rows[0]).toHaveProperty('after');
        },
    );

    it('heartbeat is deliberately NOT audited', async () => {
        // One row per node per 30s is a firehose, not a trail.
        const fleet = buildFleet();
        await fleet.service.heartbeat(NODE_ID, SECRET);
        expect(fleet.rows).toHaveLength(0);
    });

    it('a refused action writes no row at all', async () => {
        const fleet = buildFleet();
        await fleet.service.setPausedByCredential(NODE_ID, 'wrong-secret-cccccccccccccccccc', true);
        await fleet.service.unenrollByCredential(NODE_ID, 'wrong-secret-cccccccccccccccccc');
        expect(fleet.rows).toHaveLength(0);
    });

    it('a no-op resume of a DISABLED node writes no row (nothing changed)', async () => {
        const fleet = buildFleet(node({ status: 'disabled' }));
        await fleet.service.setPausedForUser(OWNER, NODE_ID, false);
        expect(fleet.rows).toHaveLength(0);
    });

    it('a THROWING audit never fails the action', async () => {
        const fleet = buildFleet();
        jest.spyOn(
            (fleet.service as never as { logger: Record<string, () => void> }).logger,
            'error',
        ).mockImplementation(() => undefined);
        // The writer swallows by contract; this asserts the SERVICE does
        // not reintroduce the failure by awaiting an unguarded promise.
        // The action has already landed when the audit runs, so an
        // exception escaping here would answer 500 for a rename that
        // actually succeeded — bookkeeping undoing the act, which is the
        // one thing this posture exists to prevent.
        fleet.audit.recordNodeAction.mockRejectedValue(new Error('audit down'));
        await expect(fleet.service.renameForUser(OWNER, NODE_ID, 'renamed')).resolves.toMatchObject(
            { name: 'renamed' },
        );
        expect(fleet.repository.update).toHaveBeenCalledWith(NODE_ID, { name: 'renamed' });
    });

    it('an absent audit writer degrades to recording nothing, never to throwing', async () => {
        // `FleetService` is constructed with only a repository in several
        // contexts; the registry must stay usable there.
        const repository = {
            findById: jest.fn(async () => node()),
            update: jest.fn(async () => undefined),
        };
        const service = new FleetService(repository as never);
        await expect(service.renameForUser(OWNER, NODE_ID, 'renamed')).resolves.toMatchObject({
            name: 'renamed',
        });
    });

    describe('ctx: who acted, and who records it', () => {
        it('suppress: true writes nothing — the caller owns the row', async () => {
            const fleet = buildFleet();
            await fleet.service.setDisabledForUser(OWNER, NODE_ID, true, { suppress: true });
            expect(fleet.rows).toHaveLength(0);
        });

        it('actorUserId: null attributes the write to the SYSTEM, not the owner', async () => {
            // The cost-ceiling drain calls this owner-scoped method with
            // the OWNER's id while the actor is the system. Without the
            // override the row would accuse a sleeping operator.
            const fleet = buildFleet();
            await fleet.service.setDisabledForUser(OWNER, NODE_ID, true, {
                actorUserId: null,
                via: 'cost-ceiling',
                details: { day: '2026-09-05' },
            });
            expect(fleet.rows).toHaveLength(1);
            expect(fleet.rows[0].actorUserId).toBeNull();
            expect(fleet.rows[0].ownerUserId).toBe(OWNER);
            expect(fleet.rows[0].extra).toMatchObject({ via: 'cost-ceiling', day: '2026-09-05' });
        });
    });
});

describe('FleetExecutionPreferenceService audit', () => {
    function build() {
        const rows: AuditRow[] = [];
        const stored: Array<Record<string, unknown>> = [];
        const repository = {
            findByUser: jest.fn(async () => stored),
            upsert: jest.fn(async (input: Record<string, unknown>) => {
                const row = {
                    id: 'pref-1',
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    ...input,
                };
                stored.push(row);
                return row;
            }),
            remove: jest.fn(async () => undefined),
        };
        const audit = {
            recordNodeAction: jest.fn(async (input: AuditRow) => {
                rows.push(input);
                return true;
            }),
        };
        const service = new FleetExecutionPreferenceService(repository as never, audit as never);
        return { service, repository, rows };
    }

    it('records a set with the scope and the mode, and no node id', async () => {
        const { service, rows } = build();
        await service.setForUser(OWNER, { scopeType: 'work', scopeId: WORK_ID, mode: 'cloud' });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            action: 'execution-preference.set',
            actorUserId: OWNER,
            ownerUserId: OWNER,
            // A routing preference is an owner-level decision, not a
            // per-machine one.
            nodeId: null,
            after: { mode: 'cloud' },
            extra: { scopeType: 'work', scopeId: WORK_ID },
        });
    });

    it('records the previous mode as `before` when one existed', async () => {
        const { service, rows } = build();
        await service.setForUser(OWNER, { scopeType: 'user', mode: 'cloud' });
        await service.setForUser(OWNER, { scopeType: 'user', mode: 'local-wait' });

        expect(rows).toHaveLength(2);
        expect(rows[1].before).toEqual({ mode: 'cloud' });
        expect(rows[1].after).toEqual({ mode: 'local-wait' });
    });

    it('records a clear even when there was nothing to remove', async () => {
        const { service, rows } = build();
        await service.clearForUser(OWNER, 'user');

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            action: 'execution-preference.clear',
            actorUserId: OWNER,
            after: null,
            extra: { scopeType: 'user', scopeId: null, existed: false },
        });
    });

    it('writes nothing when validation refuses the request', async () => {
        const { service, rows } = build();
        await expect(
            service.setForUser(OWNER, { scopeType: 'work', mode: 'cloud' }),
        ).rejects.toThrow();
        expect(rows).toHaveLength(0);
    });
});

describe('FleetAgentNodeAffinityService audit', () => {
    function build(existing: { nodeId: string } | null = null) {
        const rows: AuditRow[] = [];
        let bound = existing;
        const affinities = {
            findForAgent: jest.fn(async () => bound),
            upsert: jest.fn(async (input: { nodeId: string }) => {
                bound = { nodeId: input.nodeId };
                return { id: 'aff-1', ...input };
            }),
            remove: jest.fn(async () => {
                const had = bound !== null;
                bound = null;
                return had;
            }),
        };
        const agents = {
            findOne: jest.fn(async () => ({
                id: AGENT_ID,
                userId: OWNER,
                organizationId: ORGANIZATION,
            })),
        };
        const nodes = { findById: jest.fn(async () => node()) };
        const audit = {
            recordNodeAction: jest.fn(async (input: AuditRow) => {
                rows.push(input);
                return true;
            }),
        };
        const service = new FleetAgentNodeAffinityService(
            affinities as never,
            agents as never,
            nodes as never,
            audit as never,
        );
        return { service, rows };
    }

    it('records the affinity target as the row’s node id', async () => {
        const { service, rows } = build();
        await service.setAffinity({
            userId: OWNER,
            organizationId: ORGANIZATION,
            agentId: AGENT_ID,
            nodeId: NODE_ID,
        });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            action: 'affinity.set',
            actorUserId: OWNER,
            ownerUserId: OWNER,
            // The machine the Agent is now pinned to — which is what makes
            // the binding show up in THAT node's history.
            nodeId: NODE_ID,
            before: null,
            after: { nodeId: NODE_ID },
            extra: { agentId: AGENT_ID, organizationId: ORGANIZATION },
        });
    });

    it('records a clear against the node the Agent WAS pinned to', async () => {
        const { service, rows } = build({ nodeId: NODE_ID });
        await service.clearAffinity({
            userId: OWNER,
            organizationId: ORGANIZATION,
            agentId: AGENT_ID,
        });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            action: 'affinity.clear',
            nodeId: NODE_ID,
            before: { nodeId: NODE_ID },
            after: null,
            extra: { cleared: true },
        });
    });

    it('writes nothing when the Agent is not the caller’s', async () => {
        const { service, rows } = build();
        await expect(
            service.setAffinity({
                userId: OWNER,
                organizationId: undefined,
                agentId: AGENT_ID,
                nodeId: NODE_ID,
            }),
        ).rejects.toThrow();
        expect(rows).toHaveLength(0);
    });
});

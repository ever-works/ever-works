import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { UnauthorizedException } from '@nestjs/common';
import {
    FLEET_DEFAULT_MIN_NODE_VERSION,
    isFleetNodeVersionBelowFloor,
} from '@ever-works/contracts';
import { FleetJobService, FleetService } from '@ever-works/agent/fleet';
import { FleetController } from '../fleet.controller';
import { FleetJobsController } from '../fleet-jobs.controller';
import { checkResponse, loadBaseline, type ShapeVerdict } from './node-contract.harness';

/**
 * NODE↔PLATFORM CONFORMANCE — the daemon version floor (self-build slice AR).
 *
 * Lives beside `node-contract.conformance.spec.ts` and is matched by the
 * same gate pattern (`fleet/__tests__/node-contract`), so it runs in the
 * node-contract job on every PR and in front of every promotion.
 *
 * Everything asserted here comes out of the pinned fixture's `versionFloor`
 * block, read with `readFileSync` and never imported, and is checked against
 * the REAL handlers over the REAL services — the same posture as the main
 * suite: a conformance check that compares the platform with itself proves
 * nothing.
 *
 * The one pin that matters most is the shape of the refusal. A below-floor
 * node must be answered `200 {jobs: [], upgradeRequired: true, ...}` and
 * never a 401: the node reads a lease 401 as a revoked credential and makes
 * it sticky, so an auth-shaped refusal would turn a reversible floor into a
 * fleet-wide re-enrollment.
 */

const baseline = loadBaseline();
const floor = baseline.versionFloor;

const NODE_ID = '3f7f5b3a-6c1d-4a0e-9d7c-1b2e5a8f4c31';
const OWNER = '7b6a5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';
const SECRET = 'n0d3-s3cr3t-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const sha256Hex = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex');

function assertShape(verdict: ShapeVerdict, headline: string): void {
    if (!verdict.ok) {
        throw new Error(
            [`${headline} — ${verdict.route}`, ...verdict.problems.map((p) => `  ${p}`)].join('\n'),
        );
    }
}

function nodeRow(version: string | null) {
    return {
        id: NODE_ID,
        userId: OWNER,
        organizationId: null,
        name: 'build-box-01',
        kind: 'node',
        status: 'online',
        enrollmentTokenHash: sha256Hex(SECRET),
        capabilities: ['workspace'],
        capabilitiesPinned: false,
        version,
        lastHeartbeatAt: new Date('2026-09-05T09:01:00.000Z'),
        createdAt: new Date('2026-09-05T09:00:00.000Z'),
        previousCredentialHash: null,
        previousCredentialExpiresAt: null,
        rotationRequestedAt: null,
    };
}

/** The real lease handler over the real job service; one queued job it would otherwise hand out. */
function realJobsController(version: string | null) {
    const job = {
        id: 'b1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
        userId: OWNER,
        organizationId: null,
        nodeId: null,
        targetNodeId: null,
        kind: 'agent-task',
        status: 'queued',
        payload: { runId: '9c8b7a6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d' },
        requiredCapabilities: ['workspace'],
        leaseExpiresAt: null,
        attempts: 0,
        maxAttempts: 3,
        createdAt: new Date('2026-09-05T09:00:00.000Z'),
        queuedAt: new Date('2026-09-05T09:00:00.000Z'),
        leaseGeneration: 0,
    };
    const claim = jest.fn(async () => true);
    const jobs = {
        findExpiredLeases: async () => [],
        findQueuedOlderThan: async () => [],
        findQueuedForNode: async () => [job],
        claim,
    };
    const service = new FleetJobService(
        jobs as never,
        { findById: async (id: string) => (id === NODE_ID ? nodeRow(version) : null) } as never,
        { findForOwnedAgent: async () => null } as never,
    );
    const refuse = async () => {
        throw new Error('the lease route must not reach this collaborator');
    };
    const controller = new FleetJobsController(
        service,
        { resolve: refuse } as never,
        { mint: refuse, revokeForNode: refuse } as never,
        { mint: refuse } as never,
    );
    return { controller, claim };
}

/** The real heartbeat handler over the real registry service. */
function realFleetController(version: string | null) {
    const service = new FleetService({
        findById: async (id: string) => (id === NODE_ID ? nodeRow(version) : null),
        update: async () => undefined,
    } as never);
    return new FleetController(
        service,
        { promoteWaitingForNode: async () => undefined } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
    );
}

const ORIGINAL_FLOOR = process.env.FLEET_MIN_NODE_VERSION;
afterEach(() => {
    if (ORIGINAL_FLOOR === undefined) delete process.env.FLEET_MIN_NODE_VERSION;
    else process.env.FLEET_MIN_NODE_VERSION = ORIGINAL_FLOOR;
});

describe('the pinned version-floor block itself', () => {
    it('pins a known number of read fields and verbs (anti-vacuity)', () => {
        expect(floor.heartbeatResponseFields).toHaveLength(2);
        expect(floor.leaseResponseFields).toHaveLength(3);
        expect(floor.gatedVerbs).toEqual(['jobs-lease']);
        expect([...floor.ungatedVerbs].sort()).toEqual([
            'heartbeat',
            'jobs-complete',
            'jobs-heartbeat',
        ]);
    });

    it('the shipped default admits every daemon the fixture says has shipped', () => {
        expect(FLEET_DEFAULT_MIN_NODE_VERSION).toBe(floor.defaultMinNodeVersion);
        for (const shipped of floor.admittedByDefault) {
            expect(isFleetNodeVersionBelowFloor(shipped, FLEET_DEFAULT_MIN_NODE_VERSION)).toBe(
                false,
            );
        }
    });

    it('the refusal is the kill-switch shape plus the two keys, and a 200', () => {
        expect(floor.leaseWhenBelowFloor.status).toBe(baseline.routes['jobs-lease'].successStatus);
        expect(floor.leaseWhenBelowFloor.body).toEqual({
            ...baseline.killSwitch.leaseWhenStopped.body,
            upgradeRequired: true,
            minNodeVersion: floor.leaseWhenBelowFloor.minNodeVersion,
        });
        assertShape(
            checkResponse(
                'jobs-lease (below floor)',
                floor.leaseWhenBelowFloor.body,
                floor.leaseResponseFields,
            ),
            'NODE CONTRACT BROKEN — THE PINNED REFUSAL IS NOT WHAT A NODE READS',
        );
    });
});

describe('the real handlers (slice AR)', () => {
    it('a below-floor node is answered 200 with the pinned refusal — never a 401 — and nothing is claimed', async () => {
        process.env.FLEET_MIN_NODE_VERSION = floor.leaseWhenBelowFloor.minNodeVersion;
        const { controller, claim } = realJobsController(floor.leaseWhenBelowFloor.reportedVersion);

        let answer: unknown;
        try {
            answer = await controller.lease({ nodeId: NODE_ID, secret: SECRET } as never);
        } catch (error) {
            throw new Error(
                [
                    'NODE CONTRACT BROKEN — A BELOW-FLOOR NODE IS REFUSED BY THROWING',
                    '  The pinned answer is 200 {jobs: [], upgradeRequired: true, minNodeVersion}.',
                    '  A 401 here is read by every node as a revoked credential (sticky, operator-visible):',
                    '  a reversible version floor would become a fleet-wide re-enrollment.',
                    `  it threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
                ].join('\n'),
            );
        }
        expect(answer).toEqual(floor.leaseWhenBelowFloor.body);
        expect(claim).not.toHaveBeenCalled();
    });

    it('a node at or above the floor leases normally, with the exact pinned key set', async () => {
        process.env.FLEET_MIN_NODE_VERSION = floor.leaseWhenBelowFloor.minNodeVersion;
        const { controller, claim } = realJobsController(floor.leaseWhenBelowFloor.minNodeVersion);
        const answer = (await controller.lease({ nodeId: NODE_ID, secret: SECRET } as never)) as {
            jobs: unknown[];
        };
        expect(answer.jobs).toHaveLength(1);
        expect(Object.keys(answer)).toEqual(['jobs']);
        expect(claim).toHaveBeenCalledTimes(1);
    });

    it('a bad credential is STILL a 401 below the floor — the two answers never merge', async () => {
        process.env.FLEET_MIN_NODE_VERSION = floor.leaseWhenBelowFloor.minNodeVersion;
        const { controller } = realJobsController(floor.leaseWhenBelowFloor.reportedVersion);
        await expect(
            controller.lease({ nodeId: NODE_ID, secret: 'wrong-secret-wrong-secret' } as never),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('the real heartbeat is ACCEPTED below the floor and carries every field the node reads', async () => {
        process.env.FLEET_MIN_NODE_VERSION = floor.heartbeatWhenBelowFloor.minNodeVersion;
        const answer = await realFleetController(null).heartbeat({
            nodeId: NODE_ID,
            secret: SECRET,
            version: floor.heartbeatWhenBelowFloor.reportedVersion,
        } as never);

        assertShape(
            checkResponse(
                'heartbeat (real handler, below floor)',
                answer,
                floor.heartbeatResponseFields,
            ),
            'NODE CONTRACT BROKEN — THE PLATFORM NO LONGER EMITS WHAT A NODE READS',
        );
        expect(answer.minNodeVersion).toBe(floor.heartbeatWhenBelowFloor.minNodeVersion);
        expect(answer.upgradeRequired).toBe(floor.heartbeatWhenBelowFloor.upgradeRequired);
    });

    it('the real heartbeat carries the default floor, not a refusal, for a shipped daemon', async () => {
        delete process.env.FLEET_MIN_NODE_VERSION;
        const answer = await realFleetController('0.2.0').heartbeat({
            nodeId: NODE_ID,
            secret: SECRET,
        } as never);
        expect(answer.minNodeVersion).toBe(floor.defaultMinNodeVersion);
        expect(answer.upgradeRequired).toBe(false);
    });
});

describe('the floor gates the lease and nothing else', () => {
    const serviceLines = readFileSync(
        resolve(__dirname, '../../../../../packages/agent/src/fleet/fleet-job.service.ts'),
        'utf8',
    ).split(/\r?\n/);
    const MEMBER = /^ {4}(?:public |private |protected )?(?:async )?([A-Za-z_]\w*)\s*\(/;
    const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'do']);
    const enclosingMember = (index: number): string | null => {
        for (let cursor = index; cursor >= 0; cursor -= 1) {
            const match = MEMBER.exec(serviceLines[cursor]);
            if (match && !CONTROL.has(match[1])) return match[1];
        }
        return null;
    };

    it('is consulted by lease alone, and AFTER the credential check', () => {
        const consulted = new Set(
            serviceLines
                .map((line, index) => ({ line, index }))
                .filter((entry) => entry.line.includes('isFleetNodeVersionBelowFloor('))
                .map((entry) => enclosingMember(entry.index)),
        );
        expect([...consulted]).toEqual(['lease']);

        const leaseStart = serviceLines.findIndex((line) => /^ {4}async lease\(/.test(line));
        const authAt = serviceLines.findIndex(
            (line, index) => index > leaseStart && line.includes('await this.authenticateNode('),
        );
        const floorAt = serviceLines.findIndex(
            (line, index) => index > leaseStart && line.includes('isFleetNodeVersionBelowFloor('),
        );
        expect(authAt).toBeGreaterThan(leaseStart);
        expect(floorAt).toBeGreaterThan(authAt);
    });
});

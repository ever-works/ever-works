import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    BadRequestException,
    NotFoundException,
    ParseUUIDPipe,
    RequestMethod,
    UnauthorizedException,
    type ArgumentMetadata,
    type ExecutionContext,
} from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { getMetadataStorage } from 'class-validator';
import { FLEET_JOB_STALE_LEASE_REASON } from '@ever-works/contracts';
import {
    FleetJobService,
    FleetJobStaleLeaseError,
    FleetService,
    type FleetJob,
    type FleetNode,
} from '@ever-works/agent/fleet';
import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator';
import {
    EnrollFleetNodeDto,
    FleetHeartbeatDto,
    FleetNodePauseDto,
    FleetNodeSelfDescriptionDto,
    FleetUnenrollDto,
} from '../dto/fleet.dto';
import { CompleteFleetJobDto, FleetJobHeartbeatDto, LeaseFleetJobsDto } from '../dto/fleet-job.dto';
import { FleetController } from '../fleet.controller';
import { FleetJobsController } from '../fleet-jobs.controller';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import {
    FLEET_NODE_UNAUTHORIZED_MESSAGE,
    FleetNodeAuthGuard,
} from '../guards/fleet-node-auth.guard';
import {
    checkRequest,
    checkResponse,
    checkStatus,
    formatVerdict,
    loadBaseline,
    type ContractRoute,
    type ShapeVerdict,
} from './node-contract.harness';

/**
 * NODE↔PLATFORM CONFORMANCE SUITE — the promotion gate for the self-hosting
 * fleet (EW-779, self-build finding OPS-21).
 *
 * WHAT THIS PROTECTS. Six PCs build the platform that dispatches those six
 * PCs. A regression in `/api/fleet/jobs/lease`, the heartbeat DTO or the
 * reconciler takes all of them out at once — and the fix then has to travel
 * develop → stage → main through `k8s-build`, measured at 215-243 minutes with
 * `cancel-in-progress: false`, on the machines that just stopped. This suite
 * exists so that failure is caught in front of a promotion instead of after
 * one.
 *
 * WHY THE EXPECTATIONS ARE LITERAL JSON AND NOT DERIVED FROM THE DTOs.
 * Importing the platform's own DTO classes and asserting they match themselves
 * proves nothing: it is green on every change, including the ones that brick
 * the fleet. The value of a conformance suite is that it encodes what a
 * DEPLOYED node sends and reads, independently of the source under test. So
 * every body, every response and every status code below comes out of
 * `packages/contracts/fixtures/fleet-node-contract.v1.json`, read with
 * `readFileSync` and never imported — transcribed by hand from the node's own
 * client code and the live-stack e2e specs. The DTO classes appear here only
 * as the thing being *judged*: the spec hands the harness a metatype, the
 * fixture hands it a body, and nothing lets TypeScript reconcile the two.
 *
 * THE THREE WORKED EXAMPLES this had to be able to catch, all shipped within a
 * day of each other:
 *   T   (EW-777) added `modelIdentity` to the self-description → the
 *       "baseline bodies still validate" and "self-description key sets agree"
 *       cases below.
 *   AN  (EW-792) made `leaseGeneration` REQUIRED on job heartbeat + complete →
 *       the `reject:platform-too-new` pins, which document the known one-way
 *       break instead of hiding it.
 *   V   (EW-778) made every lease answer empty while the global stop flag is
 *       set → the "a stopped fleet answers 200 {jobs: []}" case.
 *
 * The bite proof — that this suite actually fails when the contract breaks —
 * is `node-contract.harness.spec.ts`. The client half lives in
 * `apps/node/src/core/node-contract.conformance.spec.ts`.
 */

const baseline = loadBaseline();

/**
 * The DTO each pinned route validates with. Supplied by the spec, not by the
 * fixture: the fixture must stay free of anything the compiler could use to
 * reconcile it with a changed DTO.
 */
const DTO_FOR_ROUTE: Record<string, unknown> = {
    enroll: EnrollFleetNodeDto,
    heartbeat: FleetHeartbeatDto,
    pause: FleetNodePauseDto,
    unenroll: FleetUnenrollDto,
    'jobs-lease': LeaseFleetJobsDto,
    'jobs-heartbeat': FleetJobHeartbeatDto,
    'jobs-complete': CompleteFleetJobDto,
};

/** The handler each pinned route is served by, for the routing/status metadata. */
const HANDLER_FOR_ROUTE: Record<string, { controller: unknown; handler: unknown }> = {
    enroll: { controller: FleetController, handler: FleetController.prototype.enroll },
    heartbeat: { controller: FleetController, handler: FleetController.prototype.heartbeat },
    pause: { controller: FleetController, handler: FleetController.prototype.pause },
    unenroll: { controller: FleetController, handler: FleetController.prototype.unenroll },
    'jobs-lease': { controller: FleetJobsController, handler: FleetJobsController.prototype.lease },
    'jobs-heartbeat': {
        controller: FleetJobsController,
        handler: FleetJobsController.prototype.heartbeat,
    },
    'jobs-complete': {
        controller: FleetJobsController,
        handler: FleetJobsController.prototype.complete,
    },
};

const routeKeys = Object.keys(baseline.routes);
const routeOf = (key: string): ContractRoute => baseline.routes[key];

/** Flatten the fixture into one case per (route, request variant). */
const requestCases = routeKeys.flatMap((key) =>
    Object.entries(baseline.routes[key].requests).map(([variant, fixture]) => ({
        key,
        variant,
        fixture,
    })),
);

function assertShape(verdict: ShapeVerdict, headline: string): void {
    if (!verdict.ok) {
        throw new Error(
            [`${headline} — ${verdict.route}`, ...verdict.problems.map((p) => `  ${p}`)].join('\n'),
        );
    }
}

describe('fleet node contract — the wire a deployed node actually speaks', () => {
    it('pins every node-facing route (adding one to the fixture without wiring it fails here)', () => {
        expect([...routeKeys].sort()).toEqual(Object.keys(DTO_FOR_ROUTE).sort());
        expect([...routeKeys].sort()).toEqual(Object.keys(HANDLER_FOR_ROUTE).sort());
    });

    it('pins a known NUMBER of routes, request variants and read fields', () => {
        // ANTI-VACUITY. Every `it.each` below is driven by the fixture, so an
        // emptied or thinned fixture removes test cases rather than failing
        // any: delete `heartbeat.requests.legacy` — the single most important
        // body in the file, the shape every not-yet-upgraded machine in the
        // fleet is sending right now — and without this the suite stays green
        // with one fewer case. `checkResponse` likewise returns ok on an empty
        // field list, so a route whose `nodeReadsResponseFields` was emptied
        // would pass its response case vacuously.
        //
        // The counts are literals HERE, in the source, not in the fixture:
        // shrinking the contract has to be done in two places, one of which a
        // reviewer is looking at.
        expect(routeKeys).toHaveLength(7);
        expect(requestCases).toHaveLength(16);

        const variantsPerRoute = Object.fromEntries(
            routeKeys.map((key) => [key, Object.keys(baseline.routes[key].requests).length]),
        );
        expect(variantsPerRoute).toEqual({
            enroll: 3,
            heartbeat: 3,
            pause: 2,
            unenroll: 1,
            'jobs-lease': 2,
            'jobs-heartbeat': 2,
            'jobs-complete': 3,
        });

        // `unenroll` is the one deliberate zero: the node discards that body
        // entirely and only the 2xx matters, which the fixture records as an
        // explicit `nodeIgnoresResponseFields` note rather than an oversight.
        const readFieldsPerRoute = Object.fromEntries(
            routeKeys.map((key) => [key, baseline.routes[key].nodeReadsResponseFields.length]),
        );
        expect(readFieldsPerRoute).toEqual({
            enroll: 3,
            heartbeat: 1,
            pause: 1,
            unenroll: 0,
            'jobs-lease': 6,
            'jobs-heartbeat': 3,
            'jobs-complete': 1,
        });
        expect(baseline.routes.unenroll.nodeIgnoresResponseFields).toHaveLength(1);
    });

    it('pins the exact global ValidationPipe options the deployment runs', () => {
        // If main.ts ever drops `forbidNonWhitelisted`, an unknown field stops
        // being a 400 and starts being a silent drop — and half of what this
        // suite asserts becomes untrue without a single case going red. The
        // fixture records the triple; this asserts main.ts still has it.
        const mainSource = readFileSync(resolve(__dirname, '../../main.ts'), 'utf8');
        const block = mainSource.slice(
            mainSource.indexOf('new ValidationPipe({'),
            mainSource.indexOf('new ValidationPipe({') + 200,
        );
        for (const [option, value] of Object.entries(baseline.globalValidationPipe)) {
            if (option.startsWith('_')) continue;
            expect(block).toContain(`${option}: ${String(value)}`);
        }
    });

    it('leaves the job work channel at exactly three node verbs', () => {
        // A fourth verb on the node channel is a contract change nobody would
        // otherwise notice until a node met a platform that did not have it.
        const declared = Object.getOwnPropertyNames(FleetJobsController.prototype)
            .filter((name) => name !== 'constructor')
            .filter((name) =>
                Boolean(
                    Reflect.getMetadata(
                        PATH_METADATA,
                        FleetJobsController.prototype[name] as object,
                    ),
                ),
            );
        expect(declared.sort()).toEqual(['complete', 'heartbeat', 'lease']);
    });

    it('keeps every node-facing fleet route @Public() — a node has no session to present', () => {
        for (const key of routeKeys) {
            const { handler } = HANDLER_FOR_ROUTE[key];
            expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler as object)).toBe(true);
        }
    });
});

describe('request bodies a deployed node sends', () => {
    it.each(requestCases.map((entry) => [`${entry.key} / ${entry.variant}`, entry] as const))(
        '%s',
        async (_name, entry) => {
            const route = routeOf(entry.key);
            const verdict = await checkRequest(
                entry.key,
                entry.variant,
                entry.fixture.body,
                DTO_FOR_ROUTE[entry.key],
            );

            if (entry.fixture.expect === 'accept') {
                if (verdict.direction !== 'ok') {
                    throw new Error(formatVerdict(verdict, route));
                }
                return;
            }

            // A rejection we have chosen to PIN rather than fix. The direction
            // is part of the pin: the day this stops being `platform-too-new`
            // it has become a different break and needs looking at.
            const expectedDirection = entry.fixture.expect.replace(/^reject:/, '');
            expect(verdict.direction).toBe(expectedDirection);
            expect(verdict.fields).toContain(entry.fixture.expectMentions);
        },
    );

    it.each(routeKeys)(
        '%s rejects an undeclared field with 400 "property X should not exist"',
        async (key) => {
            // The `forbidNonWhitelisted` pin. Without it a node one release
            // AHEAD of the platform would have its new field silently dropped
            // and believe it had been stored.
            const probe = baseline.unknownFieldProbe;
            const accepted = Object.values(baseline.routes[key].requests).find(
                (fixture) => fixture.expect === 'accept',
            );
            expect(accepted).toBeDefined();

            const verdict = await checkRequest(
                key,
                'unknown-field-probe',
                { ...accepted.body, [probe]: 'x' },
                DTO_FOR_ROUTE[key],
            );
            expect(verdict.direction).toBe('node-too-old');
            expect(verdict.fields).toContain(probe);
            expect(verdict.messages).toContain(`property ${probe} should not exist`);
        },
    );
});

describe('the self-description key set (slice T / EW-777)', () => {
    const declared = [
        ...new Set(
            getMetadataStorage()
                .getTargetValidationMetadatas(FleetNodeSelfDescriptionDto, '', false, false)
                .map((meta) => meta.propertyName),
        ),
    ].sort();

    it('the DTO declares exactly the fields the pinned contract says it does', () => {
        expect(declared).toEqual([...baseline.selfDescription.dtoOptionalKeys].sort());
    });

    it('the node emits exactly the fields the DTO accepts', () => {
        // A field added to the DTO but not to `selfDescription()` in
        // fleet-client.ts is a field the machine computes, logs, and then
        // silently never sends — how cliVersion and diskFreeBytes were first
        // wired at the probe end only. The node-side half of this equality is
        // asserted against the real projection in
        // apps/node/src/core/node-contract.conformance.spec.ts.
        expect([...baseline.selfDescription.nodeEmits].sort()).toEqual(declared);
    });

    it.each(['enroll', 'heartbeat'])(
        'the %s handler forwards every declared field (the explicit mapping is not type-checked)',
        (verb) => {
            // fleet.controller.ts maps the self-description field by field
            // rather than spreading it, on purpose — but that means a field
            // added to the DTO and forgotten in the mapping compiles cleanly
            // and is dropped at runtime. Nothing but this reads it.
            const source = readFileSync(resolve(__dirname, '../fleet.controller.ts'), 'utf8');
            const marker =
                verb === 'enroll'
                    ? 'await this.service.enroll(body.token, {'
                    : 'await this.service.heartbeat(body.nodeId, body.secret, {';
            const start = source.indexOf(marker);
            expect(start).toBeGreaterThan(-1);
            const block = source.slice(start, source.indexOf('});', start));
            const forwarded = [...block.matchAll(/(\w+):\s*body\.(\w+)/g)].map((m) => m[1]).sort();

            expect(forwarded).toEqual(declared);
            expect(forwarded).toEqual(
                [...baseline.selfDescription.controllerForwards[verb]].sort(),
            );
        },
    );
});

describe('response shapes the node dereferences', () => {
    it.each(routeKeys)('%s response carries every field the node reads', (key) => {
        const route = routeOf(key);
        assertShape(
            checkResponse(key, route.response, route.nodeReadsResponseFields),
            'NODE CONTRACT BROKEN — RESPONSE FIELD MISSING OR RETYPED',
        );
    });

    it('a lease that finds nothing is still a well-formed answer for the node', () => {
        // job-client.ts hard-throws `malformed` on anything that is not an
        // array, so `jobs` may never become null or be omitted — not for "no
        // work", not for a stopped fleet, not for a drained node.
        const route = routeOf('jobs-lease');
        assertShape(
            checkResponse(
                'jobs-lease (empty)',
                route.emptyResponse,
                route.nodeReadsResponseFields.filter((field) => field.path === 'jobs'),
            ),
            'NODE CONTRACT BROKEN — EMPTY LEASE IS NOT WELL-FORMED',
        );
        expect(route.emptyResponse.jobs).toEqual([]);
    });

    it('the leased view carries a usable leaseGeneration (slice AN / EW-792)', () => {
        // The ONLY reason a required request field is survivable is that the
        // lease mints one. `toJobView` emits `job.leaseGeneration ?? 0`, and
        // `isCurrentLeaseGeneration` refuses 0 — so a backfilled row costs one
        // attempt by design. Pinned so nobody "fixes" it by omitting the key,
        // which would cost EVERY attempt.
        const jobs = routeOf('jobs-lease').response.jobs as Array<{ leaseGeneration?: number }>;
        expect(jobs.length).toBeGreaterThan(0);
        for (const job of jobs) {
            expect(typeof job.leaseGeneration).toBe('number');
            expect(job.leaseGeneration).toBeGreaterThanOrEqual(1);
        }
    });
});

describe('status codes a node branches on', () => {
    it.each(routeKeys)('%s is served at the pinned method, path and success status', (key) => {
        const route = routeOf(key);
        const { controller, handler } = HANDLER_FOR_ROUTE[key];

        const controllerPath = Reflect.getMetadata(PATH_METADATA, controller as object) as string;
        const handlerPath = Reflect.getMetadata(PATH_METADATA, handler as object) as string;
        const method = Reflect.getMetadata(METHOD_METADATA, handler as object) as RequestMethod;
        const httpCode = Reflect.getMetadata(HTTP_CODE_METADATA, handler as object) as number;

        expect(RequestMethod[method]).toBe(route.method);
        expect(`/${controllerPath}/${handlerPath}`).toBe(route.path);
        assertShape(checkStatus(key, route.successStatus, httpCode), 'NODE CONTRACT BROKEN');
    });

    it('a disabled deployment answers 404, not 403 (and the node has no 404 branch)', () => {
        // 404 is deliberate: `/api/fleet/**` must look like a route that was
        // never mounted. The cost is that the node collapses it to
        // `invalid-request`, indistinguishable from a typo in the API URL —
        // which is why it is in the break-glass runbook's triage table.
        const previous = process.env.FLEET_ENABLED;
        process.env.FLEET_ENABLED = 'false';
        try {
            let thrown: unknown;
            try {
                new FleetEnabledGuard().canActivate();
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBeInstanceOf(NotFoundException);
            expect((thrown as NotFoundException).getStatus()).toBe(
                baseline.platformStatusCodes.fleetDisabled.status,
            );
        } finally {
            if (previous === undefined) {
                delete process.env.FLEET_ENABLED;
            } else {
                process.env.FLEET_ENABLED = previous;
            }
        }
    });

    it('a refused node credential is one undifferentiated 401 with one message', async () => {
        const guard = new FleetNodeAuthGuard({ findById: async () => null } as never);
        const context = {
            switchToHttp: () => ({
                getRequest: () => ({ body: { nodeId: 'not-a-uuid', secret: 'too-short' } }),
            }),
        } as unknown as ExecutionContext;

        await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
        await guard.canActivate(context).catch((error: UnauthorizedException) => {
            expect(error.getStatus()).toBe(baseline.platformStatusCodes.badNodeCredential.status);
            expect(error.message).toBe(baseline.platformStatusCodes.badNodeCredential.message);
            expect(error.message).toBe(FLEET_NODE_UNAUTHORIZED_MESSAGE);
        });
    });

    it('a stale lease generation is 409 with the stable reason token', () => {
        const error = new FleetJobStaleLeaseError();
        const body = error.getResponse() as { statusCode: number; reason: string };
        expect(error.getStatus()).toBe(baseline.platformStatusCodes.staleLease.status);
        expect(body.reason).toBe(baseline.platformStatusCodes.staleLease.reason);
        // The node keys its abort on the STATUS; the token is what every other
        // consumer keys on. Both are contract.
        expect(body.reason).toBe(FLEET_JOB_STALE_LEASE_REASON);
    });

    it('a non-uuid job id is refused with 400 before any handler runs', async () => {
        const pipe = new ParseUUIDPipe();
        const metadata = { type: 'param', data: 'id' } as unknown as ArgumentMetadata;
        let thrown: unknown;
        try {
            await pipe.transform('../../etc/passwd', metadata);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(BadRequestException);
        expect((thrown as BadRequestException).getStatus()).toBe(
            baseline.platformStatusCodes.nonUuidJobId.status,
        );
    });
});

describe('the global stop flag empties the lease, it never refuses it (slice V / EW-778)', () => {
    const servicePath = resolve(
        __dirname,
        '../../../../../packages/agent/src/fleet/fleet-job.service.ts',
    );
    const serviceLines = readFileSync(servicePath, 'utf8').split(/\r?\n/);

    const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'do']);
    const MEMBER = /^ {4}(?:public |private |protected )?(?:async )?([A-Za-z_]\w*)\s*\(/;

    /** The class member a given line sits inside. */
    function enclosingMember(lineIndex: number): string | null {
        for (let cursor = lineIndex; cursor >= 0; cursor -= 1) {
            const match = MEMBER.exec(serviceLines[cursor]);
            if (match && !CONTROL_KEYWORDS.has(match[1])) {
                return match[1];
            }
        }
        return null;
    }

    it('the stop flag is consulted by lease and by nothing else', () => {
        // Gating heartbeat or complete would mean in-flight work could never
        // settle, so a cancel-in-flight during a stop could never resolve. And
        // gating BEFORE auth would make "stopped" and "bad credential" the same
        // answer, which is the reconnaissance leak the 401 posture exists to
        // prevent.
        const consulted = new Set(
            serviceLines
                .map((line, index) => ({ line, index }))
                .filter((entry) => entry.line.includes('this.killSwitch'))
                .map((entry) => enclosingMember(entry.index)),
        );
        expect([...consulted]).toEqual(['lease']);
        expect(baseline.killSwitch.gatedVerbs).toEqual(['jobs-lease']);
        expect([...baseline.killSwitch.ungatedVerbs].sort()).toEqual([
            'jobs-complete',
            'jobs-heartbeat',
        ]);
        expect([...consulted]).not.toContain('heartbeatJob');
        expect([...consulted]).not.toContain('completeJob');
    });

    it('the flag is read AFTER the credential check, so a stop is never a 401', () => {
        const leaseStart = serviceLines.findIndex((line) => /^ {4}async lease\(/.test(line));
        const authAt = serviceLines.findIndex(
            (line, index) => index > leaseStart && line.includes('await this.authenticateNode('),
        );
        const flagAt = serviceLines.findIndex(
            (line, index) => index > leaseStart && line.includes('this.killSwitch.isStopped()'),
        );
        expect(leaseStart).toBeGreaterThan(-1);
        expect(authAt).toBeGreaterThan(leaseStart);
        expect(flagAt).toBeGreaterThan(authAt);
    });

    it('a stopped fleet answers 200 with an empty list', () => {
        // The pin that matters most. job-client.ts maps a 401 on lease to a
        // revoked credential, and heartbeat.ts makes `unauthorized` STICKY and
        // operator-visible — so answering 401/403/503 here would turn one
        // reversible global stop into a fleet-wide re-enrollment.
        expect(baseline.killSwitch.leaseWhenStopped.status).toBe(
            routeOf('jobs-lease').successStatus,
        );
        expect(baseline.killSwitch.leaseWhenStopped.body).toEqual({ jobs: [] });
    });
});

// ---------------------------------------------------------------------------
// THE HALF THAT IS NOT ALLOWED TO BE FIXTURE-VS-FIXTURE.
//
// Everything above judges the platform's REQUEST side (real DTOs, real pipe)
// and the fixture's own internal consistency. That is not enough for the
// RESPONSE side: `checkResponse(route.response, route.nodeReadsResponseFields)`
// compares one half of the fixture against the other half of the same fixture,
// so it is green no matter what the platform actually emits. Delete
// `leaseGeneration` from `toJobView` and every case above still passes — and
// that one deleted response field 400s every job heartbeat in the fleet,
// because the DTO consuming it is REQUIRED (EW-792).
//
// So this section drives the REAL handlers — the real `FleetJobsController`
// over a real `FleetJobService` over the real `toJobView`, and the real
// `FleetService.toView` — and judges what comes out against the SAME pinned
// field list. The expectation still comes from the fixture; only the subject
// is now the platform instead of the fixture.
//
// The stubs below are repositories and ports, never serializers: nothing that
// shapes a wire body is faked.
// ---------------------------------------------------------------------------

const REAL_NODE_ID = '11111111-1111-4111-8111-111111111111';
const REAL_JOB_ID = '55555555-5555-4555-8555-555555555555';
const REAL_OWNER = 'owner-under-test';

const sha256Hex = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * A real `FleetJobsController` with real service logic behind it.
 *
 * Mirrors the construction in
 * `packages/agent/src/fleet/__tests__/fleet-job.kill-switch.spec.ts` so the two
 * cannot drift: repositories are stubs, the service and the controller are the
 * shipping classes.
 */
function buildRealJobsController(options: { stopped?: boolean } = {}) {
    const secret = randomBytes(24).toString('base64url');
    const job = {
        id: REAL_JOB_ID,
        userId: REAL_OWNER,
        organizationId: null,
        nodeId: null,
        targetNodeId: null,
        kind: 'agent-task',
        status: 'queued',
        payload: { runId: '9c8b7a6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d' },
        requiredCapabilities: [],
        leaseExpiresAt: null,
        attempts: 0,
        maxAttempts: 3,
        idempotencyKey: null,
        result: null,
        error: null,
        queuedReason: null,
        cancelRequestedAt: null,
        startedAt: null,
        completedAt: null,
        createdAt: new Date('2026-09-05T09:00:00.000Z'),
        updatedAt: new Date('2026-09-05T09:00:00.000Z'),
        leaseGeneration: 1,
    } as unknown as FleetJob;

    const jobs = {
        findById: async (id: string) => (id === job.id ? job : null),
        findQueuedForNode: async () => [job],
        claim: async (_id: string, patch: Partial<FleetJob>) => {
            Object.assign(job, patch);
            return true;
        },
        extendLease: async () => true,
        complete: async () => true,
        findExpiredLeases: async () => [],
        // Present so the real queue-SLA scan on the lease path runs to
        // completion instead of being swallowed by its own best-effort
        // try/catch. Without it every case above still passes, but through a
        // logged failure rather than through the code the fleet runs.
        findQueuedOlderThan: async () => [],
    };
    const nodes = {
        findById: async (id: string) =>
            id === REAL_NODE_ID
                ? {
                      id: REAL_NODE_ID,
                      userId: REAL_OWNER,
                      status: 'online',
                      enrollmentTokenHash: sha256Hex(secret),
                      capabilities: ['workspace'],
                  }
                : null,
    };
    const service = new FleetJobService(
        jobs as never,
        nodes as never,
        { findForOwnedAgent: async () => null } as never,
        undefined,
        { isStopped: async () => Boolean(options.stopped) } as never,
    );
    return { controller: new FleetJobsController(service), secret, job };
}

/** The pinned job object a lease answers with, for key-set comparison. */
const pinnedLeasedJob = (routeOf('jobs-lease').response.jobs as Record<string, unknown>[])[0];

describe('the responses the platform ACTUALLY produces (not the ones the fixture says it does)', () => {
    it('the real lease handler emits every field the pinned contract says a node reads', async () => {
        const { controller, secret } = buildRealJobsController();
        const answer = await controller.lease({
            nodeId: REAL_NODE_ID,
            secret,
            max: 1,
        } as never);

        assertShape(
            checkResponse(
                'jobs-lease (real handler)',
                answer,
                routeOf('jobs-lease').nodeReadsResponseFields,
            ),
            'NODE CONTRACT BROKEN — THE PLATFORM NO LONGER EMITS WHAT A NODE READS',
        );
    });

    it('the real leased view has exactly the pinned key set — no field silently added or dropped', async () => {
        // Equality, not superset, and deliberately so. Dropping a key is the
        // outage; ADDING one is a wire-contract change too (the Fleet UI and
        // the desktop shell read this shape), and forcing the fixture to be
        // edited in the same PR is the whole point of pinning it. If this is
        // red because you added a field on purpose: add it to
        // `packages/contracts/fixtures/fleet-node-contract.v1.json` as well.
        const { controller, secret } = buildRealJobsController();
        const answer = (await controller.lease({
            nodeId: REAL_NODE_ID,
            secret,
            max: 1,
        } as never)) as unknown as { jobs: Record<string, unknown>[] };

        expect(answer.jobs).toHaveLength(1);
        expect(Object.keys(answer.jobs[0]).sort()).toEqual(Object.keys(pinnedLeasedJob).sort());
    });

    it('the real lease mints a usable leaseGeneration (slice AN / EW-792)', async () => {
        // The ONLY reason a REQUIRED `leaseGeneration` on job heartbeat and
        // complete is survivable is that the lease mints one >= 1. If
        // `toJobView` ever stops emitting it, `leaseGenerationOf()` returns
        // undefined, `job-client.ts` omits the key, and every beat and every
        // completion in the fleet is 400d — from ONE deleted response field.
        const { controller, secret } = buildRealJobsController();
        const answer = (await controller.lease({
            nodeId: REAL_NODE_ID,
            secret,
            max: 1,
        } as never)) as unknown as { jobs: Array<{ leaseGeneration?: unknown }> };

        expect(typeof answer.jobs[0].leaseGeneration).toBe('number');
        expect(answer.jobs[0].leaseGeneration as number).toBeGreaterThanOrEqual(1);
    });

    it('a STOPPED fleet answers 200 {jobs: []} from the real handler — it never refuses (slice V / EW-778)', async () => {
        // The behavioural pin, as opposed to the fixture-integrity one above.
        // Slice V done slightly wrong — `throw new UnauthorizedException()`,
        // or a 403, or a 503 — would satisfy every fixture assertion in this
        // file and still take the fleet out: `job-client.ts` maps lease-401 to
        // `unauthorized`, and `heartbeat.ts` makes that STICKY and
        // operator-visible, so one reversible global stop becomes a fleet-wide
        // re-enrollment. This is the case that would have caught it.
        const { controller, secret } = buildRealJobsController({ stopped: true });

        let answer: unknown;
        try {
            answer = await controller.lease({ nodeId: REAL_NODE_ID, secret } as never);
        } catch (error) {
            // Say which direction broke, in the terms the runbook uses. A bare
            // `UnauthorizedException` in the log would read as a test-setup
            // problem rather than as the outage it is.
            throw new Error(
                [
                    'NODE CONTRACT BROKEN — A STOPPED FLEET NOW REFUSES THE LEASE',
                    '  POST /api/fleet/jobs/lease answered by THROWING while the global stop flag',
                    '  is set. The pinned contract is 200 {"jobs": []}.',
                    '  job-client.ts maps a lease 4xx to an error kind, and heartbeat.ts makes',
                    '  `unauthorized` STICKY and operator-visible — so this turns one reversible',
                    '  global stop into a fleet-wide re-enrollment on every machine at once.',
                    `  it threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
                ].join('\n'),
            );
        }

        expect(answer).toEqual(baseline.killSwitch.leaseWhenStopped.body);
        expect(answer).toEqual({ jobs: [] });
    });

    it('a bad credential is STILL a 401 while stopped — the two answers never merge', async () => {
        // The other half of the same pin. If a stop made every lease look like
        // a credential failure, an operator could not tell a stopped fleet
        // from a revoked one; if a bad credential started answering `[]`, the
        // 401 posture that keeps node ids unenumerable would be gone.
        const { controller } = buildRealJobsController({ stopped: true });
        await expect(
            controller.lease({ nodeId: REAL_NODE_ID, secret: 'wrong-secret-wrong' } as never),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('the real job heartbeat and complete handlers emit the pinned envelopes', async () => {
        const { controller, secret } = buildRealJobsController();
        const leased = (await controller.lease({
            nodeId: REAL_NODE_ID,
            secret,
            max: 1,
        } as never)) as unknown as { jobs: Array<{ id: string; leaseGeneration: number }> };
        const generation = leased.jobs[0].leaseGeneration;

        const beat = await controller.heartbeat(REAL_JOB_ID, {
            nodeId: REAL_NODE_ID,
            secret,
            leaseTtlSec: 120,
            leaseGeneration: generation,
        } as never);
        assertShape(
            checkResponse(
                'jobs-heartbeat (real handler)',
                beat,
                routeOf('jobs-heartbeat').nodeReadsResponseFields,
            ),
            'NODE CONTRACT BROKEN — THE PLATFORM NO LONGER EMITS WHAT A NODE READS',
        );

        const done = await controller.complete(REAL_JOB_ID, {
            nodeId: REAL_NODE_ID,
            secret,
            success: true,
            leaseGeneration: generation,
            result: { exitCode: 0 },
        } as never);
        assertShape(
            checkResponse(
                'jobs-complete (real handler)',
                done,
                routeOf('jobs-complete').nodeReadsResponseFields,
            ),
            'NODE CONTRACT BROKEN — THE PLATFORM NO LONGER EMITS WHAT A NODE READS',
        );
    });

    it('the real node view carries every field the enroll/heartbeat/pause answers pin', () => {
        // `FleetService.toView` is the one place a node entity becomes a wire
        // view, and it is `private` — reached through the prototype rather than
        // re-implemented here, because a re-implementation would be exactly the
        // self-referential assertion this suite exists to avoid.
        const entity = {
            id: REAL_NODE_ID,
            name: 'build-box-01',
            kind: 'node',
            status: 'online',
            platform: 'linux/x64',
            version: '1.0.0',
            capabilities: ['terminal', 'workspace'],
            lastHeartbeatAt: new Date('2026-09-05T09:01:00.000Z'),
            createdAt: new Date('2026-09-05T09:00:00.000Z'),
            capabilitiesPinned: false,
            cliVersion: '1.4.2',
            diskFreeBytes: 128849018880,
            modelIdentity: 'claude-code: ops@example.com (Acme, max)',
            dailyCostCeilingCents: null,
            dailyCostTrippedOn: null,
        } as unknown as FleetNode;
        const view = (
            FleetService.prototype as unknown as {
                toView(node: FleetNode): Record<string, unknown>;
            }
        ).toView.call(null, entity);

        for (const key of ['heartbeat', 'pause'] as const) {
            assertShape(
                checkResponse(
                    `${key} (real toView)`,
                    { ok: true, node: view },
                    routeOf(key).nodeReadsResponseFields,
                ),
                'NODE CONTRACT BROKEN — THE PLATFORM NO LONGER EMITS WHAT A NODE READS',
            );
        }

        // Superset, not equality: the real view carries fields the node does
        // not read (`persisted`, the cost-ceiling columns) and the fixture
        // pins only the node-facing subset on purpose. What must never happen
        // is a pinned key vanishing from the real view.
        const pinnedNode = routeOf('heartbeat').response.node as Record<string, unknown>;
        expect(Object.keys(view)).toEqual(expect.arrayContaining(Object.keys(pinnedNode)));
    });
});

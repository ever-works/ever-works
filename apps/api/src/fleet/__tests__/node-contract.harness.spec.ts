import 'reflect-metadata';
import {
    IsArray,
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    Max,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';
import {
    EnrollFleetNodeDto,
    FleetHeartbeatDto,
    FleetNodePauseDto,
    FleetUnenrollDto,
} from '../dto/fleet.dto';
import { CompleteFleetJobDto, FleetJobHeartbeatDto, LeaseFleetJobsDto } from '../dto/fleet-job.dto';
import {
    checkRequest,
    checkResponse,
    checkStatus,
    formatVerdict,
    loadBaseline,
    loadBrokenFixture,
} from './node-contract.harness';

/**
 * THE BITE PROOF — does the node-contract gate actually fail?
 *
 * A gate that cannot fail is not a gate. `node-contract.conformance.spec.ts`
 * is green today by construction, which tells you nothing about whether it
 * would go red on the change that takes the fleet out. This file is the
 * answer: it feeds the SAME harness functions deliberately broken material and
 * asserts they report a failure, in the right direction, naming the right
 * field.
 *
 * Two kinds of proof, and both are needed:
 *
 *  1. BROKEN FIXTURES (`fleet-node-contract.broken.json`) — one mutation per
 *     direction per route. Proves the classifier and the shape checks work.
 *
 *  2. BROKEN DTOs, declared right here in the spec — one that makes an
 *     optional field required, one that drops a declared field. These are run
 *     against the REAL, UNMODIFIED baseline bodies. This is the half that
 *     matters: it proves the gate fails on a change to a DTO, not merely on
 *     someone editing a fixture. Slice AN (EW-792) was exactly the first
 *     shape; a rollback of slice T (EW-777) would be exactly the second.
 */

const baseline = loadBaseline();
const broken = loadBrokenFixture();

const DTO_FOR_ROUTE: Record<string, unknown> = {
    enroll: EnrollFleetNodeDto,
    heartbeat: FleetHeartbeatDto,
    pause: FleetNodePauseDto,
    unenroll: FleetUnenrollDto,
    'jobs-lease': LeaseFleetJobsDto,
    'jobs-heartbeat': FleetJobHeartbeatDto,
    'jobs-complete': CompleteFleetJobDto,
};

describe('the gate bites — broken request bodies are caught and correctly directed', () => {
    it('drives a known NUMBER of broken cases in BOTH directions', () => {
        // ANTI-VACUITY, and it matters more here than anywhere else in the
        // suite: this file is the proof that the gate can fail. Every `it.each`
        // below is driven by `fleet-node-contract.broken.json`, so emptying
        // that file removes the proof rather than failing it — and a gate whose
        // bite proof has silently stopped running is indistinguishable from a
        // gate that cannot bite.
        //
        // The counts are literals in the SOURCE, not in the fixture.
        expect(broken.requestCases).toHaveLength(5);
        expect(broken.responseCases).toHaveLength(5);
        expect(broken.statusCases).toHaveLength(3);

        // Both directions must be represented. A broken fixture that only ever
        // exercised `node-too-old` would leave the fleet-wide outage direction
        // — `platform-too-new` — unproven.
        expect(new Set(broken.requestCases.map((entry) => entry.expectDirection))).toEqual(
            new Set(['platform-too-new', 'node-too-old']),
        );
    });

    it.each(broken.requestCases.map((entry) => [entry.name, entry] as const))(
        '%s',
        async (_name, entry) => {
            const verdict = await checkRequest(
                entry.route,
                'broken-fixture',
                entry.body,
                DTO_FOR_ROUTE[entry.route],
            );
            expect(verdict.direction).toBe(entry.expectDirection);
            expect(verdict.fields).toContain(entry.expectMentions);

            // The failure TEXT is part of the contract too: a person reading a
            // red promotion gate at 2am must be told which side moved without
            // having to reconstruct it from a class-validator message.
            const text = formatVerdict(verdict, baseline.routes[entry.route]);
            expect(text).toContain(
                entry.expectDirection === 'platform-too-new' ? 'PLATFORM TOO NEW' : 'NODE TOO OLD',
            );
            expect(text).toContain(entry.expectMentions);
            expect(text).toContain(baseline.routes[entry.route].path);
        },
    );

    it('never passes a rejection it cannot classify', () => {
        // `unclassified` exists so an unrecognised refusal is a FAILURE rather
        // than a quiet pass. Here the pipe complains about a field that IS in
        // the body (a too-short secret), so neither direction applies.
        return checkRequest(
            'heartbeat',
            'unclassifiable',
            {
                nodeId: '3f7f5b3a-6c1d-4a0e-9d7c-1b2e5a8f4c31',
                secret: 'too-short',
            },
            FleetHeartbeatDto,
        ).then((verdict) => {
            expect(verdict.direction).toBe('unclassified');
            expect(formatVerdict(verdict, baseline.routes.heartbeat)).toContain('UNCLASSIFIED');
        });
    });
});

describe('the gate bites — broken responses are caught', () => {
    it.each(broken.responseCases.map((entry) => [entry.name, entry] as const))(
        '%s',
        (_name, entry) => {
            const route = baseline.routes[entry.route];
            const verdict = checkResponse(
                entry.route,
                entry.response,
                route.nodeReadsResponseFields,
            );
            expect(verdict.ok).toBe(false);
            expect(verdict.problems.join('\n')).toContain(entry.expectMentions);
        },
    );

    it('passes the UNBROKEN baseline response for the same routes', () => {
        // The other half of the proof: the checks above must be failing
        // because the material is broken, not because they always fail.
        for (const entry of broken.responseCases) {
            const route = baseline.routes[entry.route];
            expect(
                checkResponse(entry.route, route.response, route.nodeReadsResponseFields).ok,
            ).toBe(true);
        }
    });
});

describe('the gate bites — changed status codes are caught', () => {
    it.each(broken.statusCases.map((entry) => [entry.name, entry] as const))(
        '%s',
        (_name, entry) => {
            const pinned = pinnedStatus(entry.route, entry.pin);
            const verdict = checkStatus(entry.route, pinned, entry.observedStatus);
            expect(verdict.ok).toBe(false);
            expect(verdict.problems.join('\n')).toContain(String(entry.observedStatus));
            expect(verdict.problems.join('\n')).toContain(String(pinned));
        },
    );

    it('passes when the observed code matches the pin', () => {
        for (const entry of broken.statusCases) {
            const pinned = pinnedStatus(entry.route, entry.pin);
            expect(checkStatus(entry.route, pinned, pinned).ok).toBe(true);
        }
    });
});

function pinnedStatus(route: string, pin: string): number {
    if (pin === 'successStatus') {
        return baseline.routes[route].successStatus;
    }
    if (pin === 'leaseWhenStopped') {
        return baseline.killSwitch.leaseWhenStopped.status;
    }
    return baseline.platformStatusCodes[pin].status as number;
}

// ---------------------------------------------------------------------------
// Broken DTOs — the half that proves a SOURCE change is caught, not a fixture
// edit. These classes are local to this spec and are never registered with
// Nest; they exist only to be judged by the same harness the gate runs.
// ---------------------------------------------------------------------------

/**
 * A hypothetical next release of `FleetHeartbeatDto` in which `platform`
 * stopped being optional. This is the EW-792 mistake applied to a field every
 * older node omits: the whole fleet 400s on every beat at once.
 */
class HeartbeatWithNewlyRequiredPlatform {
    @IsUUID()
    nodeId: string;

    @IsString()
    @MinLength(16)
    @MaxLength(256)
    secret: string;

    // The break: no `@IsOptional()`.
    @IsString()
    @MaxLength(64)
    platform: string;

    @IsOptional()
    @IsString()
    @MaxLength(32)
    version?: string;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    capabilities?: string[];

    @IsOptional()
    @IsString()
    @MaxLength(64)
    cliVersion?: string;

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(2 ** 60)
    diskFreeBytes?: number;

    @IsOptional()
    @IsString()
    @MaxLength(200)
    modelIdentity?: string;
}

/**
 * A hypothetical ROLLBACK of slice T (EW-777) that removed `modelIdentity`
 * from the DTO. Every upgraded node keeps sending it, and
 * `forbidNonWhitelisted` turns that into a 400 rather than a silent drop.
 */
class HeartbeatWithoutModelIdentity {
    @IsUUID()
    nodeId: string;

    @IsString()
    @MinLength(16)
    @MaxLength(256)
    secret: string;

    @IsOptional()
    @IsString()
    @MaxLength(64)
    platform?: string;

    @IsOptional()
    @IsString()
    @MaxLength(32)
    version?: string;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    capabilities?: string[];

    @IsOptional()
    @IsString()
    @MaxLength(64)
    cliVersion?: string;

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(2 ** 60)
    diskFreeBytes?: number;

    // The break: `modelIdentity` is gone.
}

describe('the gate bites — a DTO change, judged against the UNMODIFIED pinned bodies', () => {
    it('a newly-required field is reported as platform-too-new', async () => {
        // The pinned body is untouched: this is the legacy heartbeat every
        // not-yet-upgraded machine in the fleet is sending right now.
        const legacy = baseline.routes.heartbeat.requests.legacy;
        expect(legacy.expect).toBe('accept');
        expect(Object.keys(legacy.body)).not.toContain('platform');

        const verdict = await checkRequest(
            'heartbeat',
            'legacy',
            legacy.body,
            HeartbeatWithNewlyRequiredPlatform,
        );
        expect(verdict.direction).toBe('platform-too-new');
        expect(verdict.fields).toContain('platform');

        const text = formatVerdict(verdict, baseline.routes.heartbeat);
        expect(text).toContain('PLATFORM TOO NEW');
        expect(text).toContain('now-required field(s): platform');
        expect(text).toContain('FIX THE PLATFORM');
    });

    it('a dropped field is reported as node-too-old', async () => {
        const current = baseline.routes.heartbeat.requests.current;
        expect(current.expect).toBe('accept');
        expect(Object.keys(current.body)).toContain('modelIdentity');

        const verdict = await checkRequest(
            'heartbeat',
            'current',
            current.body,
            HeartbeatWithoutModelIdentity,
        );
        expect(verdict.direction).toBe('node-too-old');
        expect(verdict.fields).toContain('modelIdentity');

        const text = formatVerdict(verdict, baseline.routes.heartbeat);
        expect(text).toContain('NODE TOO OLD');
        expect(text).toContain('no-longer-declared field(s): modelIdentity');
    });

    it('the same bodies pass against the REAL DTO — the breaks above are the DTOs, not the bodies', async () => {
        for (const variant of ['legacy', 'current'] as const) {
            const verdict = await checkRequest(
                'heartbeat',
                variant,
                baseline.routes.heartbeat.requests[variant].body,
                FleetHeartbeatDto,
            );
            expect(verdict.direction).toBe('ok');
        }
    });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BadRequestException, ValidationPipe, type ArgumentMetadata } from '@nestjs/common';

/**
 * Machinery for the node↔platform conformance suite (EW-779, finding OPS-21).
 *
 * Kept OUT of the spec files on purpose: the conformance suite
 * (`node-contract.conformance.spec.ts`) drives these functions against the
 * pinned contract, and the bite proof (`node-contract.harness.spec.ts`) drives
 * the SAME functions against deliberately broken material. A gate that cannot
 * fail is not a gate, and the only way to prove this one bites is to make it
 * bite on demand — which needs the checks to be callable, not embedded in
 * `it()` blocks.
 *
 * Nothing here derives an expectation from the types under test. Every
 * expectation comes out of a JSON file read with `readFileSync`; see that
 * file's own `_docblock` for why.
 */

/**
 * Mirrors `app.useGlobalPipes(new ValidationPipe({...}))` in
 * `apps/api/src/main.ts`. This exact triple is the whole reason the fleet
 * endpoints have a *wire* contract rather than a type: `whitelist` silently
 * drops an undeclared field, `forbidNonWhitelisted` turns dropping it into a
 * 400 instead, and `transform` is what makes the DTO's coercions real. A
 * conformance check built on any other options is testing a pipe that no
 * deployment runs.
 */
export const GLOBAL_PIPE_OPTIONS = {
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
} as const;

const FIXTURE_DIR = resolve(__dirname, '../../../../../packages/contracts/fixtures');

/** The pinned contract. Read from disk, never imported — see the file's docblock. */
export const BASELINE_FIXTURE_PATH = resolve(FIXTURE_DIR, 'fleet-node-contract.v1.json');

/** Deliberately broken mutations of the baseline; drives the bite proof only. */
export const BROKEN_FIXTURE_PATH = resolve(FIXTURE_DIR, 'fleet-node-contract.broken.json');

/** One request body a deployed node is known to send, and what should happen to it. */
export interface ContractRequestFixture {
    /** `accept`, or `reject:<direction>` for a break we have chosen to pin rather than fix. */
    expect: string;
    /** Field the rejection must name, when `expect` is a rejection. */
    expectMentions?: string;
    note?: string;
    body: Record<string, unknown>;
}

/** One field of a response that some node dereferences, and the type it must have. */
export interface ContractResponseField {
    path: string;
    type: string;
    reader?: string;
    note?: string;
}

export interface ContractRoute {
    method: string;
    path: string;
    dto: string;
    guards: string[];
    pathParamPipe?: string;
    successStatus: number;
    requests: Record<string, ContractRequestFixture>;
    response: Record<string, unknown>;
    emptyResponse?: Record<string, unknown>;
    nodeReadsResponseFields: ContractResponseField[];
    nodeIgnoresResponseFields?: Array<{ path: string; note: string }>;
    unreadResponseFields?: { note: string; paths: string[] };
}

export interface NodeContractBaseline {
    contractVersion: string;
    pinnedOn: string;
    globalValidationPipe: Record<string, unknown>;
    unknownFieldProbe: string;
    routes: Record<string, ContractRoute>;
    selfDescription: {
        dtoOptionalKeys: string[];
        nodeEmits: string[];
        controllerForwards: Record<string, string[]>;
    };
    platformStatusCodes: Record<string, Record<string, unknown>>;
    nodeStatusBranches: {
        fleet: Record<string, string>;
        job: Record<string, string>;
    };
    killSwitch: {
        leaseWhenStopped: { status: number; body: Record<string, unknown> };
        gatedVerbs: string[];
        ungatedVerbs: string[];
    };
}

export interface BrokenContractFixture {
    requestCases: Array<{
        name: string;
        route: string;
        expectDirection: ContractDirection;
        expectMentions: string;
        note?: string;
        body: Record<string, unknown>;
    }>;
    responseCases: Array<{
        name: string;
        route: string;
        expectMentions: string;
        note?: string;
        response: Record<string, unknown>;
    }>;
    statusCases: Array<{
        name: string;
        route: string;
        /** Which pin in the baseline the observed code is being compared against. */
        pin: string;
        observedStatus: number;
        note?: string;
    }>;
}

/** Read one contract fixture. Deliberately `readFileSync` + `JSON.parse`. */
export function loadContractFixture<T>(fixturePath: string): T {
    return JSON.parse(readFileSync(fixturePath, 'utf8')) as T;
}

export function loadBaseline(): NodeContractBaseline {
    return loadContractFixture<NodeContractBaseline>(BASELINE_FIXTURE_PATH);
}

export function loadBrokenFixture(): BrokenContractFixture {
    return loadContractFixture<BrokenContractFixture>(BROKEN_FIXTURE_PATH);
}

/**
 * Which side of the contract moved.
 *
 * `platform-too-new` is the outage: the API now demands something every
 * deployed node is incapable of sending, so the whole fleet 400s at once and
 * the fix has to travel develop → stage → main on machines that have stopped.
 *
 * `node-too-old` is the mirror image: a field a running node still sends was
 * removed from the DTO, and `forbidNonWhitelisted` turns that into a 400 too.
 *
 * `unclassified` is never a pass. It means the pipe refused a pinned body for
 * a reason this harness does not understand, which is exactly when a human
 * should look.
 */
export type ContractDirection = 'ok' | 'platform-too-new' | 'node-too-old' | 'unclassified';

export interface RequestVerdict {
    direction: ContractDirection;
    route: string;
    fixture: string;
    /** Fields the pipe complained about. */
    fields: string[];
    /** Raw class-validator messages, for the failure text. */
    messages: string[];
}

export interface ShapeVerdict {
    ok: boolean;
    route: string;
    /** Paths that were absent or the wrong type. */
    problems: string[];
}

const FORBIDDEN_PROPERTY = /^property (\S+) should not exist$/;
const EACH_VALUE_IN = /^each value in (\S+)\s/;

/**
 * The field a class-validator message is about.
 *
 * class-validator prefixes its messages with the property name
 * (`leaseGeneration must be an integer number`), except for the `{ each: true }`
 * form, which prefixes with `each value in <property>`. Both are handled; an
 * unrecognised message yields null and the verdict becomes `unclassified`
 * rather than silently passing.
 */
function propertyOf(message: string): string | null {
    const each = EACH_VALUE_IN.exec(message);
    if (each) {
        return each[1];
    }
    const first = message.split(/\s+/)[0];
    return first ? first : null;
}

function messagesOf(error: BadRequestException): string[] {
    const response = error.getResponse();
    if (typeof response === 'string') {
        return [response];
    }
    const message = (response as { message?: unknown }).message;
    if (Array.isArray(message)) {
        return message.map((entry) => String(entry));
    }
    return message === undefined ? [] : [String(message)];
}

/**
 * Run one pinned request body through the REAL global pipe against the REAL
 * DTO, and classify what happens.
 *
 * `metatype` is passed in rather than looked up so this file never imports the
 * DTOs it is judging — the spec supplies them, and the fixture supplies the
 * bodies, so the two halves cannot be reconciled by inference.
 */
export async function checkRequest(
    route: string,
    fixture: string,
    body: Record<string, unknown>,
    metatype: unknown,
): Promise<RequestVerdict> {
    const pipe = new ValidationPipe(GLOBAL_PIPE_OPTIONS);
    const metadata = {
        type: 'body',
        metatype,
        data: undefined,
    } as unknown as ArgumentMetadata;

    try {
        await pipe.transform({ ...body }, metadata);
        return { direction: 'ok', route, fixture, fields: [], messages: [] };
    } catch (error) {
        if (!(error instanceof BadRequestException)) {
            return {
                direction: 'unclassified',
                route,
                fixture,
                fields: [],
                messages: [error instanceof Error ? error.message : String(error)],
            };
        }
        const messages = messagesOf(error);

        // A field the node sends and the platform no longer declares. Checked
        // FIRST: `forbidNonWhitelisted` is the unambiguous signal, and a body
        // can trip both rules at once.
        const forbidden = messages
            .map((message) => FORBIDDEN_PROPERTY.exec(message))
            .filter((match): match is RegExpExecArray => match !== null)
            .map((match) => match[1]);
        if (forbidden.length > 0) {
            return { direction: 'node-too-old', route, fixture, fields: forbidden, messages };
        }

        // A field the platform now requires that is not in the body at all.
        // Keyed on ABSENCE from the pinned body rather than on message text,
        // so a class-validator wording change cannot silently reclassify it.
        const missing = messages
            .map(propertyOf)
            .filter((field): field is string => field !== null)
            .filter((field) => !Object.prototype.hasOwnProperty.call(body, field));
        if (missing.length > 0) {
            return {
                direction: 'platform-too-new',
                route,
                fixture,
                fields: [...new Set(missing)],
                messages,
            };
        }

        return { direction: 'unclassified', route, fixture, fields: [], messages };
    }
}

function matchesType(value: unknown, type: string): boolean {
    return type.split('|').some((alternative) => {
        switch (alternative.trim()) {
            case 'null':
                return value === null;
            case 'true':
                return value === true;
            case 'string':
                return typeof value === 'string';
            case 'number':
                return typeof value === 'number' && Number.isFinite(value);
            case 'boolean':
                return typeof value === 'boolean';
            case 'array':
                return Array.isArray(value);
            case 'object':
                return typeof value === 'object' && value !== null && !Array.isArray(value);
            default:
                return false;
        }
    });
}

/**
 * Resolve a dotted path, where a `[]` suffix means "and then every element of
 * that array". Returns the values found, or null when the path could not be
 * walked at all (a missing key, or `[]` on something that is not an array).
 */
function resolvePath(root: unknown, path: string): unknown[] | null {
    let current: unknown[] = [root];
    for (const rawSegment of path.split('.')) {
        const iterate = rawSegment.endsWith('[]');
        const key = iterate ? rawSegment.slice(0, -2) : rawSegment;
        const next: unknown[] = [];
        for (const value of current) {
            if (typeof value !== 'object' || value === null) {
                return null;
            }
            if (!Object.prototype.hasOwnProperty.call(value, key)) {
                return null;
            }
            const child = (value as Record<string, unknown>)[key];
            if (iterate) {
                if (!Array.isArray(child)) {
                    return null;
                }
                next.push(...child);
            } else {
                next.push(child);
            }
        }
        current = next;
    }
    return current;
}

/**
 * Every field the node dereferences must be present, with a type the node's
 * own guards accept. This is the half that catches "a response field a node
 * reads disappeared or changed type" — the failure the platform's own type
 * checker cannot see, because `FleetJobView.leaseGeneration` is OPTIONAL on
 * the wire while the request DTO that consumes it is not.
 */
export function checkResponse(
    route: string,
    response: unknown,
    fields: ContractResponseField[],
): ShapeVerdict {
    const problems: string[] = [];
    for (const field of fields) {
        const found = resolvePath(response, field.path);
        if (found === null) {
            problems.push(
                `${field.path} is ABSENT (the node reads it: ${field.reader ?? 'see the fixture'})`,
            );
            continue;
        }
        if (found.length === 0) {
            problems.push(
                `${field.path} could not be verified — the pinned response has no element to check it on`,
            );
            continue;
        }
        for (const value of found) {
            if (!matchesType(value, field.type)) {
                problems.push(
                    `${field.path} is ${describe(value)}, expected ${field.type} (the node reads it: ${
                        field.reader ?? 'see the fixture'
                    })`,
                );
            }
        }
    }
    return { ok: problems.length === 0, route, problems };
}

function describe(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'an array';
    return typeof value;
}

/** A status code a node branches on. Changing one is a wire change with no field moved. */
export function checkStatus(route: string, expected: number, observed: number): ShapeVerdict {
    return {
        ok: expected === observed,
        route,
        problems:
            expected === observed
                ? []
                : [`status is ${observed}, the pinned contract says ${expected}`],
    };
}

/**
 * The failure text. It has one job: say WHICH DIRECTION broke, because the two
 * directions need different fixes and the person reading a red gate at 2am
 * should not have to work it out from a class-validator message.
 */
export function formatVerdict(verdict: RequestVerdict, route: ContractRoute): string {
    const header = `${route.method} ${route.path} (${route.dto}) — fixture "${verdict.fixture}"`;
    const fields = verdict.fields.join(', ') || '(none named)';
    const said = verdict.messages.map((message) => `    ${message}`).join('\n');

    if (verdict.direction === 'platform-too-new') {
        return [
            'NODE CONTRACT BROKEN — PLATFORM TOO NEW',
            `  ${header}`,
            `  now-required field(s): ${fields}`,
            '  Every already-deployed node on this shape is 400d on every call and retries',
            '  forever. The fleet stops, and the fix has to travel develop -> stage -> main',
            '  through k8s-build (215-243 min) on the machines that just stopped.',
            '  FIX THE PLATFORM (keep accepting the old shape), not the fixture.',
            '  the validation pipe said:',
            said,
        ].join('\n');
    }
    if (verdict.direction === 'node-too-old') {
        return [
            'NODE CONTRACT BROKEN — NODE TOO OLD',
            `  ${header}`,
            `  no-longer-declared field(s): ${fields}`,
            '  A running node still sends this field; whitelist + forbidNonWhitelisted makes',
            '  that a 400 at the edge, not a silent drop. Removing a field from a node-facing',
            '  DTO is a breaking change for every machine that has not been upgraded yet.',
            '  the validation pipe said:',
            said,
        ].join('\n');
    }
    return [
        'NODE CONTRACT BROKEN — UNCLASSIFIED',
        `  ${header}`,
        '  The pipe refused a pinned node body for a reason this harness does not',
        '  recognise. That is never a pass — look at it.',
        '  the validation pipe said:',
        said,
    ].join('\n');
}

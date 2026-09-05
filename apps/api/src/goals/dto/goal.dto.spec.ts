import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

// `goal.dto.ts` (and the `goal-orchestration.dto.ts` it imports for the DoD
// criterion) read their bounds + unions from the `@ever-works/agent/goals`
// barrel, which transitively pulls in GoalOrchestratorService -> tasks-domain
// -> database.module -> `@src/config` (unmapped in the api jest scope). Stub
// the barrel with the literal values read at module-eval time — the same
// pattern `goal-orchestration.dto.spec.ts` and `mission.dto.spec.ts` use.
// The kind vocabulary itself comes from `@ever-works/contracts`, which IS
// source-mapped, so `GOAL_KINDS` / `isGoalKind` below are the real ones.
jest.mock('@ever-works/agent/goals', () => ({
    GOAL_CONSTRAINT_CATEGORIES: ['time', 'cost', 'safety', 'scope', 'quality'],
    MAX_GOAL_CRITERIA: 20,
    MAX_GOAL_CONSTRAINTS: 20,
    GOAL_DOD_STATUSES: ['open', 'done', 'waived'],
    GOAL_DOD_SOURCES: ['operator', 'planner'],
    GOAL_EXECUTION_TARGETS: ['cloud', 'local-runner'],
    MAX_DOD_EVIDENCE_CHARS: 1000,
    MAX_DOD_ID_CHARS: 64,
    MAX_DOD_NOTE_CHARS: 500,
    MAX_DOD_TEXT_CHARS: 500,
    MAX_GOAL_DOD_CRITERIA: 50,
    MAX_GRACE_PERIOD_MINUTES: 1440,
    MAX_MODEL_HINT_CHARS: 120,
    MAX_NUDGE_CHARS: 2000,
    MAX_SESSION_BUDGET_MINUTES: 1440,
    MAX_SPEND_CAP_CENTS: 100_000_000,
    MAX_STUCK_THRESHOLD_ITERATIONS: 1000,
    MAX_WALL_CLOCK_LIMIT_HOURS: 8760,
}));

import { CreateGoalDto, UpdateGoalDto } from './goal.dto';

/** The global pipe's exact posture (apps/api/src/main.ts). */
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true } as const;

/** Flatten nested (`metricSource` -> property) validation errors. */
function flatten(
    errors: Array<{
        property: string;
        constraints?: Record<string, string>;
        children?: unknown[];
    }>,
    prefix = '',
): string[] {
    return errors.flatMap((error) => {
        const path = prefix ? `${prefix}.${error.property}` : error.property;
        const own = Object.keys(error.constraints ?? {}).map(
            (constraint) => `${path}:${constraint}`,
        );
        const children = flatten((error.children ?? []) as Parameters<typeof flatten>[0], path);
        return [...own, ...children];
    });
}

async function validateCreate(body: unknown): Promise<string[]> {
    return flatten(await validate(plainToInstance(CreateGoalDto, body), PIPE_OPTIONS));
}

async function validateUpdate(body: unknown): Promise<string[]> {
    return flatten(await validate(plainToInstance(UpdateGoalDto, body), PIPE_OPTIONS));
}

const METRIC_BODY = {
    title: 'Income >= $1000/month',
    metricSource: { pluginId: 'stripe', metricId: 'income' },
    comparator: 'gte',
    targetValue: 1000,
    unit: 'usd',
    window: 'month',
};

const DELIVERY_BODY = {
    title: 'Ship feature X across three repos',
    goalKind: 'delivery',
    dodCriteria: [
        { id: 'api', text: 'API endpoint merged', status: 'open' },
        { id: 'web', text: 'Web form merged', status: 'open' },
    ],
};

/**
 * `CreateGoalDto` — Goal kinds (self-build slice AG, EW-795).
 *
 * The trap this suite exists for: `@IsOptional()` skips EVERY validator on a
 * property when it is undefined, so a cross-field rule hung on `goalKind`
 * with `@IsOptional()` would never run for the default (metric) body — and
 * two `@ValidateIf` conditions on one property AND together. A wrong
 * combination silently admits a metric Goal without a target, the exact
 * vacuous-Goal defect EW-044 fixed on the web side. Every branch of the
 * fail-closed rule is therefore pinned here.
 */
describe('CreateGoalDto — metric kind (the default)', () => {
    it('accepts the classic metric body with no goalKind at all', async () => {
        expect(await validateCreate(METRIC_BODY)).toEqual([]);
    });

    it('accepts an explicit metric kind', async () => {
        expect(await validateCreate({ ...METRIC_BODY, goalKind: 'metric' })).toEqual([]);
    });

    it('still requires targetValue — a missing target is not a target of 0', async () => {
        const { targetValue: _omit, ...body } = METRIC_BODY;
        expect(await validateCreate(body)).toEqual(['targetValue:isNumber']);
        expect(await validateCreate({ ...METRIC_BODY, targetValue: '1000' })).toEqual([
            'targetValue:isNumber',
        ]);
        expect(await validateCreate({ ...METRIC_BODY, targetValue: null })).toEqual([
            'targetValue:isNumber',
        ]);
    });

    it('still requires comparator, unit and window with their own per-field messages', async () => {
        const { comparator: _c, ...noComparator } = METRIC_BODY;
        expect(await validateCreate(noComparator)).toEqual(['comparator:isIn']);

        const { unit: _u, ...noUnit } = METRIC_BODY;
        expect(await validateCreate(noUnit)).toEqual(
            expect.arrayContaining(['unit:isString', 'unit:minLength']),
        );

        const { window: _w, ...noWindow } = METRIC_BODY;
        expect(await validateCreate(noWindow)).toEqual(['window:isIn']);
    });

    it('lets a MISSING metricSource through to the service, which owns that message', async () => {
        // Pinned by the e2e validation matrix: `metricSource` undefined → 400
        // "metricSource must be an object." from `GoalsService.create`, not a
        // DTO message. `@ValidateNested` is a no-op on undefined, and the
        // kind change must not start intercepting it.
        const { metricSource: _m, ...body } = METRIC_BODY;
        expect(await validateCreate(body)).toEqual([]);
    });

    it('still validates a present metricSource nested shape', async () => {
        expect(
            await validateCreate({ ...METRIC_BODY, metricSource: { pluginId: 'stripe' } }),
        ).toEqual(expect.arrayContaining(['metricSource.metricId:isString']));
        expect(await validateCreate({ ...METRIC_BODY, metricSource: 'stripe' })).toEqual([
            'metricSource:nestedValidation',
        ]);
    });

    it('accepts an optional seed checklist on a metric Goal', async () => {
        expect(
            await validateCreate({
                ...METRIC_BODY,
                dodCriteria: [{ id: 'docs', text: 'Write the docs', status: 'open' }],
            }),
        ).toEqual([]);
    });

    it('refuses an empty seed checklist', async () => {
        expect(await validateCreate({ ...METRIC_BODY, dodCriteria: [] })).toEqual([
            'dodCriteria:arrayMinSize',
        ]);
    });
});

describe('CreateGoalDto — delivery kind', () => {
    it('accepts a delivery body that carries no metric key at all', async () => {
        expect(await validateCreate(DELIVERY_BODY)).toEqual([]);
    });

    it('accepts explicit nulls for the metric fields (absent-or-null is the wire contract)', async () => {
        expect(
            await validateCreate({
                ...DELIVERY_BODY,
                metricSource: null,
                comparator: null,
                targetValue: null,
                unit: null,
                window: null,
                baselineValue: null,
            }),
        ).toEqual([]);
    });

    it.each([
        ['metricSource', { pluginId: 'stripe', metricId: 'income' }],
        ['comparator', 'gte'],
        ['targetValue', 1000],
        ['unit', 'usd'],
        ['window', 'month'],
        ['baselineValue', 5],
        ['criteria', []],
        ['constraints', []],
    ])('refuses a delivery body that sets the metric-only field %s', async (field, value) => {
        const errors = await validateCreate({ ...DELIVERY_BODY, [field]: value });
        expect(errors).toContain('goalKind:goalKindShape');
    });

    it('refuses a delivery body without a Definition of Done', async () => {
        const { dodCriteria: _omit, ...body } = DELIVERY_BODY;
        expect(await validateCreate(body)).toEqual(['goalKind:goalKindShape']);
        expect(await validateCreate({ ...DELIVERY_BODY, dodCriteria: null })).toEqual([
            'goalKind:goalKindShape',
        ]);
    });

    it('refuses an empty Definition of Done on a delivery body', async () => {
        const errors = await validateCreate({ ...DELIVERY_BODY, dodCriteria: [] });
        expect(errors).toEqual(
            expect.arrayContaining(['goalKind:goalKindShape', 'dodCriteria:arrayMinSize']),
        );
    });

    it('refuses a delivery body whose criteria are all still proposed (no approved finish line)', async () => {
        expect(
            await validateCreate({
                ...DELIVERY_BODY,
                dodCriteria: [
                    { id: 'a', text: 'Only a proposal', status: 'open', proposed: true },
                    { id: 'b', text: 'Another proposal', status: 'open', proposed: true },
                ],
            }),
        ).toEqual(['goalKind:goalKindShape']);
    });

    it('accepts a delivery body that mixes proposed and approved criteria', async () => {
        expect(
            await validateCreate({
                ...DELIVERY_BODY,
                dodCriteria: [
                    { id: 'a', text: 'Approved', status: 'open' },
                    { id: 'b', text: 'Proposal', status: 'open', proposed: true },
                ],
            }),
        ).toEqual([]);
    });

    it('validates each criterion on the wire', async () => {
        expect(
            await validateCreate({
                ...DELIVERY_BODY,
                dodCriteria: [{ id: 'a', text: 'x', status: 'finished' }],
            }),
        ).toEqual(['dodCriteria.0.status:isIn']);
        expect(
            await validateCreate({
                ...DELIVERY_BODY,
                dodCriteria: [{ id: 'a', text: 'x', status: 'open', sneaky: 1 }],
            }),
        ).toEqual(['dodCriteria.0.sneaky:whitelistValidation']);
    });

    it('does not report missing METRIC fields for a delivery body', async () => {
        // The per-field metric validators are gated on the kind; a delivery
        // body must not be told that it is missing a target.
        const errors = await validateCreate(DELIVERY_BODY);
        expect(errors.some((e) => e.startsWith('targetValue'))).toBe(false);
        expect(errors.some((e) => e.startsWith('comparator'))).toBe(false);
    });

    it('names every problem in the shape message', async () => {
        const errors = await validate(
            plainToInstance(CreateGoalDto, {
                title: 'x',
                goalKind: 'delivery',
                targetValue: 5,
                unit: 'usd',
            }),
            PIPE_OPTIONS,
        );
        const message = errors.find((e) => e.property === 'goalKind')?.constraints?.goalKindShape;
        expect(message).toContain('targetValue must be omitted for a delivery Goal');
        expect(message).toContain('unit must be omitted for a delivery Goal');
        expect(message).toContain('at least one Definition-of-Done criterion');
    });
});

describe('CreateGoalDto — neither kind (fail closed)', () => {
    it.each(['bogus', 'Metric', '', 42, {}])('refuses goalKind %j', async (goalKind) => {
        const errors = await validateCreate({ ...METRIC_BODY, goalKind });
        expect(errors).toContain('goalKind:goalKindMember');
    });

    it('refuses an unknown property anywhere in the body', async () => {
        expect(await validateCreate({ ...METRIC_BODY, sneaky: 'value' })).toContain(
            'sneaky:whitelistValidation',
        );
        expect(await validateCreate({ ...DELIVERY_BODY, sneaky: 'value' })).toContain(
            'sneaky:whitelistValidation',
        );
    });
});

describe('UpdateGoalDto', () => {
    it('does not accept goalKind — the kind is immutable after create', async () => {
        expect(await validateUpdate({ goalKind: 'delivery' })).toEqual([
            'goalKind:whitelistValidation',
        ]);
    });

    it('still accepts a metric-field patch (the service refuses it on a delivery Goal)', async () => {
        expect(await validateUpdate({ targetValue: 2500 })).toEqual([]);
        expect(await validateUpdate({})).toEqual([]);
    });
});

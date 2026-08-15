import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

// `goal-orchestration.dto.ts` imports its bounds + unions from the
// `@ever-works/agent/goals` barrel, which transitively pulls in
// GoalOrchestratorService -> tasks-domain -> database.module -> `@src/config`
// (unmapped in the api jest scope). Stub the barrel with the literal values the
// DTO reads at module-eval time — the same pattern `mission.dto.spec.ts` uses.
jest.mock('@ever-works/agent/goals', () => ({
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

import { SetGoalDodDto } from './goal-orchestration.dto';

/** The global pipe's exact posture (apps/api/src/main.ts). */
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true } as const;

/** Flatten nested (`criteria` -> index -> property) validation errors. */
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

async function validateSetDod(body: unknown): Promise<string[]> {
    return flatten(await validate(plainToInstance(SetGoalDodDto, body), PIPE_OPTIONS));
}

describe('SetGoalDodDto', () => {
    /**
     * Regression: the DoD tab REPLACES the whole checklist on every add and
     * every remove, sending back the criteria the server just returned — and
     * `normalizeDoDCriteria` stamps `updatedAt` on every persisted criterion.
     * With `forbidNonWhitelisted: true` an unlisted `updatedAt` made
     * `PUT /api/me/goals/:id/dod` 400 the moment the Goal had one saved
     * criterion, i.e. every add after the first and every remove.
     */
    it('accepts a criterion round-tripped from the API, including its updatedAt stamp', async () => {
        const errors = await validateSetDod({
            criteria: [
                {
                    id: 'pricing-page',
                    text: 'Pricing page ships with three tiers',
                    status: 'open',
                    evidence: null,
                    note: null,
                    source: 'operator',
                    updatedAt: '2026-08-14T10:00:00.000Z',
                },
                { id: 'docs', text: 'Write the docs', status: 'open' },
            ],
        });
        expect(errors).toEqual([]);
    });

    it('accepts a proposed planner criterion round-tripped unchanged', async () => {
        const errors = await validateSetDod({
            criteria: [
                {
                    id: 'faq',
                    text: 'Add an FAQ',
                    status: 'open',
                    evidence: null,
                    note: null,
                    source: 'planner',
                    proposed: true,
                    updatedAt: '2026-08-14T10:00:00.000Z',
                },
            ],
        });
        expect(errors).toEqual([]);
    });

    it('still rejects a genuinely unknown criterion property', async () => {
        const errors = await validateSetDod({
            criteria: [{ id: 'a', text: 'x', status: 'open', sneaky: 'value' }],
        });
        expect(errors).toContain('criteria.0.sneaky:whitelistValidation');
    });

    it('rejects an updatedAt that is not an ISO-8601 timestamp', async () => {
        const errors = await validateSetDod({
            criteria: [{ id: 'a', text: 'x', status: 'open', updatedAt: 'yesterday' }],
        });
        expect(errors).toContain('criteria.0.updatedAt:isIso8601');
    });

    it('accepts `criteria: null` — the documented "clear the whole checklist"', async () => {
        expect(await validateSetDod({ criteria: null })).toEqual([]);
    });
});

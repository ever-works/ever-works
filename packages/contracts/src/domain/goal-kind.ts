/**
 * Goal "kind" vocabulary — the single source of truth shared by the API,
 * the agent package, the MCP server and the web app.
 *
 * Lives in `@ever-works/contracts` for the same reason `work-kind.ts` does:
 * `apps/web` deliberately does not depend on `@ever-works/agent`, and
 * contracts is the only package every side imports. The Goal entity
 * (`packages/agent/src/entities/goal.entity.ts`) re-exports from here so
 * there is exactly one list to extend when a new kind ships.
 *
 *   - `metric`   — the original Goal: reads a number from a metrics-provider
 *                  plugin on a schedule and completes when the comparator is
 *                  satisfied against `targetValue`. Every row that predates
 *                  the `goalKind` column is a metric Goal.
 *   - `delivery` — "ship feature X across three repos": there is NO metric,
 *                  no comparator and no target value. The Goal completes on
 *                  its approved Definition of Done alone — every approved
 *                  criterion done or waived — and is otherwise driven by the
 *                  same iteration loop and budget rules as a metric Goal.
 */
export const GOAL_KINDS = ['metric', 'delivery'] as const;

export type GoalKind = (typeof GOAL_KINDS)[number];

/** The column default, and what every pre-existing Goal row reads as. */
export const DEFAULT_GOAL_KIND: GoalKind = 'metric';

const GOAL_KIND_SET: ReadonlySet<string> = new Set<string>(GOAL_KINDS);

/**
 * Type guard for WRITE paths. Fail closed: an unknown kind is rejected by
 * the caller, never coerced — a Goal that is neither metric nor delivery
 * has no completion rule and must not be persisted.
 */
export function isGoalKind(value: unknown): value is GoalKind {
	return typeof value === 'string' && GOAL_KIND_SET.has(value);
}

/**
 * Coerce an arbitrary value into a known `GoalKind` for READ paths only.
 *
 * `goals.goalKind` is `varchar(16)`, so a row written by a newer server (or
 * by hand) may carry a value this build does not know. Rendering it as the
 * generic `metric` behaviour is the safe default for a display surface; a
 * write path must use {@link isGoalKind} instead.
 *
 * NEVER throws.
 */
export function normalizeGoalKind(value?: string | null): GoalKind {
	if (typeof value !== 'string') {
		return DEFAULT_GOAL_KIND;
	}
	const normalized = value.trim().toLowerCase();
	return GOAL_KIND_SET.has(normalized) ? (normalized as GoalKind) : DEFAULT_GOAL_KIND;
}

/** True when `value` names the Delivery kind. Accepts loose input; never throws. */
export function isDeliveryGoalKind(value?: string | null): boolean {
	return normalizeGoalKind(value) === 'delivery';
}

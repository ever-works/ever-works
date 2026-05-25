import type { AgentBudgetIntervalUnit } from '../entities/agent-budget.entity';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 7.6 (N6 override).
 *
 * Multi-interval budget period math. `AgentBudget.intervalUnit` is
 * one of `hour | day | week | month | unlimited` (entity comment
 * at `packages/agent/src/entities/agent-budget.entity.ts:14`).
 *
 * Period anchors:
 *   - hour   → start of the current UTC hour
 *   - day    → start of the current UTC day (00:00:00)
 *   - week   → start of the current UTC week (Monday 00:00 UTC, ISO-8601)
 *   - month  → start of the current UTC month (1st 00:00)
 *   - unlimited → period is the entire epoch — start = epoch 0,
 *                 next = +Infinity (callers must short-circuit)
 *
 * `intervalCount` (entity column) multiplies the unit — e.g. `day`
 * with `intervalCount=7` is "every 7 days starting at the period
 * anchor". v1 honors the count but assumes count=1 unless callers
 * override; the multi-day case lives behind the spec table.
 *
 * All times are UTC. Mixing local time would break daylight-saving
 * boundaries the same way it would for cron expressions
 * (see `cron-matcher.ts` for the same rationale).
 */

export function getCurrentPeriodStart(
	unit: AgentBudgetIntervalUnit,
	now: Date = new Date(),
	intervalCount = 1,
): Date {
	if (unit === 'unlimited') {
		return new Date(0);
	}
	const count = Math.max(1, intervalCount);

	switch (unit) {
		case 'hour': {
			const anchor = startOfHourUTC(now);
			if (count === 1) return anchor;
			const hoursSinceEpoch = Math.floor(anchor.getTime() / 3_600_000);
			const slotIndex = Math.floor(hoursSinceEpoch / count) * count;
			return new Date(slotIndex * 3_600_000);
		}
		case 'day': {
			const anchor = startOfDayUTC(now);
			if (count === 1) return anchor;
			const daysSinceEpoch = Math.floor(anchor.getTime() / 86_400_000);
			const slotIndex = Math.floor(daysSinceEpoch / count) * count;
			return new Date(slotIndex * 86_400_000);
		}
		case 'week': {
			// Week starts Monday 00:00 UTC (ISO-8601). JS getUTCDay():
			// 0=Sun, 1=Mon, ..., 6=Sat. We want days-since-Monday:
			//   Sun → 6, Mon → 0, Tue → 1, ...
			const anchor = startOfWeekUTC(now);
			if (count === 1) return anchor;
			const weeksSinceEpoch = Math.floor(anchor.getTime() / (7 * 86_400_000));
			const slotIndex = Math.floor(weeksSinceEpoch / count) * count;
			return new Date(slotIndex * 7 * 86_400_000);
		}
		case 'month': {
			// Month is variable-length, so the "intervalCount > 1" case
			// counts whole months from a reference point. We anchor on
			// epoch-month and bucket from there.
			const epochYear = 1970;
			const monthsSinceEpoch = (now.getUTCFullYear() - epochYear) * 12 + now.getUTCMonth();
			const slotIndex = Math.floor(monthsSinceEpoch / count) * count;
			const year = epochYear + Math.floor(slotIndex / 12);
			const month = slotIndex % 12;
			return new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
		}
	}
}

export function getNextPeriodStart(
	unit: AgentBudgetIntervalUnit,
	now: Date = new Date(),
	intervalCount = 1,
): Date {
	if (unit === 'unlimited') {
		return new Date(8_640_000_000_000_000); // max representable Date — effectively +Infinity
	}
	const start = getCurrentPeriodStart(unit, now, intervalCount);
	const count = Math.max(1, intervalCount);

	switch (unit) {
		case 'hour':
			return new Date(start.getTime() + count * 3_600_000);
		case 'day':
			return new Date(start.getTime() + count * 86_400_000);
		case 'week':
			return new Date(start.getTime() + count * 7 * 86_400_000);
		case 'month': {
			const y = start.getUTCFullYear();
			const m = start.getUTCMonth() + count;
			return new Date(Date.UTC(y + Math.floor(m / 12), m % 12, 1, 0, 0, 0, 0));
		}
	}
}

/** True iff `at` falls within the current period anchored on `now`. */
export function isWithinCurrentPeriod(
	unit: AgentBudgetIntervalUnit,
	at: Date,
	now: Date = new Date(),
	intervalCount = 1,
): boolean {
	const start = getCurrentPeriodStart(unit, now, intervalCount).getTime();
	const next = getNextPeriodStart(unit, now, intervalCount).getTime();
	const t = at.getTime();
	return t >= start && t < next;
}

// ── internals ─────────────────────────────────────────────────────

function startOfHourUTC(d: Date): Date {
	return new Date(
		Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 0, 0, 0),
	);
}

function startOfDayUTC(d: Date): Date {
	return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function startOfWeekUTC(d: Date): Date {
	const dayOfWeek = d.getUTCDay(); // 0..6 (Sun..Sat)
	const daysSinceMonday = (dayOfWeek + 6) % 7; // Sun=6, Mon=0, Tue=1...
	const monday = new Date(
		Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
	);
	monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
	return monday;
}

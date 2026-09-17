import { Injectable, Optional } from '@nestjs/common';
import {
    HOME_SCHEDULE_NAME_MAX_CHARS,
    HOME_TODAY_DUE_MAX,
    HOME_TODAY_RAN_MAX,
    truncateHomeText,
    type HomeScheduleKind,
    type HomeScheduleRow,
    type HomeScheduleStatus,
    type HomeToday,
} from '@ever-works/contracts';
import { SchedulesService } from '../../schedules/schedules.service';
import type {
    ScheduleSourceType,
    ScheduleStatus,
    ScheduleView,
} from '../../schedules/schedule-view.types';
import { HomeSourceUnavailableError, type HomeBuildContext } from '../home-build-context';

/**
 * Every schedule source maps to a Home kind. A `switch` with no default: a
 * source type added to the aggregation without a Home kind is a compile
 * error here, never a row silently dropped from the Today panel.
 */
export function homeScheduleKind(sourceType: ScheduleSourceType): HomeScheduleKind {
    switch (sourceType) {
        case 'recurring_task':
            return 'recurring_task';
        case 'agent_heartbeat':
            return 'agent_heartbeat';
        case 'work_schedule':
            return 'work_schedule';
        case 'mission_tick':
            return 'mission_tick';
        case 'source_validation':
            return 'source_validation';
        case 'data_sync':
            return 'data_sync';
        case 'inbound_trigger':
            return 'inbound_trigger';
    }
}

/** Paused and errored schedules are shown; disabled and ended ones are not. */
function homeScheduleStatus(status: ScheduleStatus): HomeScheduleStatus | null {
    switch (status) {
        case 'active':
        case 'paused':
        case 'error':
            return status;
        case 'disabled':
        case 'ended':
            return null;
    }
}

function instantIn(value: string | null, from: number, to: number): number | null {
    if (!value) return null;
    const at = Date.parse(value);
    if (Number.isNaN(at) || at < from || at >= to) return null;
    return at;
}

/**
 * Split the schedule aggregation into what already ran today and what is
 * still due before the end of the local day. Pure.
 *
 * - `ran` — a `lastRunAt` inside the day and not in the future; the most
 *   recent {@link HOME_TODAY_RAN_MAX}, listed earliest first.
 * - `due` — a `nextRunAt` inside the day and not yet past; soonest first,
 *   {@link HOME_TODAY_DUE_MAX} previewed, `dueTotal` counts all of them. A
 *   schedule whose next run cannot be computed is never due.
 */
export function toHomeToday(
    views: ScheduleView[],
    day: { from: Date; to: Date },
    now: Date,
): HomeToday {
    const from = day.from.getTime();
    const to = day.to.getTime();
    const nowMs = now.getTime();
    const ran: Array<{ at: number; row: HomeScheduleRow }> = [];
    const due: Array<{ at: number; row: HomeScheduleRow }> = [];

    for (const view of views) {
        const status = homeScheduleStatus(view.status);
        if (!status) continue;
        const base = {
            id: view.id,
            kind: homeScheduleKind(view.sourceType),
            name: truncateHomeText(view.ownerName, HOME_SCHEDULE_NAME_MAX_CHARS) ?? '',
            href: view.ownerLink,
            status,
        };
        const lastRun = instantIn(view.lastRunAt, from, Math.min(to, nowMs + 1));
        if (lastRun !== null) {
            ran.push({
                at: lastRun,
                row: { ...base, at: new Date(lastRun).toISOString(), state: 'ran' },
            });
        }
        const nextRun = instantIn(view.nextRunAt, Math.max(from, nowMs), to);
        if (nextRun !== null) {
            due.push({
                at: nextRun,
                row: { ...base, at: new Date(nextRun).toISOString(), state: 'due' },
            });
        }
    }

    const byTime = (
        a: { at: number; row: HomeScheduleRow },
        b: { at: number; row: HomeScheduleRow },
    ) => a.at - b.at || a.row.name.localeCompare(b.row.name);
    ran.sort(byTime);
    due.sort(byTime);

    return {
        ran: ran.slice(-HOME_TODAY_RAN_MAX).map((entry) => entry.row),
        due: due.slice(0, HOME_TODAY_DUE_MAX).map((entry) => entry.row),
        dueTotal: due.length,
    };
}

/** Today — the schedule aggregation, read with no source filter so every kind arrives. */
@Injectable()
export class HomeTodayBuilder {
    constructor(@Optional() private readonly schedules?: SchedulesService) {}

    async build(context: HomeBuildContext): Promise<HomeToday> {
        if (!this.schedules) throw new HomeSourceUnavailableError('schedules');
        const views = await this.schedules.getSchedules({
            userId: context.userId,
            organizationId: context.scope.organizationId,
        });
        return toHomeToday(views, context.day, context.now);
    }
}

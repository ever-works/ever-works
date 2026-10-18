/**
 * APW-07 T26 — `AppEnvActivityService`: the Activity writer behind `APP_ENV_ACTIVITY`
 * (lane aw-env-smtp, 2026-10-18).
 *
 * `AppEnvService` has emitted one `AppEnvActivityEvent` per changing `apply` and one per `rotate`
 * since T13, into a port nothing bound — so an env change through the new
 * `PUT /api/works/:id/app-env` route would leave no Activity row, which FR-8 requires. This class is
 * the swap `app-env.service.ts` documents above the token:
 *
 * ```ts
 * { provide: APP_ENV_ACTIVITY, useExisting: AppEnvActivityService }
 * ```
 *
 * and its `emit` calls `ActivityLogService.log({ actionType: ActivityActionType.APP_ENV, … })` — the
 * same string the event carries (`'app_env'`), so a rename on either side is a failing spec here.
 *
 * ## Names and verbs only
 *
 * `metadata` is the event's own `details` — env NAMES and action verbs, never a value, a length or a
 * hash (FR-8, FR-5) — copied key by key, so nothing the event might grow later leaks into a row by
 * accident.
 *
 * ## The log service is looked up, not injected
 *
 * `AppEnvModule` is compiled standalone by its own spec and by `AppRuntimeEnvModule`'s, and imports no
 * `ActivityLogModule` (whose own graph needs the API root). The writer therefore resolves
 * `ActivityLogService` through `ModuleRef` at CALL time — the same non-strict, optional lookup this
 * module already uses for `AppSpecService`. Unbound (a lean graph, a worker context), `emit` throws a
 * named error, which `AppEnvService.emit` turns into `activityRecorded: false` and one warning: the
 * change still happened, and the call says honestly that no row was written.
 */

import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { getOptionalProvider } from '../utils/optional-provider.util';
import type { AppEnvActivity, AppEnvActivityEvent } from './app-env.service';

/** The metadata keys a row may carry — the event's `details`, nothing else. */
const DETAIL_KEYS = ['names', 'actions', 'name'] as const;

@Injectable()
export class AppEnvActivityService implements AppEnvActivity {
    constructor(@Optional() private readonly ref?: ModuleRef) {}

    async emit(event: AppEnvActivityEvent): Promise<void> {
        const log = this.ref
            ? getOptionalProvider<ActivityLogService>(this.ref, ActivityLogService)
            : undefined;
        if (!log?.log) {
            throw new Error('ActivityLogService is not available in this process.');
        }

        const workId = typeof event?.workId === 'string' ? event.workId.trim() : '';
        const userId = typeof event?.userId === 'string' ? event.userId.trim() : '';
        if (!workId || !userId) {
            // `ActivityLogService.log` files a row under a user; without one there is nowhere to put it.
            throw new Error('An App env Activity row needs both the Work and the actor.');
        }

        const metadata: Record<string, unknown> = {};
        for (const key of DETAIL_KEYS) {
            const value = event.details?.[key];
            if (value === undefined || value === null) continue;
            metadata[key] = Array.isArray(value)
                ? value.map((entry) => String(entry)).slice(0, 100)
                : String(value);
        }

        await log.log({
            userId,
            workId,
            actionType: ActivityActionType.APP_ENV,
            action: event.action,
            status: ActivityStatus.COMPLETED,
            summary: String(event.summary ?? ''),
            metadata,
        });
    }
}

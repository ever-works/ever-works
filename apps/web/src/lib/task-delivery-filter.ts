import { TASK_DELIVERY_FILTER_GROUPS, type TaskDeliveryFilterGroup } from '@ever-works/contracts';

/**
 * APW-08 T27 — the App Work Tasks tab's **Delivery** filter (spec §6.1), shared by the server
 * page that reads `?delivery=` and the client select that writes it. A plain module on purpose:
 * a function exported from a `'use client'` file cannot be called from a server component.
 *
 * The options, in order, with the `dashboard.tasksPage.delivery.*` leaf each one reads. The
 * tokens each sends to `GET /api/tasks?deliveryState=` are `TASK_DELIVERY_FILTER_GROUPS[option]`.
 */
export type TaskDeliveryFilterLabelKey =
    | 'filterWaiting'
    | 'filterBuilding'
    | 'filterDeploying'
    | 'filterLive'
    | 'filterFailed'
    | 'filterClosed';

export const TASK_DELIVERY_FILTER_OPTIONS: ReadonlyArray<{
    value: TaskDeliveryFilterGroup;
    labelKey: TaskDeliveryFilterLabelKey;
}> = [
    { value: 'waiting', labelKey: 'filterWaiting' },
    { value: 'building', labelKey: 'filterBuilding' },
    { value: 'deploying', labelKey: 'filterDeploying' },
    { value: 'live', labelKey: 'filterLive' },
    { value: 'failed', labelKey: 'filterFailed' },
    { value: 'closed', labelKey: 'filterClosed' },
];

/** The URL parameter the filter form submits. */
export const TASK_DELIVERY_FILTER_PARAM = 'delivery';

/** `?delivery=` → the select's option, or `undefined` for Any / an unknown value. */
export function parseTaskDeliveryFilter(
    value: string | null | undefined,
): TaskDeliveryFilterGroup | undefined {
    return value && Object.prototype.hasOwnProperty.call(TASK_DELIVERY_FILTER_GROUPS, value)
        ? (value as TaskDeliveryFilterGroup)
        : undefined;
}

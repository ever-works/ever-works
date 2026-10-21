import { FLEET_LOGS_MAX_MERGED_SOURCES, isFleetLogSourceId } from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';

/**
 * Logs on computers (FL-08 P2, T-20) — the links other tabs open the Logs tab
 * with (FR-36, FR-38). Client-safe and side-effect free: FL-09's Services and
 * Docker rows call {@link openLogsForSource} ("Open log"), its Compose project
 * view calls {@link openMergedLogs} ("Logs": every container of the project in
 * one merged viewer, by time, with a chip per service). The Logs tab reads both
 * shapes (`logsDeepLinkSources`).
 *
 *  - one source: `/fleet/computers/<id>?tab=logs&source=<sourceId>`;
 *  - merged: `…?tab=logs&source=<a>&source=<b>…[&title=<name>]` (≤ 12);
 *  - P3: `&at=<iso>` positions the viewer at that time (a failed service).
 */

function base(nodeId: string): string {
    return ROUTES.DASHBOARD_FLEET_COMPUTER(nodeId, 'logs');
}

/** The Logs tab with one source open. Unknown ids still link to the tab (it shows its list). */
export function openLogsForSource(nodeId: string, sourceId: string, options: { at?: string | null } = {}): string {
    const params = new URLSearchParams();
    if (isFleetLogSourceId(sourceId)) params.append('source', sourceId);
    if (options.at && !Number.isNaN(Date.parse(options.at))) params.set('at', new Date(Date.parse(options.at)).toISOString());
    const query = params.toString();
    return query ? `${base(nodeId)}&${query}` : base(nodeId);
}

/** The Logs tab with several sources merged by time (a Compose project's containers). */
export function openMergedLogs(nodeId: string, sourceIds: readonly string[], options: { title?: string } = {}): string {
    const params = new URLSearchParams();
    const ids = [...new Set(sourceIds.filter((id) => isFleetLogSourceId(id)))].slice(0, FLEET_LOGS_MAX_MERGED_SOURCES);
    for (const id of ids) params.append('source', id);
    const title = options.title?.trim();
    if (title && ids.length > 1) params.set('title', title.slice(0, 80));
    const query = params.toString();
    return query ? `${base(nodeId)}&${query}` : base(nodeId);
}

/** A Compose project's containers as log source ids (FL-09 hands the container names). */
export function composeLogSourceIds(containerNames: readonly string[]): string[] {
    return containerNames.map((name) => `container:${name}`).filter((id) => isFleetLogSourceId(id));
}

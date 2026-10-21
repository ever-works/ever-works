'use client';

import type {
    FleetCommandRunView,
    FleetScheduleUpdateRequest,
    FleetScheduleView,
} from '@ever-works/contracts';
import { browserApiFetch } from '@/lib/api/browser-api';
import { readCommandError, type CommandErrorRead } from '../commands/commands.shared';
import { schedulesOfPage } from './schedules.shared';

/**
 * Schedules on computers (FL-13) — the browser's calls to the schedule BFF
 * routes. Every call answers a result union, never a throw: `{ ok: true, data }`
 * or `{ ok: false, error }` with the CONTRACTS §8 code, hint and details — so a
 * dialog can render a 409 `confirmation_required` summary and a row a refusal.
 * Run now, Pause and Resume go through the Schedules server actions (one
 * control path for every source).
 */
export type ScheduleResult<T> = { ok: true; data: T } | { ok: false; error: CommandErrorRead };

async function call<T>(
    path: string,
    init: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: Record<string, unknown> },
): Promise<ScheduleResult<T>> {
    try {
        const response = await browserApiFetch(path, {
            method: init.method,
            headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
            body: init.body ? JSON.stringify(init.body) : undefined,
            cache: 'no-store',
        });
        const text = await response.text().catch(() => '');
        let body: unknown = null;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = null;
        }
        if (!response.ok) return { ok: false, error: readCommandError(response.status, body) };
        return { ok: true, data: body as T };
    } catch {
        return { ok: false, error: { code: 'network', hint: null, details: {}, status: 0 } };
    }
}

export interface ScheduleCreateBody {
    name: string;
    nodeId: string;
    command: string;
    cwd?: string;
    cadence: Record<string, unknown>;
    confirm?: boolean;
}

export const schedulesClient = {
    /** The computer's schedules (the Schedules view's page, filtered to it). */
    list: async (nodeId: string): Promise<ScheduleResult<FleetScheduleView[]>> => {
        const result = await call<unknown>(`/api/fleet/nodes/${encodeURIComponent(nodeId)}/schedules`, {
            method: 'GET',
        });
        return result.ok ? { ok: true, data: schedulesOfPage(result.data) } : result;
    },
    create: (body: ScheduleCreateBody) =>
        call<FleetScheduleView>('/api/fleet/commands', {
            method: 'POST',
            body: body as unknown as Record<string, unknown>,
        }),
    update: (id: string, body: FleetScheduleUpdateRequest) =>
        call<FleetScheduleView>(`/api/fleet/commands/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: body as unknown as Record<string, unknown>,
        }),
    remove: (id: string, confirm: boolean) =>
        call<FleetScheduleView>(`/api/fleet/commands/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            body: confirm ? { confirm: true } : {},
        }),
    runs: (id: string) =>
        call<FleetCommandRunView[]>(`/api/fleet/commands/${encodeURIComponent(id)}/runs?limit=30`, { method: 'GET' }),
};

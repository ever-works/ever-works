'use client';

import type {
    FleetCommandLastRunResponse,
    FleetCommandListResponse,
    FleetCommandRunRequest,
    FleetCommandView,
} from '@ever-works/contracts';
import { browserApiFetch } from '@/lib/api/browser-api';
import { readCommandError, type CommandErrorRead } from './commands.shared';

/**
 * Commands on computers (FL-12) — the browser's calls to the command BFF
 * routes (`app/api/fleet/commands/…`). Every call answers a result union,
 * never a throw: `{ ok: true, data }` or `{ ok: false, error }` with the
 * CONTRACTS §8 code, hint and details the platform sent — so the dialog can
 * render a 409 `confirmation_required` summary and a card a refusal's hint.
 */
export type CommandResult<T> = { ok: true; data: T } | { ok: false; error: CommandErrorRead };

async function call<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: Record<string, unknown> },
    fetchImpl: typeof fetch = browserApiFetch,
): Promise<CommandResult<T>> {
    try {
        const response = await fetchImpl(path, {
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

export const commandsClient = {
    run: (request: FleetCommandRunRequest) =>
        call<FleetCommandView>('/api/fleet/commands', {
            method: 'POST',
            body: request as unknown as Record<string, unknown>,
        }),
    get: (commandId: string) =>
        call<FleetCommandView>(`/api/fleet/commands/${encodeURIComponent(commandId)}`, {
            method: 'GET',
        }),
    recent: (limit = 8) =>
        call<FleetCommandListResponse>(`/api/fleet/commands?limit=${limit}`, { method: 'GET' }),
    cancel: (commandId: string) =>
        call<FleetCommandView>(`/api/fleet/commands/${encodeURIComponent(commandId)}/cancel`, {
            method: 'POST',
        }),
    /** P2 — a computer's last run of the person's Commands (its Overview). */
    lastForNode: (nodeId: string) =>
        call<FleetCommandLastRunResponse>(
            `/api/fleet/nodes/${encodeURIComponent(nodeId)}/commands/last`,
            {
                method: 'GET',
            },
        ),
    /**
     * P2 — "Open full output": the computer's full output of one run as a
     * Blob (read from the machine), or the refusal (offline, no longer kept).
     */
    fullOutput: async (
        commandId: string,
        runId: string,
        fetchImpl: typeof fetch = browserApiFetch,
    ): Promise<
        { ok: true; blob: Blob; filename: string } | { ok: false; error: CommandErrorRead }
    > => {
        try {
            const response = await fetchImpl(
                `/api/fleet/commands/${encodeURIComponent(commandId)}/runs/${encodeURIComponent(runId)}/output`,
                { method: 'GET', cache: 'no-store' },
            );
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                let body: unknown = null;
                try {
                    body = text ? JSON.parse(text) : null;
                } catch {
                    body = null;
                }
                return { ok: false, error: readCommandError(response.status, body) };
            }
            const disposition = response.headers.get('content-disposition') ?? '';
            const match = /filename="([^"]+)"/.exec(disposition);
            return {
                ok: true,
                blob: await response.blob(),
                filename: match?.[1] ?? 'command-output.log',
            };
        } catch {
            return { ok: false, error: { code: 'network', hint: null, details: {}, status: 0 } };
        }
    },
};

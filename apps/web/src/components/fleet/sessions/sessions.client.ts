'use client';

import type {
    FleetSessionAnswerResponse,
    FleetSessionListResponse,
    FleetSessionRecordingManifest,
    FleetSessionRecordingPage,
    FleetSessionStartRequest,
    FleetSessionView,
} from '@ever-works/contracts';
import { browserApiFetch } from '@/lib/api/browser-api';
import { readSessionError, type SessionErrorRead } from './sessions.shared';

/**
 * Sessions on computers (FL-04 P1b) — the browser's calls to the session BFF
 * routes (`app/api/fleet/…`). Every call answers a result union, never a
 * throw: `{ ok: true, data }` or `{ ok: false, error }` with the CONTRACTS §8
 * code, hint and details the platform sent (a dialog marks the field an
 * `invalid` names; a card shows the eight sessions a `limit_exceeded` lists).
 */
export type SessionResult<T> = { ok: true; data: T } | { ok: false; error: SessionErrorRead };

async function call<T>(
    path: string,
    init: { method: 'GET' | 'POST' | 'PATCH'; body?: Record<string, unknown> },
    fetchImpl: typeof fetch = browserApiFetch,
): Promise<SessionResult<T>> {
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
        if (!response.ok) return { ok: false, error: readSessionError(response.status, body) };
        return { ok: true, data: body as T };
    } catch {
        return { ok: false, error: { code: 'network', hint: null, details: {}, status: 0 } };
    }
}

export const sessionsClient = {
    listForNode: (nodeId: string, query: { state?: 'live' | 'ended'; limit?: number } = {}) => {
        const params = new URLSearchParams();
        if (query.state) params.set('state', query.state);
        if (query.limit) params.set('limit', String(query.limit));
        const suffix = params.toString() ? `?${params.toString()}` : '';
        return call<FleetSessionListResponse>(`/api/fleet/nodes/${encodeURIComponent(nodeId)}/sessions${suffix}`, {
            method: 'GET',
        });
    },
    listForAgent: (agentId: string, limit = 20) =>
        call<FleetSessionListResponse>(`/api/fleet/sessions?agentId=${encodeURIComponent(agentId)}&limit=${limit}`, {
            method: 'GET',
        }),
    start: (nodeId: string, request: FleetSessionStartRequest) =>
        call<FleetSessionView>(`/api/fleet/nodes/${encodeURIComponent(nodeId)}/sessions`, {
            method: 'POST',
            body: request as unknown as Record<string, unknown>,
        }),
    get: (sessionId: string) =>
        call<FleetSessionView>(`/api/fleet/sessions/${encodeURIComponent(sessionId)}`, { method: 'GET' }),
    rename: (sessionId: string, title: string) =>
        call<FleetSessionView>(`/api/fleet/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'PATCH',
            body: { title },
        }),
    end: (sessionId: string) =>
        call<FleetSessionView>(`/api/fleet/sessions/${encodeURIComponent(sessionId)}/end`, {
            method: 'POST',
            body: { confirm: true },
        }),
    /** P3: the recording's manifest. */
    recording: (sessionId: string) =>
        call<FleetSessionRecordingManifest>(`/api/fleet/sessions/${encodeURIComponent(sessionId)}/recording`, {
            method: 'GET',
        }),
    /** P3: one page of the recording, `seq >= from`. */
    recordingPage: (sessionId: string, from: number, limit = 200) =>
        call<FleetSessionRecordingPage>(
            `/api/fleet/sessions/${encodeURIComponent(sessionId)}/recording?from=${from}&limit=${limit}`,
            { method: 'GET' },
        ),
    /** P3: start or stop recording a live session. */
    setRecording: (sessionId: string, on: boolean) =>
        call<FleetSessionView>(`/api/fleet/sessions/${encodeURIComponent(sessionId)}/recording`, {
            method: 'POST',
            body: { on },
        }),
    /** FL-05 P2: answer what a session asks — one option, or a free text. */
    answer: (
        sessionId: string,
        answer: { key: string; optionId?: string; text?: string; source?: 'card' | 'detail' },
    ) =>
        call<FleetSessionAnswerResponse>(`/api/fleet/sessions/${encodeURIComponent(sessionId)}/answer`, {
            method: 'POST',
            body: answer,
        }),
    /** FL-05 P2: opening a session acknowledges its attention (clears unread, never the prompt). */
    acknowledge: (sessionId: string, key: string) =>
        call<FleetSessionView>(`/api/fleet/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'PATCH',
            body: { acknowledge: key },
        }),
    restart: (sessionId: string, size: { cols?: number; rows?: number } = {}) =>
        call<FleetSessionView>(`/api/fleet/sessions/${encodeURIComponent(sessionId)}/restart`, {
            method: 'POST',
            body: size,
        }),
};

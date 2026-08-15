import { type APIRequestContext, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { API_BASE, authedHeaders } from './api';

/**
 * Inbound Triggers helpers (#1712) — signed webhook/API triggers that spawn Tasks.
 *
 * Verified live against http://127.0.0.1:3100 (sqlite in-memory):
 *   POST   /api/inbound-triggers { name, kind?, description?, targetAgentId?, taskTitleTemplate?,
 *            sourceType?, eventMatcher?, taskDescriptionTemplate?, taskTemplateSlug?,
 *            mode?, agentPrompt?, showOnBoard?, replayWindowSec?, autoStart?, defaultVariables? }
 *            → 201 { trigger: InboundTriggerView, secret }  (secret returned ONCE)
 *          InboundTriggerView = { id, name, description|null, kind, status, sourceType,
 *            eventMatcher|null, targetAgentId|null, taskTitleTemplate, taskDescriptionTemplate|null,
 *            taskTemplateSlug|null, mode, agentPrompt|null, showOnBoard, replayWindowSec,
 *            autoStart, defaultVariables|null, fireCount, lastFiredAt|null,
 *            rotatedAt|null, createdAt, updatedAt }  (NO secret material)
 *   GET    /api/inbound-triggers            → { triggers: InboundTriggerView[] }
 *   GET    /api/inbound-triggers/:id        → InboundTriggerView | 404
 *   PATCH  /api/inbound-triggers/:id        → InboundTriggerView | 404
 *   POST   /api/inbound-triggers/:id/rotate-secret → 200 { trigger, secret }
 *   POST   /api/inbound-triggers/:id/fire-now → 200 { ok, taskId, taskSlug, taskTitle } (REAL fire)
 *   GET    /api/inbound-triggers/:id/fires  → { fires: [{ id, origin, status, reason|null,
 *                                                          taskId|null, firedAt }] } (max 50)
 *   POST   /api/inbound-triggers/:id/pause  → 200 InboundTriggerView (status paused)
 *   POST   /api/inbound-triggers/:id/resume → 200 InboundTriggerView (status active)
 *   DELETE /api/inbound-triggers/:id        → 204
 *   POST   /api/inbound-triggers/:id/fire   → 200 { ok, taskId, taskSlug } (PUBLIC, HMAC)
 *            headers: x-everworks-timestamp (unix epoch seconds),
 *                     x-everworks-signature (hex HMAC-SHA256 over `${ts}.${rawBody}`,
 *                     optional `sha256=` prefix). 401 bad sig / stale ts (>5min),
 *                     404 unknown id, 409 while paused, 400 oversized (>64KB) / non-JSON.
 */

export interface TriggerVariable {
    key: string;
    label?: string;
    required: boolean;
}

export interface InboundTriggerView {
    id: string;
    name: string;
    description: string | null;
    kind: 'webhook' | 'api';
    status: string;
    sourceType: 'webhook' | 'event';
    eventMatcher: { source?: string; kind?: string; workId?: string } | null;
    targetAgentId: string | null;
    taskTitleTemplate: string;
    taskDescriptionTemplate: string | null;
    taskTemplateSlug: string | null;
    /** Locked at create time: 'single-task' (prompt) or 'template'. */
    mode: 'single-task' | 'template';
    agentPrompt: string | null;
    showOnBoard: boolean;
    replayWindowSec: number;
    autoStart: 'always' | 'manual';
    defaultVariables: TriggerVariable[] | null;
    fireCount: number;
    lastFiredAt: string | null;
    rotatedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export const TRIGGERS_BASE = `${API_BASE}/api/inbound-triggers`;

export async function createTriggerViaAPI(
    request: APIRequestContext,
    token: string,
    body: {
        name: string;
        kind?: 'webhook' | 'api';
        description?: string;
        targetAgentId?: string;
        taskTitleTemplate?: string;
        taskDescriptionTemplate?: string;
        taskTemplateSlug?: string;
        sourceType?: 'webhook' | 'event';
        eventMatcher?: { source?: string; kind?: string; workId?: string };
        mode?: 'single-task' | 'template';
        agentPrompt?: string;
        showOnBoard?: boolean;
        replayWindowSec?: number;
        autoStart?: 'always' | 'manual';
        defaultVariables?: { key: string; label?: string; required?: boolean }[];
    },
): Promise<{ trigger: InboundTriggerView; secret: string }> {
    const res = await request.post(TRIGGERS_BASE, { headers: authedHeaders(token), data: body });
    expect(res.status(), `createTrigger body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

/** Hex HMAC-SHA256 over `${timestamp}.${rawBody}`, keyed with the raw secret. */
export function signPayload(secret: string, timestamp: string | number, rawBody: string): string {
    return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/** Current unix epoch seconds as a string (the exact header value that gets signed). */
export function nowEpochSeconds(): string {
    return String(Math.floor(Date.now() / 1000));
}

/**
 * Fire a trigger with a correctly-signed payload. Returns the raw Playwright
 * response so callers assert status + body. Pass `overrides` to corrupt the
 * signature / timestamp for negative cases.
 */
export async function fireTrigger(
    request: APIRequestContext,
    triggerId: string,
    secret: string,
    rawBody: string,
    overrides: { signature?: string; timestamp?: string; contentType?: string } = {},
) {
    const ts = overrides.timestamp ?? nowEpochSeconds();
    const sig = overrides.signature ?? signPayload(secret, ts, rawBody);
    return request.post(`${TRIGGERS_BASE}/${triggerId}/fire`, {
        headers: {
            'content-type': overrides.contentType ?? 'application/json',
            'x-everworks-timestamp': ts,
            'x-everworks-signature': sig,
        },
        data: rawBody,
    });
}

'use server';

import { API_URL } from '@/lib/constants';

/**
 * EW-617 G8 — client-side funnel event emit, server-action edition.
 *
 * Fire-and-forget telemetry: the wizard calls this right before
 * `quickCreateWorkAction` to land `wizard_finished`, and any other
 * client-only emit points (landing prompt submit, claim-account UI
 * click) follow the same pattern. Lives as a server action so the
 * actual POST to the platform API happens server-side — avoids a CORS
 * round-trip and keeps API_URL out of the client bundle.
 *
 * Errors are swallowed by design. A funnel emit failing must never
 * break the user flow that triggered it.
 */
export async function emitFunnelEventAction(payload: {
    event: string;
    funnelStep: number;
    correlationId: string;
    timestamp?: string;
    userId?: string;
    workId?: string;
    extra?: Record<string, unknown>;
}): Promise<void> {
    try {
        const body = JSON.stringify({
            ...payload,
            timestamp: payload.timestamp || new Date().toISOString(),
        });
        // 2s timeout — the funnel sink is a logger, but if the API is
        // misbehaving we don't want to slow the wizard's "Generate now"
        // path.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2_000);
        await fetch(`${API_URL}/api/telemetry/funnel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: controller.signal,
            // keepalive helps Chromium send the request even if the
            // wizard immediately navigates away after `quickCreate`.
            keepalive: true,
        }).catch(() => {});
        clearTimeout(timeout);
    } catch {
        // Telemetry must never break the user flow.
    }
}

import { type APIRequestContext, expect } from '@playwright/test';
import { API_BASE, authedHeaders } from './api';

/**
 * Plugins helpers.
 *
 * Verified against a live stack:
 *   - GET  /api/plugins                       → { plugins: [{ id, name, category, capabilities, enabled?, … }] }
 *   - GET  /api/plugins/:id                    → single plugin object (+ readme, settingsSchema)
 *   - POST /api/plugins/:id/enable  { settings?, secretSettings?, autoEnableForWorks? }
 *   - POST /api/plugins/:id/disable
 *   - PATCH /api/plugins/:id/settings { settings?, secretSettings? }
 *       NB: the openrouter schema requires BOTH `apiKey` and `defaultModel`;
 *           a PATCH missing either returns 400 "Missing required fields…".
 *   - GET  /api/plugins/:id/models            → [{ id, name, description }]  (AI providers)
 */

export interface PluginSummary {
    id: string;
    name: string;
    category: string;
    capabilities: string[];
    enabled?: boolean;
}

export async function listPluginsViaAPI(
    request: APIRequestContext,
    token: string,
): Promise<PluginSummary[]> {
    const res = await request.get(`${API_BASE}/api/plugins`, { headers: authedHeaders(token) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    return body.plugins ?? body.data ?? [];
}

export async function getPluginViaAPI(
    request: APIRequestContext,
    token: string,
    pluginId: string,
): Promise<Record<string, unknown>> {
    const res = await request.get(`${API_BASE}/api/plugins/${pluginId}`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `getPlugin body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

export async function enablePluginViaAPI(
    request: APIRequestContext,
    token: string,
    pluginId: string,
    body: {
        settings?: Record<string, unknown>;
        secretSettings?: Record<string, unknown>;
        autoEnableForWorks?: boolean;
    } = {},
): Promise<Record<string, unknown>> {
    const res = await request.post(`${API_BASE}/api/plugins/${pluginId}/enable`, {
        headers: authedHeaders(token),
        data: body,
    });
    expect(res.status(), `enable body=${await res.text().catch(() => '')}`).toBeLessThan(300);
    return res.json();
}

export async function disablePluginViaAPI(
    request: APIRequestContext,
    token: string,
    pluginId: string,
): Promise<Record<string, unknown>> {
    const res = await request.post(`${API_BASE}/api/plugins/${pluginId}/disable`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), `disable body=${await res.text().catch(() => '')}`).toBeLessThan(300);
    return res.json();
}

export async function patchPluginSettingsViaAPI(
    request: APIRequestContext,
    token: string,
    pluginId: string,
    body: { settings?: Record<string, unknown>; secretSettings?: Record<string, unknown> },
): Promise<{ ok: boolean; status: number; body: unknown }> {
    const res = await request.patch(`${API_BASE}/api/plugins/${pluginId}/settings`, {
        headers: authedHeaders(token),
        data: body,
    });
    return { ok: res.ok(), status: res.status(), body: await res.json().catch(() => null) };
}

export async function listPluginModelsViaAPI(
    request: APIRequestContext,
    token: string,
    pluginId: string,
): Promise<Array<{ id: string; name?: string }>> {
    const res = await request.get(`${API_BASE}/api/plugins/${pluginId}/models`, {
        headers: authedHeaders(token),
    });
    if (!res.ok()) return [];
    const body = await res.json();
    return Array.isArray(body) ? body : (body.data ?? body.models ?? []);
}

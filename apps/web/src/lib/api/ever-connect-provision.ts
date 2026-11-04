import 'server-only';
import { serverFetch } from './server-api';

/**
 * The web's client for `/api/ever-connect/provision*`: creating a company a person
 * asked for in Ever. A refusal surfaces as {@link ProvisionRequestError}: the HTTP
 * status and the wire code. The API's English message is not kept; a caller
 * translates the code instead.
 *
 * Every call selects personal scope: the company lands in the person's own Tenant,
 * whichever workspace they last looked at.
 */

const BASE = '/ever-connect/provision';

/** What the pages show of a request. */
export interface ProvisionDisplay {
    handle: string;
    displayName: string;
    legalName: string | null;
    country: string | null;
    staffTemplateSlug: string | null;
    firstMission: { title: string; goal: string } | null;
}

export interface ProvisionIntake {
    jti: string;
    provisionTxn: string;
    display: ProvisionDisplay;
    capabilities: {
        provisionHandoff: boolean;
        provisionCompany: boolean;
        everIdAvailable: boolean;
    };
    expiresAt: string;
}

export interface ProvisionSummary {
    jti: string;
    display: ProvisionDisplay;
    capabilities: { provisionHandoff: boolean; provisionCompany: boolean };
    existing: { organizationId: string; organizationSlug: string } | null;
    returnTo: string;
    expiresAt: string;
}

export interface ProvisionCompanyRequest {
    provisionTxn: string;
    name?: string;
    legalName?: string;
    slug?: string;
    staffTemplateSlug?: string | null;
    firstMission?: { title: string; goal: string } | null;
}

export interface ProvisionCompanyAnswer {
    status: 'created' | 'partial';
    organizationId: string;
    organizationSlug: string;
    partial: boolean;
    returnTo: string;
}

export class ProvisionRequestError extends Error {
    constructor(
        readonly status: number,
        readonly code: string | null,
    ) {
        super(`Provisioning request refused (${status} ${code ?? 'no code'})`);
        this.name = 'ProvisionRequestError';
    }
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await serverFetch<Response>(`${BASE}${path}`, {
        ...init,
        rawResponse: true,
        publicRouteScope: 'personal',
    });
    if (!response.ok) {
        let code: string | null = null;
        try {
            const body = (await response.json()) as { code?: unknown };
            code = typeof body?.code === 'string' ? body.code : null;
        } catch {
            code = null;
        }
        throw new ProvisionRequestError(response.status, code);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
}

export const everConnectProvisionAPI = {
    intake: (intent: string) =>
        request<ProvisionIntake>('', { method: 'POST', body: JSON.stringify({ intent }) }),

    summary: (provisionTxn: string) =>
        request<ProvisionSummary>('/summary', {
            method: 'POST',
            body: JSON.stringify({ provisionTxn }),
        }),

    company: (body: ProvisionCompanyRequest, idempotencyKey: string) =>
        request<ProvisionCompanyAnswer>('/company', {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(body),
        }),

    reject: (jti: string) =>
        request<{ status: 'refused'; returnTo: string }>(
            `/intents/${encodeURIComponent(jti)}/reject`,
            { method: 'POST', body: '{}' },
        ),
};

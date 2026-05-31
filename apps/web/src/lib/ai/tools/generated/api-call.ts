import 'server-only';
import { serverFetch, serverMutation, ApiResponseError } from '@/lib/api/server-api';
import { buildEndpoint, type EndpointInput, type HttpMethod } from './endpoint';

export type { HttpMethod };

export interface ApiCallInput extends EndpointInput {
    method: HttpMethod;
    body?: Record<string, unknown>;
}

export interface ApiCallResult {
    success: boolean;
    status?: number;
    data?: unknown;
    error?: string;
    code?: string;
}

/**
 * Single entry point every generated chat tool routes through. Runs as the
 * logged-in user — `serverFetch` injects the JWT from the auth cookie, so the
 * API enforces ownership/scope exactly as it does for the UI. Errors are
 * normalised into a structured result the model can summarise gracefully
 * instead of throwing and aborting the tool loop.
 */
export async function callApi(input: ApiCallInput): Promise<ApiCallResult> {
    const endpoint = buildEndpoint(input);

    try {
        if (input.method === 'GET') {
            const data = await serverFetch<unknown>(endpoint, { method: 'GET' });
            return { success: true, data };
        }

        const data = await serverMutation<unknown>({
            endpoint,
            method: input.method,
            data: input.body ?? {},
            wrapInData: false,
        });
        return { success: true, data };
    } catch (err) {
        if (err instanceof ApiResponseError) {
            return {
                success: false,
                status: err.statusCode,
                error: err.message,
                code: err.code,
            };
        }
        return {
            success: false,
            error: err instanceof Error ? err.message : 'Request failed',
        };
    }
}

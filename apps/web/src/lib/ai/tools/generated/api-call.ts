import 'server-only';
import { serverFetch, serverMutation, ApiResponseError } from '@/lib/api/server-api';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiCallInput {
    method: HttpMethod;
    /** Full OpenAPI path as declared by the controller, e.g. "/api/agents/{id}". */
    path: string;
    pathParams?: Record<string, string | number>;
    query?: Record<string, string | number | boolean | undefined | null>;
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
 * Resolve a controller path + params into the endpoint string expected by
 * `serverFetch`/`serverMutation`. `API_URL` already ends in `/api`, and the
 * web API client passes paths WITHOUT the `/api` prefix (e.g. `/agents/{id}`),
 * so we strip the leading `/api` segment — mirroring the MCP tool handler.
 */
function buildEndpoint(input: ApiCallInput): string {
    let endpoint = input.path.startsWith('/api') ? input.path.slice(4) : input.path;

    if (input.pathParams) {
        for (const [key, value] of Object.entries(input.pathParams)) {
            endpoint = endpoint.replace(`{${key}}`, encodeURIComponent(String(value)));
        }
    }

    if (input.query) {
        const qs = new URLSearchParams();
        for (const [key, value] of Object.entries(input.query)) {
            if (value !== undefined && value !== null && value !== '') {
                qs.append(key, String(value));
            }
        }
        const search = qs.toString();
        if (search) endpoint += `?${search}`;
    }

    return endpoint;
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

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface EndpointInput {
    /** Full OpenAPI path as declared by the controller, e.g. "/api/agents/{id}". */
    path: string;
    pathParams?: Record<string, string | number>;
    query?: Record<string, string | number | boolean | undefined | null>;
}

/**
 * Resolve a controller path + params into the endpoint string expected by
 * `serverFetch`/`serverMutation`. `API_URL` already ends in `/api`, and the
 * web API client passes paths WITHOUT the `/api` prefix (e.g. `/agents/{id}`),
 * so we strip the leading `/api` segment — mirroring the MCP tool handler.
 *
 * Pure (no I/O, no `server-only`) so it can be unit-tested directly. This is
 * the highest-risk piece — a bug here 404s every generated tool.
 */
export function buildEndpoint(input: EndpointInput): string {
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

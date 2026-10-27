import type { FleetConfirmArgs, FleetToolErrorBody } from '@ever-works/contracts';
import { requireAuth } from '../auth';
import { getHttpClient } from '../../services/http-client';
import { confirmInteractively } from './fleet-confirm';
import { emitFleetError, emitFleetOk, readFleetCliError } from './fleet-output';

/**
 * A typed wrapper over the CLI's HTTP client for `ever-works fleet …` (FL-19,
 * plan §9.3): every verb is "sign in, call one platform route, print the
 * envelope, exit with the contract's code". Paths are under `/api` (the client
 * adds it), e.g. `/fleet/status`.
 */

export type FleetHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface FleetCliRequest {
    method: FleetHttpMethod;
    path: string;
    body?: Record<string, unknown>;
    query?: Record<string, string | number | boolean | undefined | null>;
}

/** `path?a=1&b=2`, skipping empty values. */
export function fleetPathWithQuery(path: string, query: FleetCliRequest['query']): string {
    if (!query) return path;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        params.set(key, String(value));
    }
    const text = params.toString();
    return text ? `${path}${path.includes('?') ? '&' : '?'}${text}` : path;
}

/** One call; throws the HTTP error for the caller to read. */
export async function fleetRequest<T>(request: FleetCliRequest): Promise<T> {
    const client = getHttpClient();
    const url = fleetPathWithQuery(request.path, request.query);
    switch (request.method) {
        case 'GET':
            return (await client.get<T>(url)).data;
        case 'POST':
            return (await client.post<T>(url, request.body ?? {})).data;
        case 'PATCH':
            return (await client.patch<T>(url, request.body ?? {})).data;
        case 'DELETE':
            return (await client.delete<T>(url, request.body ? { data: request.body } : undefined))
                .data;
    }
}

/**
 * Sign in, call, print, exit. A `confirmation_required` answer is asked on a
 * TTY and repeated once with the field; otherwise it exits 2 with the summary.
 */
export async function runFleetVerb<T>(
    json: boolean,
    request: FleetCliRequest,
    human: (data: T) => void,
    confirm: FleetConfirmArgs = {},
): Promise<never> {
    await requireAuth();
    const body = request.method === 'GET' ? undefined : { ...(request.body ?? {}), ...confirm };
    let refusal: FleetToolErrorBody;
    try {
        const data = await fleetRequest<T>({ ...request, ...(body ? { body } : {}) });
        return emitFleetOk(json, data, human);
    } catch (error) {
        refusal = readFleetCliError(error);
    }
    if (refusal.code === 'confirmation_required') {
        const extra = await confirmInteractively(refusal, json);
        if (extra) {
            try {
                const data = await fleetRequest<T>({
                    ...request,
                    body: { ...(body ?? {}), ...extra },
                });
                return emitFleetOk(json, data, human);
            } catch (error) {
                return emitFleetError(json, readFleetCliError(error));
            }
        }
    }
    return emitFleetError(json, refusal);
}

/** A computer as `--on` names it: its id, or its name (case-insensitive) among the visible ones. */
export async function resolveFleetNodeId(json: boolean, ref: string | undefined): Promise<string> {
    if (!ref || ref.trim().length === 0) {
        return emitFleetError(json, {
            code: 'invalid',
            hint: '--on <computer> is required',
            details: { field: 'on' },
        });
    }
    const value = ref.trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value;
    await requireAuth();
    let nodes: Array<{ id: string; name: string }>;
    try {
        nodes = await fleetRequest<Array<{ id: string; name: string }>>({
            method: 'GET',
            path: '/fleet/nodes',
            query: { scope: 'visible' },
        });
    } catch (error) {
        return emitFleetError(json, readFleetCliError(error));
    }
    const matches = nodes.filter((node) => node.name.toLowerCase() === value.toLowerCase());
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) {
        return emitFleetError(json, {
            code: 'invalid',
            hint: `${matches.length} computers are named ${value}; pass the id instead`,
            details: { field: 'on', ids: matches.map((node) => node.id) },
        });
    }
    return emitFleetError(json, {
        code: 'not_found',
        hint: `no computer named ${value}`,
        details: { field: 'on' },
    });
}

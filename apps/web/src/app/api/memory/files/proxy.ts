import { NextRequest } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * Shared same-origin proxy for the /api/memory/files BFF routes.
 *
 * Mirrors the `memory/uploads` proxy: the bearer comes from the auth
 * cookie, the query string is passed through untouched, and multipart
 * bodies are STREAMED upstream (duplex half) so the boundary survives
 * for NestJS's FileInterceptor. Responses are relayed as-is — including
 * binary downloads — rather than re-parsed, so Content-Type /
 * Content-Disposition from the API reach the browser intact.
 */
export async function proxyMemoryFiles(
    request: NextRequest,
    upstreamPath: string,
    init: { method: string; body?: BodyInit | null } = { method: 'GET' },
): Promise<Response> {
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    headers.set('Accept', request.headers.get('accept') ?? 'application/json');
    const contentType = request.headers.get('content-type');
    if (contentType && init.body !== undefined) {
        headers.set('Content-Type', contentType);
    }
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const upstream = await fetch(`${API_URL}${upstreamPath}${request.nextUrl.search}`, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: init.body, duplex: 'half' } : {}),
        cache: 'no-store',
    } as RequestInit & { duplex?: 'half' });

    const responseHeaders = new Headers();
    for (const name of ['content-type', 'content-length', 'content-disposition']) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

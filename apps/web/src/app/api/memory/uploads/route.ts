import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * Proxy for global-Memory originals — `GET`/`POST /api/memory/uploads`.
 *
 * Mirrors the per-Work `works/[id]/kb/uploads` proxy exactly, minus the
 * `id` segment: the target Organization is resolved server-side from the
 * request scope, never from the URL, so there is no org id for a client
 * to tamper with.
 *
 * The POST body is streamed upstream rather than parsed here so the
 * multipart boundary survives intact for NestJS's `FileInterceptor`.
 */

export async function GET(request: NextRequest) {
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    headers.set('Accept', 'application/json');
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const upstream = await fetch(`${API_URL}/memory/uploads${request.nextUrl.search}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
    });

    const upstreamContentType = upstream.headers.get('content-type') ?? 'application/json';
    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return new Response(text, {
            status: upstream.status,
            headers: { 'Content-Type': upstreamContentType, 'Cache-Control': 'no-store' },
        });
    }

    const body = await upstream.json().catch(() => null);
    return NextResponse.json(body ?? { items: [], total: 0 }, { status: 200 });
}

export async function POST(request: NextRequest) {
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    const contentType = request.headers.get('content-type');
    if (contentType) {
        headers.set('Content-Type', contentType);
    }
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const upstream = await fetch(`${API_URL}/memory/uploads`, {
        method: 'POST',
        headers,
        body: request.body,
        // Required for streaming request bodies on Node's fetch.
        duplex: 'half',
        cache: 'no-store',
    } as RequestInit & { duplex: 'half' });

    const upstreamContentType = upstream.headers.get('content-type') ?? 'application/json';
    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return new Response(text, {
            status: upstream.status,
            headers: { 'Content-Type': upstreamContentType, 'Cache-Control': 'no-store' },
        });
    }

    const body = await upstream.json().catch(() => null);
    return NextResponse.json(body ?? {}, { status: upstream.status });
}

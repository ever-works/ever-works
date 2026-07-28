import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * Proxy for `POST /api/transcription` — voice dictation.
 *
 * Streams the recorded clip upstream so the multipart boundary survives
 * for NestJS's `FileInterceptor`, and surfaces the upstream status
 * verbatim: the client distinguishes 503 (no transcription provider
 * configured — hide the control) from a genuine failure.
 */
export async function POST(request: NextRequest) {
    const token = await getAuthAccessCookie();
    if (!token) {
        return new Response('Unauthorized', { status: 401 });
    }

    const headers = new Headers();
    const contentType = request.headers.get('content-type');
    if (contentType) {
        headers.set('Content-Type', contentType);
    }
    headers.set('Authorization', `Bearer ${token}`);

    const upstream = await fetch(`${API_URL}/transcription`, {
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
    return NextResponse.json(body ?? {}, { status: 200 });
}

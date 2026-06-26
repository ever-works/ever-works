import { NextRequest } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ id: string; uploadId: string }> };

/**
 * Download proxy for a KB upload — backs the Task attachment download
 * links (and any other surface that needs the raw bytes from the
 * browser). Forwards `GET /api/works/[id]/kb/uploads/[uploadId]/download`
 * to the NestJS `GET /works/:id/kb/uploads/:uploadId/download` route,
 * passing the auth cookie through as a bearer and streaming the body
 * back with the upstream Content-Type / Content-Disposition intact.
 *
 * Mirrors the upload proxy (`../../route.ts`): auth cookie → Bearer,
 * `cache: 'no-store'`, and the upstream status + body surfaced verbatim
 * on error so the client sees the right 403 / 404 messaging.
 */
export async function GET(_request: NextRequest, { params }: RouteContext) {
    const { id, uploadId } = await params;
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const upstream = await fetch(`${API_URL}/works/${id}/kb/uploads/${uploadId}/download`, {
        method: 'GET',
        headers,
        cache: 'no-store',
    });

    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return new Response(text, {
            status: upstream.status,
            headers: { 'Cache-Control': 'no-store' },
        });
    }

    const respHeaders = new Headers();
    const contentType = upstream.headers.get('content-type');
    if (contentType) respHeaders.set('Content-Type', contentType);
    const contentDisposition = upstream.headers.get('content-disposition');
    if (contentDisposition) respHeaders.set('Content-Disposition', contentDisposition);
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) respHeaders.set('Content-Length', contentLength);
    respHeaders.set('Cache-Control', 'private, no-store');

    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

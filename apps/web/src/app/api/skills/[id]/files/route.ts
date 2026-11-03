import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * Client-side proxy for `POST /api/skills/:id/files` — multipart
 * uploads go browser → this route → NestJS with the session cookie
 * translated to a Bearer (same posture as `/api/uploads/file`). The
 * FormData is forwarded verbatim (fields: `file`, optional `kind`).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const token = await getAuthAccessCookie();
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);

    const form = await request.formData();
    const response = await fetch(`${API_URL}/skills/${encodeURIComponent(id)}/files`, {
        method: 'POST',
        headers,
        body: form,
        cache: 'no-store',
    });

    const body = await response.json().catch(() => ({ error: 'Upload failed' }));
    return NextResponse.json(body, { status: response.status });
}

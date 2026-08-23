import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';
import { applyBffWorkspaceScope } from '@/lib/api/bff-scope';

export async function GET(request: NextRequest) {
    return proxyActiveScope(request, 'GET');
}

export async function POST(request: NextRequest) {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    return proxyActiveScope(request, 'POST', body);
}

async function proxyActiveScope(request: NextRequest, method: 'GET' | 'POST', body?: unknown) {
    const token = await getAuthAccessCookie();
    if (!token) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const baseHeaders = new Headers();
    baseHeaders.set('Authorization', `Bearer ${token}`);
    if (method === 'POST') {
        baseHeaders.set('Content-Type', 'application/json');
    }

    let headers: Headers;
    try {
        headers = applyBffWorkspaceScope(request, baseHeaders);
    } catch {
        return NextResponse.json({ error: 'Invalid workspace scope' }, { status: 400 });
    }

    try {
        const upstream = await fetch(`${API_URL}/users/me/scope`, {
            method,
            headers,
            body: method === 'POST' ? JSON.stringify(body) : undefined,
            cache: 'no-store',
        });
        const text = await upstream.text();

        return new NextResponse(text || null, {
            status: upstream.status,
            headers: {
                'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
            },
        });
    } catch (error) {
        console.error(`Failed to proxy ${method} /api/users/me/scope:`, error);
        return NextResponse.json({ error: 'Failed to access active scope' }, { status: 500 });
    }
}

import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

export async function GET(_request: NextRequest) {
    return proxyActiveScope('GET');
}

export async function POST(request: NextRequest) {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    return proxyActiveScope('POST', body);
}

async function proxyActiveScope(method: 'GET' | 'POST', body?: unknown) {
    const token = await getAuthAccessCookie();
    if (!token) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const headers = new Headers();
    headers.set('Authorization', `Bearer ${token}`);
    if (method === 'POST') {
        headers.set('Content-Type', 'application/json');
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

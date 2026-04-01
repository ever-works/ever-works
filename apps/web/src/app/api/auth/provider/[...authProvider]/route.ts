import { API_URL } from '@/lib/constants';
import { splitSetCookieHeader } from '@ever-works/plugin';
import { NextRequest, NextResponse } from 'next/server';

type RouteContext = {
    params: Promise<{
        authProvider?: string[];
    }>;
};

function getUpstreamCandidates(routePath: string, search: string): URL[] {
    const primary = new URL(`${API_URL}/auth/provider/${routePath}`);
    primary.search = search;

    const candidates = [primary];

    if (primary.hostname === 'localhost') {
        const fallback = new URL(primary.toString());
        fallback.hostname = '127.0.0.1';
        candidates.push(fallback);
    }

    return candidates;
}

async function proxyAuthProviderRequest(request: NextRequest, context: RouteContext) {
    const { authProvider = [] } = await context.params;
    const routePath = authProvider.join('/');

    const headers = new Headers(request.headers);
    headers.set('x-forwarded-host', request.headers.get('host') || '');
    headers.set('x-forwarded-proto', request.nextUrl.protocol.replace(':', ''));

    const body =
        request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : await request.arrayBuffer();

    let response: Response | null = null;
    let lastError: unknown = null;

    for (const upstreamUrl of getUpstreamCandidates(routePath, request.nextUrl.search)) {
        try {
            response = await fetch(upstreamUrl, {
                method: request.method,
                headers,
                body: body && body.byteLength > 0 ? body : undefined,
                redirect: 'manual',
            });
            break;
        } catch (error) {
            lastError = error;
        }
    }

    if (!response) {
        console.error('[auth-provider proxy] upstream unavailable', {
            path: routePath,
            error: lastError,
        });

        return NextResponse.json(
            {
                error: 'Authentication service is temporarily unavailable',
            },
            { status: 503 },
        );
    }

    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') {
            return;
        }
        responseHeaders.append(key, value);
    });

    const nextResponse = new NextResponse(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
    });

    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const cookie of setCookies) {
        nextResponse.headers.append('set-cookie', cookie);
    }

    if (setCookies.length === 0) {
        const rawSetCookie = response.headers.get('set-cookie');
        if (rawSetCookie) {
            for (const cookie of splitSetCookieHeader(rawSetCookie)) {
                nextResponse.headers.append('set-cookie', cookie);
            }
        }
    }

    return nextResponse;
}

export async function GET(request: NextRequest, context: RouteContext) {
    return proxyAuthProviderRequest(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
    return proxyAuthProviderRequest(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext) {
    return proxyAuthProviderRequest(request, context);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
    return proxyAuthProviderRequest(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
    return proxyAuthProviderRequest(request, context);
}

import { API_URL } from '@/lib/constants';
import { NextRequest, NextResponse } from 'next/server';

type RouteContext = {
    params: Promise<{
        betterAuth?: string[];
    }>;
};

function splitSetCookieHeader(headerValue: string): string[] {
    const cookies: string[] = [];
    let current = '';
    let inExpiresAttribute = false;

    for (let i = 0; i < headerValue.length; i++) {
        const char = headerValue[i];
        const nextPart = headerValue.slice(i).toLowerCase();

        if (!inExpiresAttribute && nextPart.startsWith('expires=')) {
            inExpiresAttribute = true;
        }

        if (char === ',') {
            if (inExpiresAttribute) {
                current += char;
                continue;
            }

            if (current.trim()) {
                cookies.push(current.trim());
            }
            current = '';
            continue;
        }

        if (inExpiresAttribute && char === ';') {
            inExpiresAttribute = false;
        }

        current += char;
    }

    if (current.trim()) {
        cookies.push(current.trim());
    }

    return cookies;
}

async function proxyBetterAuthRequest(request: NextRequest, context: RouteContext) {
    const { betterAuth = [] } = await context.params;
    const routePath = betterAuth.join('/');
    const upstreamUrl = new URL(`${API_URL}/auth/better-auth/${betterAuth.join('/')}`);
    upstreamUrl.search = request.nextUrl.search;

    const headers = new Headers(request.headers);
    headers.set('x-forwarded-host', request.headers.get('host') || '');
    headers.set('x-forwarded-proto', request.nextUrl.protocol.replace(':', ''));

    const body =
        request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : await request.arrayBuffer();

    const response = await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body: body && body.byteLength > 0 ? body : undefined,
        redirect: 'manual',
    });

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

    if (routePath.startsWith('callback/')) {
        const forwardedSetCookies = nextResponse.headers.get('set-cookie');
        console.log('[better-auth proxy] callback response', {
            path: routePath,
            status: response.status,
            location: response.headers.get('location'),
            hasSessionCookie:
                forwardedSetCookies?.includes('better-auth.session_token') ||
                forwardedSetCookies?.includes('__Secure-better-auth.session_token') ||
                false,
            setCookieHeader: forwardedSetCookies,
        });
    }

    return nextResponse;
}

export async function GET(request: NextRequest, context: RouteContext) {
    return proxyBetterAuthRequest(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
    return proxyBetterAuthRequest(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext) {
    return proxyBetterAuthRequest(request, context);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
    return proxyBetterAuthRequest(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
    return proxyBetterAuthRequest(request, context);
}

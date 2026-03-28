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

function getUpstreamCandidates(routePath: string, search: string): URL[] {
    const primary = new URL(`${API_URL}/auth/better-auth/${routePath}`);
    primary.search = search;

    const candidates = [primary];

    if (primary.hostname === 'localhost') {
        const fallback = new URL(primary.toString());
        fallback.hostname = '127.0.0.1';
        candidates.push(fallback);
    }

    return candidates;
}

async function proxyBetterAuthRequest(request: NextRequest, context: RouteContext) {
    const { betterAuth = [] } = await context.params;
    const routePath = betterAuth.join('/');

    if (routePath === 'sign-in/social') {
        console.log('[better-auth proxy] social start request', {
            provider: request.headers.get('content-type')?.includes('application/json')
                ? 'json'
                : 'unknown',
            hasExistingStateCookie:
                request.cookies.has('better-auth.state') ||
                request.cookies.has('__Secure-better-auth.state'),
        });
    }

    if (routePath.startsWith('callback/')) {
        console.log('[better-auth proxy] callback request', {
            path: routePath,
            stateParam: request.nextUrl.searchParams.get('state'),
            stateCookie:
                request.cookies.get('better-auth.state')?.value ||
                request.cookies.get('__Secure-better-auth.state')?.value ||
                null,
        });
    }

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
        console.error('[better-auth proxy] upstream unavailable', {
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

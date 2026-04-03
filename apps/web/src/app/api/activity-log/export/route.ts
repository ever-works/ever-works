import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthSessionCookieHeader } from '@/lib/auth/cookies';

async function fetchExportCsv(request: NextRequest, authSessionCookies?: string) {
    const headers = new Headers();

    if (authSessionCookies) {
        headers.set('Cookie', authSessionCookies);
    }

    return fetch(`${API_URL}/activity-log/export${request.nextUrl.search}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
    });
}

export async function GET(request: NextRequest) {
    const authSessionCookies = await getAuthSessionCookieHeader();
    const response = await fetchExportCsv(request, authSessionCookies);

    if (!response.ok) {
        return NextResponse.json(
            { error: 'Failed to export activity log' },
            { status: response.status || 500 },
        );
    }

    const csv = await response.text();

    return new Response(csv, {
        status: 200,
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename=activity-log.csv',
        },
    });
}

import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * EW-602 — Next.js proxy for the per-Work usage CSV export.
 * Forwards the auth cookie to the backend as a Bearer token, streams
 * the CSV body back, and re-uses the backend's Content-Disposition
 * filename header so the download lands with a stable name.
 *
 * Mirrors apps/web/src/app/api/activity-log/export/route.ts.
 */
type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteParams) {
    const { id } = await context.params;
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const response = await fetch(
        `${API_URL}/works/${id}/usage/export${request.nextUrl.search}`,
        {
            method: 'GET',
            headers,
            cache: 'no-store',
        },
    );

    if (!response.ok) {
        return NextResponse.json(
            { error: 'Failed to export usage data' },
            { status: response.status || 500 },
        );
    }

    const csv = await response.text();
    const disposition =
        response.headers.get('content-disposition') ??
        `attachment; filename="usage-${id}.csv"`;

    return new Response(csv, {
        status: 200,
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': disposition,
        },
    });
}

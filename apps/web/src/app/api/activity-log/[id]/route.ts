import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

async function fetchActivity(id: string, authToken?: string) {
    const headers = new Headers();

    if (authToken) {
        headers.set('Authorization', `Bearer ${authToken}`);
    }

    return fetch(`${API_URL}/activity-log/${id}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
    });
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const token = await getAuthAccessCookie();
    const response = await fetchActivity(id, token);

    if (!response.ok) {
        return NextResponse.json(
            { error: 'Failed to fetch activity details' },
            { status: response.status || 500 },
        );
    }

    const activity = await response.json();
    return NextResponse.json(activity);
}

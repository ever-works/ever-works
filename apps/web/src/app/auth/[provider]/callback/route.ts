import { NextRequest, NextResponse } from 'next/server';
import { getAuthCookie } from '@/lib/auth/cookies';
import { handleServerError } from '@/lib/api/server-api';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ provider: string }> },
) {
    const { provider } = await params;

    const queryParams = request.nextUrl.searchParams.toString();

    return NextResponse.json({ provider, queryParams });
}

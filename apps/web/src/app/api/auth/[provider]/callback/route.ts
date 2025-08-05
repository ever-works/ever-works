import { NextRequest, NextResponse } from 'next/server';
import { getAuthCookie } from '@/lib/auth/cookies';
import { handleServerError } from '@/lib/api/server-api';

export async function GET(request: NextRequest) {
    const provider = request.nextUrl.searchParams.get('provider');
    const code = request.nextUrl.searchParams.get('code');
    const state = request.nextUrl.searchParams.get('state');
}

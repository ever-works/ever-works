import { NextResponse } from 'next/server';

export async function GET() {
    return NextResponse.json(
        {
            error: 'This route is deprecated. Use the BetterAuth client via /api/auth/better-auth instead.',
        },
        { status: 410 },
    );
}

import { NextResponse } from 'next/server';

export async function GET() {
    return NextResponse.json(
        {
            error: 'This route is deprecated. Use the auth provider client via /api/auth/provider instead.',
        },
        { status: 410 },
    );
}

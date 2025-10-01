import { healthAPI } from '@/lib/api';
import { NextResponse } from 'next/server';

export async function GET() {
    return NextResponse.json(
        {
            status: 'OK',
            message: 'Application is healthy',
        },
        { status: 200 },
    );
}

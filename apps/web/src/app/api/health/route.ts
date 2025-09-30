import { healthAPI } from '@/lib/api';
import { NextResponse } from 'next/server';

export async function GET() {
    try {
        // await healthAPI.check();
    } catch (error) {
        console.error('Health check error:', error);

        return NextResponse.json(
            {
                status: 'ERROR',
                message: 'Application is unhealthy, API is not responding',
            },
            { status: 500 },
        );
    }

    return NextResponse.json(
        {
            status: 'OK',
            message: 'Application is healthy',
        },
        { status: 200 },
    );
}

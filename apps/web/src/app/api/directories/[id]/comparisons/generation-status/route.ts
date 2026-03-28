import { NextRequest, NextResponse } from 'next/server';
import { directoryAPI } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getAuthFromCookie();
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    try {
        const status = await directoryAPI.getComparisonGenerationStatus(id);
        return NextResponse.json(status, {
            headers: { 'Cache-Control': 'no-store' },
        });
    } catch {
        return NextResponse.json({ generating: false }, { status: 200 });
    }
}

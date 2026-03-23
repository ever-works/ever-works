import { NextRequest, NextResponse } from 'next/server';
import { directoryAPI } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

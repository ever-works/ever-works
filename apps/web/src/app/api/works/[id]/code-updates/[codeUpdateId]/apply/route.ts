import { codeUpdateAPI } from '@/lib/api/code-update';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string; codeUpdateId: string }> },
) {
    const { id, codeUpdateId } = await params;
    try {
        const data = await codeUpdateAPI.apply(id, codeUpdateId);
        return NextResponse.json(data);
    } catch (error) {
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'failed_to_apply' },
            { status: 400 },
        );
    }
}

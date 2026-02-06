import { NextRequest, NextResponse } from 'next/server';
import { pluginsAPI } from '@/lib/api/plugins';

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ pluginId: string }> },
) {
    try {
        const { pluginId } = await params;
        const models = await pluginsAPI.listModels(pluginId);
        return NextResponse.json(models);
    } catch {
        return NextResponse.json([], { status: 200 });
    }
}

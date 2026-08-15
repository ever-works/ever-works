import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from '../../proxy';

/** Proxy — `GET /api/memory/files/:id/download` (binary passthrough). */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    return proxyMemoryFiles(request, `/memory/files/${encodeURIComponent(id)}/download`);
}

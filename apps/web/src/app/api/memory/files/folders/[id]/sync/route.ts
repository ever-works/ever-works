import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from '../../../proxy';

/** Proxy — `POST /api/memory/files/folders/:id/sync` (manual "Sync now"). */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    return proxyMemoryFiles(request, `/memory/files/folders/${encodeURIComponent(id)}/sync`, {
        method: 'POST',
        body: null,
    });
}

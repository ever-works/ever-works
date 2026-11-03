import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from '../../proxy';

/** Proxy — `PATCH` / `DELETE /api/memory/files/folders/:id`. */

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    return proxyMemoryFiles(request, `/memory/files/folders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: request.body,
    });
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    return proxyMemoryFiles(request, `/memory/files/folders/${encodeURIComponent(id)}`, {
        method: 'DELETE',
    });
}

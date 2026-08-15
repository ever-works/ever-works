import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from '../proxy';

/** Proxy — `PATCH /api/memory/files/move` (batch file → folder move). */
export async function PATCH(request: NextRequest) {
    return proxyMemoryFiles(request, '/memory/files/move', {
        method: 'PATCH',
        body: request.body,
    });
}

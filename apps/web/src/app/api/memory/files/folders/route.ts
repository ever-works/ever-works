import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from '../proxy';

/** Proxy — `POST /api/memory/files/folders` (create folder). */
export async function POST(request: NextRequest) {
    return proxyMemoryFiles(request, '/memory/files/folders', {
        method: 'POST',
        body: request.body,
    });
}

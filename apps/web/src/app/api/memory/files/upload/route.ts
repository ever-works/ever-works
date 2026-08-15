import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from '../proxy';

/** Proxy — `POST /api/memory/files/upload` (multipart, streamed upstream). */
export async function POST(request: NextRequest) {
    return proxyMemoryFiles(request, '/memory/files/upload', {
        method: 'POST',
        body: request.body,
    });
}

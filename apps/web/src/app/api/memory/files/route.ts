import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from './proxy';

/** Proxy — `GET /api/memory/files` (unified list). */
export async function GET(request: NextRequest) {
    return proxyMemoryFiles(request, '/memory/files');
}

import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import type { WorkBlueprintEntry } from '@/lib/api/work-templates';

/**
 * Works Templates spec (ADR-014) — web BFF proxy for
 * `GET /api/work-templates?chipType=<chip>`.
 *
 * Mirrors the shape of the other same-origin proxies (e.g.
 * `app/api/organizations/check-slug/route.ts`) so the Create-Work client can
 * hit a same-origin URL and the browser never needs to know `API_URL`. The
 * upstream endpoint is `@Public()` and returns `[]` on any failure, so this
 * proxy attaches no auth cookie and always resolves to a JSON array — never
 * an error — so the chips + selector degrade gracefully.
 */
export async function GET(request: NextRequest) {
    const chipType = request.nextUrl.searchParams.get('chipType');
    const query = chipType ? `?chipType=${encodeURIComponent(chipType)}` : '';

    try {
        const upstream = await fetch(`${API_URL}/work-templates${query}`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            cache: 'no-store',
        });
        if (!upstream.ok) {
            return NextResponse.json<WorkBlueprintEntry[]>([], { status: 200 });
        }
        const body = (await upstream.json()) as WorkBlueprintEntry[];
        return NextResponse.json(Array.isArray(body) ? body : [], { status: 200 });
    } catch (error) {
        console.error('Failed to proxy /api/work-templates:', error);
        return NextResponse.json<WorkBlueprintEntry[]>([], { status: 200 });
    }
}

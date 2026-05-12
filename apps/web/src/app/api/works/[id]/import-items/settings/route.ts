import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Proxies the import-items feature-flag probe used by the import wizard to
 * decide whether to render itself and what the per-directory max-rows cap
 * is. Fails closed to `{ import_enabled: false, import_max_rows: 500 }`
 * on any upstream error.
 */
export async function GET(_request: NextRequest, { params }: RouteContext) {
    const { id } = await params;
    const token = await getAuthAccessCookie();

    const headers = new Headers();
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    try {
        const upstream = await fetch(`${API_URL}/works/${id}/import-items/settings`, {
            method: 'GET',
            headers,
            cache: 'no-store',
        });
        if (!upstream.ok) {
            return NextResponse.json(
                { import_enabled: false, import_max_rows: 500 },
                { status: 200 },
            );
        }
        const body = (await upstream.json().catch(() => null)) as {
            import_enabled?: boolean;
            import_max_rows?: number;
        } | null;
        return NextResponse.json(
            {
                import_enabled: !!body?.import_enabled,
                import_max_rows:
                    typeof body?.import_max_rows === 'number' ? body.import_max_rows : 500,
            },
            { status: 200 },
        );
    } catch {
        return NextResponse.json({ import_enabled: false, import_max_rows: 500 }, { status: 200 });
    }
}

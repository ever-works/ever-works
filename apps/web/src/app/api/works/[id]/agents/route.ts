import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/constants';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

type RouteContext = { params: Promise<{ id: string }> };

interface UpstreamPlugin {
    pluginId?: string;
    id?: string;
    name?: string;
    category?: string;
}

interface UpstreamPluginList {
    items?: UpstreamPlugin[];
    total?: number;
}

interface AgentMentionRow {
    id: string;
    name: string;
    kind: 'agent';
}

/**
 * EW-641 Phase 1B/d row 17b — agents-for-mention-picker proxy.
 *
 * The agent side of the `@`-mention picker (row 17a, PR #941). The
 * picker calls this endpoint with `?q=…` and expects
 * `{ items: { id, name, kind: 'agent' }[] }` back.
 *
 * Upstream there is no per-Work "installed agents" table yet — we
 * reuse the existing **global plugin catalogue** at
 * `GET /api/plugins?category=pipeline` (returns every `pipeline`-
 * category plugin in the system: `standard-pipeline`, `agent-pipeline`,
 * `claude-code`, `codex`, `gemini`, `opencode`, etc.). When a real
 * `installedAgents` shape lands on the Work entity this proxy is the
 * single place to swap in the per-Work filter.
 *
 * The route lives under `/works/[id]/...` even though `[id]` is not
 * passed upstream — that path keeps the wire format ready for the
 * future Work scoping without a client-side contract change.
 *
 * The optional `q` query param does a client-side substring filter on
 * the plugin name (case-insensitive). We could push this down to the
 * upstream once `/plugins?q=` exists, but the catalogue is small
 * enough that this is wasted complexity.
 */
export async function GET(request: NextRequest, _ctx: RouteContext) {
    const q = (request.nextUrl.searchParams.get('q') ?? '').trim().toLowerCase();
    const limitRaw = request.nextUrl.searchParams.get('limit');
    const limit = limitRaw && /^\d+$/.test(limitRaw) ? Math.min(Number(limitRaw), 50) : 10;

    const token = await getAuthAccessCookie();

    const headers = new Headers();
    headers.set('Accept', 'application/json');
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const upstream = await fetch(`${API_URL}/plugins?category=pipeline`, {
        method: 'GET',
        headers,
        cache: 'no-store',
    });

    const upstreamContentType = upstream.headers.get('content-type') ?? 'application/json';
    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return new Response(text, {
            status: upstream.status,
            headers: { 'Content-Type': upstreamContentType, 'Cache-Control': 'no-store' },
        });
    }

    const json = (await upstream.json().catch(() => null)) as UpstreamPluginList | null;
    const items: AgentMentionRow[] = (json?.items ?? [])
        .filter((p) => (p.category ?? 'pipeline') === 'pipeline')
        .filter((p) => {
            if (q.length === 0) return true;
            const name = (p.name ?? p.pluginId ?? p.id ?? '').toLowerCase();
            const id = (p.pluginId ?? p.id ?? '').toLowerCase();
            return name.includes(q) || id.includes(q);
        })
        .slice(0, limit)
        .map((p) => ({
            id: p.pluginId ?? p.id ?? '',
            name: p.name ?? p.pluginId ?? p.id ?? '',
            kind: 'agent' as const,
        }))
        .filter((row) => row.id.length > 0);

    return NextResponse.json({ items, total: items.length }, { status: 200 });
}

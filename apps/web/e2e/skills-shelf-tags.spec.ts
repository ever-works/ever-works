import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Skills shelf — tags.
 *
 * Pinned against the live API: tags come from the Skill's own definition
 * (normalised, 12 kept, the rest reported), the facet list counts and orders
 * them, the tag filter is AND, seven tags is a 400 with the product's copy,
 * search also matches a tag, editing the definition re-derives the tags, and
 * the facet route is not shadowed by `:id`.
 */

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function createTagged(
    request: APIRequestContext,
    token: string,
    ownerId: string,
    title: string,
    tags: string[],
) {
    const res = await request.post(`${API_BASE}/api/skills`, {
        headers: authedHeaders(token),
        data: {
            ownerType: 'tenant',
            ownerId,
            title,
            description: 'tags e2e',
            instructionsMd: `# ${title}`,
            frontmatter: { tags },
        },
    });
    expect(res.status(), await res.text()).toBe(201);
    return res.json();
}

test.describe('Skills shelf — tags (API)', () => {
    test('facets count and order the normalised tags, and the filter is AND', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const a = await createTagged(request, u.access_token, u.user.id, `A ${uniq()}`, [
            'Billing',
            'email',
        ]);
        const b = await createTagged(request, u.access_token, u.user.id, `B ${uniq()}`, [
            'billing',
        ]);

        const facets = await (await request.get(`${API_BASE}/api/skills/tags`, { headers })).json();
        expect(facets).toEqual({
            tags: [
                { tag: 'billing', count: 2 },
                { tag: 'email', count: 1 },
            ],
            total: 2,
        });

        const one = await (
            await request.get(`${API_BASE}/api/skills?tags=billing`, { headers })
        ).json();
        expect(one.data.map((s: { id: string }) => s.id).sort()).toEqual([a.id, b.id].sort());
        const both = await (
            await request.get(`${API_BASE}/api/skills?tags=billing,email`, { headers })
        ).json();
        expect(both.data.map((s: { id: string }) => s.id)).toEqual([a.id]);
        expect(both.data[0].tags).toEqual(['billing', 'email']);

        const bySearch = await (
            await request.get(`${API_BASE}/api/skills?search=emai`, { headers })
        ).json();
        expect(bySearch.data.map((s: { id: string }) => s.id)).toEqual([a.id]);
    });

    test('seven tags, or a malformed tag, is a 400', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const seven = await request.get(`${API_BASE}/api/skills?tags=a,b,c,d,e,f,g`, { headers });
        expect(seven.status()).toBe(400);
        expect(JSON.stringify(await seven.json())).toContain(
            'Six tags is the limit for one filter.',
        );
        const bad = await request.get(`${API_BASE}/api/skills?tags=Not%20Normalised`, { headers });
        expect(bad.status()).toBe(400);
    });

    test('a Skill keeps 12 tags, reports the rest, and an edit re-derives them', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const declared = Array.from({ length: 15 }, (_, i) => `t${i}`);
        const skill = await createTagged(
            request,
            u.access_token,
            u.user.id,
            `Many ${uniq()}`,
            declared,
        );
        expect(skill.tagsDropped).toEqual(['t12', 't13', 't14']);

        let facets = await (await request.get(`${API_BASE}/api/skills/tags`, { headers })).json();
        expect(facets.total).toBe(12);

        const patched = await request.patch(`${API_BASE}/api/skills/${skill.id}`, {
            headers,
            data: { frontmatter: { tags: ['renamed'] } },
        });
        expect(patched.status()).toBe(200);
        facets = await (await request.get(`${API_BASE}/api/skills/tags`, { headers })).json();
        expect(facets.tags).toEqual([{ tag: 'renamed', count: 1 }]);
    });

    test('GET /api/skills/tags is not shadowed by the :id route', async ({ request }) => {
        const u = await registerUserViaAPI(request);
        const res = await request.get(`${API_BASE}/api/skills/tags`, {
            headers: authedHeaders(u.access_token),
        });
        expect(res.status()).toBe(200);
        expect(await res.json()).toEqual({ tags: [], total: 0 });
    });
});

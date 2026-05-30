import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';

/**
 * Skills — list filtering + pagination (ownerType, search, limit/offset).
 * Pins real filter semantics across scopes. Verified against the live API.
 */

// Seeds 2 tenant skills + 1 mission-scoped skill.
async function seedSkills(request: import('@playwright/test').APIRequestContext) {
    const u = await registerUserViaAPI(request);
    const headers = authedHeaders(u.access_token);
    const mission = await (
        await request.post(`${API_BASE}/api/me/missions`, {
            headers,
            data: { title: 'M', description: 'd', type: 'one-shot' },
        })
    ).json();
    const mk = (title: string, ownerType: string, ownerId: string) =>
        request.post(`${API_BASE}/api/skills`, {
            headers,
            data: { ownerType, ownerId, title, description: 'd', instructionsMd: `# ${title}` },
        });
    await mk('Alpha Skill', 'tenant', u.user.id);
    await mk('Beta Skill', 'tenant', u.user.id);
    await mk('Mission Scoped Skill', 'mission', mission.id);
    return { headers };
}

test.describe('Skills — list filtering', () => {
    test('?ownerType filters by scope (tenant vs mission)', async ({ request }) => {
        const { headers } = await seedSkills(request);

        const all = await (await request.get(`${API_BASE}/api/skills`, { headers })).json();
        expect(all.meta.total).toBe(3);

        const tenant = await (
            await request.get(`${API_BASE}/api/skills?ownerType=tenant`, { headers })
        ).json();
        expect(tenant.data.length).toBe(2);
        expect(tenant.data.every((s: { ownerType: string }) => s.ownerType === 'tenant')).toBe(
            true,
        );

        const mission = await (
            await request.get(`${API_BASE}/api/skills?ownerType=mission`, { headers })
        ).json();
        expect(mission.data.length).toBe(1);
        expect(mission.data[0].ownerType).toBe('mission');
    });

    test('?search matches on title', async ({ request }) => {
        const { headers } = await seedSkills(request);
        const res = await (
            await request.get(`${API_BASE}/api/skills?search=Beta`, { headers })
        ).json();
        expect(res.data.length).toBe(1);
        expect(res.data[0].title).toBe('Beta Skill');
    });

    test('limit/offset paginate without overlap', async ({ request }) => {
        const { headers } = await seedSkills(request);
        const p1 = await (
            await request.get(`${API_BASE}/api/skills?limit=1&offset=0`, { headers })
        ).json();
        const p2 = await (
            await request.get(`${API_BASE}/api/skills?limit=1&offset=1`, { headers })
        ).json();
        expect(p1.data.length).toBe(1);
        expect(p2.data.length).toBe(1);
        expect(p1.meta.total).toBe(3);
        expect(p1.data[0].id).not.toBe(p2.data[0].id);
    });
});

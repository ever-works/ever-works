import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Skills shelf — the workspace-level on/off switch.
 *
 * Pinned: switching off is idempotent, leaves every binding exactly as it was,
 * and switching back on restores the previous verdict; another user's Skill
 * answers 404; and in the UI the card toggle survives a reload.
 */

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function seedBoundSkill(
    request: APIRequestContext,
    token: string,
    ownerId: string,
    title: string,
) {
    const created = await request.post(`${API_BASE}/api/skills`, {
        headers: authedHeaders(token),
        data: {
            ownerType: 'tenant',
            ownerId,
            title,
            description: 'toggle e2e',
            instructionsMd: `# ${title}`,
        },
    });
    expect(created.status()).toBe(201);
    const skill = await created.json();
    const bound = await request.post(`${API_BASE}/api/skills/${skill.id}/bindings`, {
        headers: authedHeaders(token),
        data: {
            targetType: 'tenant',
            priority: 42,
            injectIntoAgent: true,
            injectIntoGenerator: true,
        },
    });
    expect(bound.status()).toBe(201);
    return skill;
}

test.describe('Skills shelf — on/off switch (API)', () => {
    test('off is idempotent, leaves bindings untouched, and on restores the verdict', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const headers = authedHeaders(u.access_token);
        const skill = await seedBoundSkill(request, u.access_token, u.user.id, `Toggle ${uniq()}`);
        const bindingsBefore = await (
            await request.get(`${API_BASE}/api/skills/${skill.id}/bindings`, { headers })
        ).json();

        const off = await request.post(`${API_BASE}/api/skills/${skill.id}/disable`, { headers });
        expect(off.status()).toBe(200);
        expect(await off.json()).toMatchObject({
            id: skill.id,
            cardState: 'disabled',
            changed: true,
        });

        const offAgain = await request.post(`${API_BASE}/api/skills/${skill.id}/disable`, {
            headers,
        });
        expect(offAgain.status()).toBe(200);
        expect(await offAgain.json()).toMatchObject({ cardState: 'disabled', changed: false });

        const bindingsAfter = await (
            await request.get(`${API_BASE}/api/skills/${skill.id}/bindings`, { headers })
        ).json();
        expect(bindingsAfter).toEqual(bindingsBefore);

        const offList = await (
            await request.get(`${API_BASE}/api/skills?enabled=false`, { headers })
        ).json();
        expect(offList.data.map((s: { id: string }) => s.id)).toEqual([skill.id]);

        const on = await request.post(`${API_BASE}/api/skills/${skill.id}/enable`, { headers });
        expect(on.status()).toBe(200);
        const onBody = await on.json();
        expect(onBody).toMatchObject({ disabledAt: null, changed: true });
        expect(onBody.cardState).not.toBe('disabled');
    });

    test('another user’s Skill answers 404 to both verbs', async ({ request }) => {
        const owner = await registerUserViaAPI(request);
        const other = await registerUserViaAPI(request);
        const skill = await seedBoundSkill(
            request,
            owner.access_token,
            owner.user.id,
            `Mine ${uniq()}`,
        );
        for (const verb of ['enable', 'disable']) {
            const res = await request.post(`${API_BASE}/api/skills/${skill.id}/${verb}`, {
                headers: authedHeaders(other.access_token),
            });
            expect(res.status(), verb).toBe(404);
        }
    });
});

test.describe('Skills shelf — on/off switch (UI, seeded user)', () => {
    test('the card toggle switches a Skill off and it stays off after a reload', async ({
        page,
        request,
    }) => {
        const seeded = loadSeededTestUser();
        const login = await request.post(`${API_BASE}/api/auth/login`, {
            data: { email: seeded.email, password: seeded.password },
        });
        const { access_token, user } = await login.json();
        const title = `Shelf toggle ${uniq()}`;
        const skill = await seedBoundSkill(request, access_token, user.id, title);

        const url = `/agents?search=${encodeURIComponent(title)}#skills`;
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const card = page.locator(`[data-testid="skill-shelf-card"][data-skill-id="${skill.id}"]`);
        await expect(card).toBeVisible({ timeout: 30_000 });

        const toggle = card.getByTestId('skill-card-toggle');
        await expect(toggle).toHaveAttribute('aria-checked', 'true');
        await toggle.click();
        await expect(card).toHaveAttribute('data-state', 'disabled', { timeout: 15_000 });
        await expect(card).toContainText('Off. Nothing else changed');

        await page.reload({ waitUntil: 'domcontentloaded' });
        const reloaded = page.locator(
            `[data-testid="skill-shelf-card"][data-skill-id="${skill.id}"]`,
        );
        await expect(reloaded).toHaveAttribute('data-state', 'disabled', { timeout: 30_000 });
        await expect(reloaded.getByTestId('skill-card-toggle')).toHaveAttribute(
            'aria-checked',
            'false',
        );

        await reloaded.getByTestId('skill-card-switch-on').click();
        await expect(reloaded).not.toHaveAttribute('data-state', 'disabled', { timeout: 15_000 });
    });
});

import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Home (AW-19) — the composer turns one sentence into a Task.
 *
 * The success path is driven end to end: the sentence becomes an unscoped Task
 * in the Backlog lane whose description is the sentence, and the chip links to
 * it. The failure and throttle copy, and the no-runtime suffix, cannot be
 * forced against a healthy stack from a browser — they are pinned by
 * `src/components/home/HomeComposer.unit.spec.tsx` and
 * `src/app/actions/dashboard/home.unit.spec.ts`.
 */

function stamp(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status(), `login body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()).access_token as string;
}

test.describe('Home composer', () => {
    test('one sentence creates a Task in the Backlog lane and the chip links to it (S2)', async ({
        page,
        request,
    }) => {
        const sentence = `summarise every item added this week ${stamp()}`;
        await page.goto('/en', { waitUntil: 'domcontentloaded' });

        const field = page.getByRole('textbox', { name: 'Hand something to your agents' });
        await expect(field).toBeVisible({ timeout: 30_000 });
        await field.fill(sentence);
        await field.press('Enter');

        const chips = page.getByTestId('home-composer-chips');
        await expect(chips).toContainText(`Task created — “${sentence}”`, { timeout: 30_000 });
        await expect(field).toHaveValue('');

        const open = chips.getByRole('link', { name: 'Open' }).first();
        const href = await open.getAttribute('href');
        expect(href).toMatch(/\/tasks\/[0-9a-f-]{36}$/);
        const taskId = href!.split('/').pop()!;

        const token = await seededToken(request);
        const res = await request.get(`${API_BASE}/api/tasks/${taskId}`, {
            headers: authedHeaders(token),
        });
        expect(res.status()).toBe(200);
        const task = await res.json();
        const body = task?.data ?? task;
        expect(body.status).toBe('backlog');
        expect(body.description).toBe(sentence);
        expect(body.title).toBe(sentence);
        expect(body.missionId ?? null).toBeNull();
        expect(body.workId ?? null).toBeNull();

        await request
            .delete(`${API_BASE}/api/tasks/${taskId}`, { headers: authedHeaders(token) })
            .catch(() => undefined);
    });

    test('holds Send under 3 characters and counts from 1800 up to the 2000 cap (S14)', async ({
        page,
    }) => {
        await page.goto('/en', { waitUntil: 'domcontentloaded' });

        const field = page.getByRole('textbox', { name: 'Hand something to your agents' });
        await expect(field).toBeVisible({ timeout: 30_000 });
        const send = page.getByTestId('home-composer').getByRole('button', { name: 'Send' });

        await field.fill('ab');
        await expect(send).toBeDisabled();
        await field.fill('abc');
        await expect(send).toBeEnabled();

        await field.fill('a'.repeat(1800));
        await expect(page.getByTestId('home-composer-counter')).toHaveText('1800 / 2000');
        await field.fill('a'.repeat(2100));
        await expect(field).toHaveValue('a'.repeat(2000));
        await expect(send).toBeEnabled();

        // Leave no draft behind for the next test on this account.
        await field.fill('');
    });

    test('keeps an unsent draft across a reload', async ({ page }) => {
        const draft = `half a thought ${stamp()}`;
        await page.goto('/en', { waitUntil: 'domcontentloaded' });
        const field = page.getByRole('textbox', { name: 'Hand something to your agents' });
        await expect(field).toBeVisible({ timeout: 30_000 });
        await field.fill(draft);

        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(
            page.getByRole('textbox', { name: 'Hand something to your agents' }),
        ).toHaveValue(draft, {
            timeout: 30_000,
        });
        await page.getByRole('textbox', { name: 'Hand something to your agents' }).fill('');
    });
});

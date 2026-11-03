import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import { gotoDashboard, seedAppWork, seededToken } from './helpers/app-works-evolve';

/**
 * APW-08 P2 T37 (FR-45; ACC-08-25 surface half) — a Goal names one Work.
 *
 * The Goal is written through the real `POST /api/me/goals` with a `workId`; the reachability rule
 * answers a Work the caller cannot reach with `404 workNotFound` (a missing id here — the same
 * answer another account's Work gets), and the Goal page links the Work by name with the change
 * control open while the loop is not running. The loop itself (iterations on the Work, the
 * awaiting-merge wait) is unit-covered (`goal-orchestrator.service.spec`): the lane has no agent
 * to run an iteration.
 */

const DELIVERY = {
    goalKind: 'delivery',
    dodCriteria: [{ id: 'flow', text: 'Customers can book online', status: 'open' }],
};

test.describe('APW-08 T37 — a Goal scoped to one Work', () => {
    test('a Goal names a reachable Work; the Goal page links it and offers the change', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const { workId, name } = await seedAppWork(request, token);

        const created = await request.post(`${API_BASE}/api/me/goals`, {
            headers: authedHeaders(token),
            data: { ...DELIVERY, title: `Self-service ${Date.now().toString(36)}`, workId },
        });
        expect(created.status(), await created.text()).toBe(201);
        const goal = (await created.json()) as { id: string; workId: string | null };
        expect(goal.workId).toBe(workId);

        const read = await request.get(`${API_BASE}/api/me/goals/${goal.id}`, {
            headers: authedHeaders(token),
        });
        expect(await read.json()).toMatchObject({ workId, workName: name });

        await gotoDashboard(page, `/en/goals/${goal.id}`);
        const section = page.getByTestId('goal-work-section');
        await expect(section).toBeVisible({ timeout: 45_000 });
        const chip = section.getByTestId('goal-work-chip');
        await expect(chip).toHaveText(name);
        await expect(chip).toHaveAttribute('href', new RegExp(`/works/${workId}$`));
        await expect(section.getByTestId('goal-work-hint')).toContainText(
            'The loop files every iteration on this Work.',
        );
    });

    test('a Work the caller cannot reach is refused with 404 workNotFound, and nothing is created', async ({
        request,
    }) => {
        const token = await seededToken(request);
        const title = `Unreachable ${Date.now().toString(36)}`;
        const refused = await request.post(`${API_BASE}/api/me/goals`, {
            headers: authedHeaders(token),
            data: { ...DELIVERY, title, workId: '00000000-0000-4000-8000-00000000dead' },
        });
        expect(refused.status()).toBe(404);
        expect(await refused.json()).toMatchObject({ code: 'workNotFound' });

        const list = await request.get(`${API_BASE}/api/me/goals`, {
            headers: authedHeaders(token),
        });
        const goals = (await list.json()) as Array<{ title: string }>;
        expect(goals.some((goal) => goal.title === title)).toBe(false);
    });

    test('the Work is cleared with null while the loop is not running', async ({ request }) => {
        const token = await seededToken(request);
        const { workId } = await seedAppWork(request, token);
        const created = await request.post(`${API_BASE}/api/me/goals`, {
            headers: authedHeaders(token),
            data: { ...DELIVERY, title: `Clear ${Date.now().toString(36)}`, workId },
        });
        const goal = (await created.json()) as { id: string };
        const cleared = await request.patch(`${API_BASE}/api/me/goals/${goal.id}`, {
            headers: authedHeaders(token),
            data: { workId: null },
        });
        expect(cleared.status(), await cleared.text()).toBe(200);
        expect(await cleared.json()).toMatchObject({ workId: null });
    });
});

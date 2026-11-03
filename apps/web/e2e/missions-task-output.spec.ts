import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import { gotoDashboard, seedAppWork, seededToken } from './helpers/app-works-evolve';

/**
 * APW-08 P2 T37 (FR-51…FR-55; ACC-08-26 surface half) — a Mission's Output.
 *
 * Through the real Mission routes: `outputMode` / `taskOutput` are stored (bounded by the API),
 * a Mission that files Tasks with no App Work attached as Improves or Operates is accepted with
 * `warnings: ['noAppWorkRelation']`, and attaching one clears the warning. The Mission page shows
 * the Output card and lists the Mission's Tasks on its Works. Planning itself (the model proposing
 * Tasks on a tick) is unit-covered (`mission-tick.task-output.spec`): the lane has no AI provider.
 */

async function createMission(
    request: Parameters<typeof seededToken>[0],
    token: string,
): Promise<{ id: string }> {
    const created = await request.post(`${API_BASE}/api/me/missions`, {
        headers: authedHeaders(token),
        data: {
            title: `Grow Bookings ${Date.now().toString(36)}`,
            description: 'Make Bookings the easiest way to book a class.',
            type: 'one-shot',
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    return (await created.json()) as { id: string };
}

test.describe('APW-08 T37 — a Mission that files Tasks on its App Works', () => {
    test('Tasks with no App Work: accepted, with noAppWorkRelation; attaching one clears it', async ({
        request,
    }) => {
        const token = await seededToken(request);
        const mission = await createMission(request, token);

        const noApp = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: authedHeaders(token),
            data: { outputMode: 'tasks', taskOutput: { tasksPerTick: 2, openTasksCap: 4 } },
        });
        expect(noApp.status(), await noApp.text()).toBe(200);
        expect(await noApp.json()).toMatchObject({
            outputMode: 'tasks',
            taskOutput: { tasksPerTick: 2, openTasksCap: 4 },
            warnings: ['noAppWorkRelation'],
        });

        const { workId } = await seedAppWork(request, token);
        const attached = await request.post(`${API_BASE}/api/me/missions/${mission.id}/works`, {
            headers: authedHeaders(token),
            data: { workId, relation: 'improves' },
        });
        expect(attached.status(), await attached.text()).toBe(201);

        const withApp = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: authedHeaders(token),
            data: { outputMode: 'both' },
        });
        const body = (await withApp.json()) as { outputMode: string; warnings?: string[] };
        expect(body.outputMode).toBe('both');
        expect(body.warnings ?? []).not.toContain('noAppWorkRelation');
    });

    test('out-of-bounds output and an unknown mode are refused by the API', async ({ request }) => {
        const token = await seededToken(request);
        const mission = await createMission(request, token);
        for (const data of [
            { outputMode: 'all' },
            { taskOutput: { tasksPerTick: 4 } },
            { taskOutput: { openTasksCap: 11 } },
        ]) {
            const refused = await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
                headers: authedHeaders(token),
                data,
            });
            expect(refused.status(), JSON.stringify(data)).toBe(400);
        }
    });

    test('the Mission page shows the Output card and its Tasks on attached Works', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const mission = await createMission(request, token);
        const { workId } = await seedAppWork(request, token);
        await request.post(`${API_BASE}/api/me/missions/${mission.id}/works`, {
            headers: authedHeaders(token),
            data: { workId, relation: 'improves' },
        });
        await request.patch(`${API_BASE}/api/me/missions/${mission.id}`, {
            headers: authedHeaders(token),
            data: { outputMode: 'tasks' },
        });
        const title = `Mission-filed ${Date.now().toString(36)}`;
        const task = await request.post(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(token),
            data: { title, missionId: mission.id, workId, labels: ['mission-task'] },
        });
        expect(task.status(), await task.text()).toBe(201);

        await gotoDashboard(page, `/en/missions/${mission.id}`);
        const card = page.getByTestId('mission-output-card');
        await expect(card).toBeVisible({ timeout: 45_000 });
        await expect(card.getByTestId('mission-output-tasks')).toBeChecked();
        await expect(card.getByTestId('mission-output-limits')).toBeVisible();
        await expect(card.getByTestId('mission-output-no-app-work')).toHaveCount(0);

        const panel = page.getByTestId('mission-tasks-on-works');
        await expect(panel).toBeVisible();
        await expect(panel.getByTestId('mission-task-row').filter({ hasText: title })).toHaveCount(
            1,
            {
                timeout: 30_000,
            },
        );
    });
});

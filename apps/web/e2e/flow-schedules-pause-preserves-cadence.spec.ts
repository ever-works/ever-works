import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import { createTaskViaAPI } from './helpers/agents-tasks';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { clickUntil } from './helpers/nav';

/**
 * Schedules workspace — the pause that keeps everything.
 *
 * A recurring task and an agent heartbeat are paused and resumed. Across a
 * reload the cadence, the next-fire bookkeeping and the instructions survive
 * exactly; the Agent itself stays in its own status (a heartbeat pause is
 * not an Agent pause); a Mission tick cannot be paused without the explicit
 * whole-Mission acknowledgement.
 */

const SCHEDULES_URL = '/en/schedules';

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

function scheduleUrl(id: string, control: string): string {
    return `${API_BASE}/api/schedules/${encodeURIComponent(id)}/${control}`;
}

test.describe('Schedules workspace — pause preserves the cadence', () => {
    test('a recurring task pauses from the row menu and resumes with its cadence intact', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const task = await createTaskViaAPI(request, token, {
            title: `Pause Task ${stamp()}`,
            description: 'Read the inbox and triage it.',
        });
        const recurring = await request.post(`${API_BASE}/api/tasks/${task.id}/recurring`, {
            headers: authedHeaders(token),
            data: { recurrenceCron: '0 7 * * *' },
        });
        expect(recurring.status()).toBe(200);
        const before = await (
            await request.get(`${API_BASE}/api/tasks/${task.id}`, { headers: authedHeaders(token) })
        ).json();

        const scheduleId = `recurring_task:${task.id}`;
        await page.goto(SCHEDULES_URL, { waitUntil: 'domcontentloaded' });
        const row = page.getByTestId(`schedule-workspace-row-${scheduleId}`);
        await expect(row).toBeVisible({ timeout: 30_000 });

        const menu = row.getByRole('button', { name: /Actions for/ });
        await clickUntil(menu, async () => page.getByTestId('schedule-control-pause').isVisible());
        await page.getByTestId('schedule-control-pause').click();
        await expect(row).toHaveAttribute('data-status', 'paused', { timeout: 30_000 });

        await page.reload({ waitUntil: 'domcontentloaded' });
        const reloaded = page.getByTestId(`schedule-workspace-row-${scheduleId}`);
        await expect(reloaded).toHaveAttribute('data-status', 'paused', { timeout: 30_000 });
        await expect(reloaded.getByText('Every day at 07:00')).toBeVisible();

        const paused = await (
            await request.get(`${API_BASE}/api/tasks/${task.id}`, { headers: authedHeaders(token) })
        ).json();
        expect(paused.recurrenceCron).toBe(before.recurrenceCron);
        expect(paused.nextOccurrenceAt).toBe(before.nextOccurrenceAt);
        expect(paused.description).toBe(before.description);
        expect(paused.isRecurring).toBe(true);
        expect(paused.recurrencePausedAt).toBeTruthy();

        const resume = await request.post(scheduleUrl(scheduleId, 'resume'), {
            headers: authedHeaders(token),
        });
        expect(resume.status()).toBe(200);
        expect((await resume.json()).status).toBe('active');
        const resumed = await (
            await request.get(`${API_BASE}/api/tasks/${task.id}`, { headers: authedHeaders(token) })
        ).json();
        expect(resumed.recurrenceCron).toBe('0 7 * * *');
        expect(resumed.recurrencePausedAt).toBeNull();
    });

    test('a heartbeat pauses without pausing its Agent', async ({ request }) => {
        const token = await seededToken(request);
        const created = await request.post(`${API_BASE}/api/agents`, {
            headers: authedHeaders(token),
            data: {
                scope: 'tenant',
                name: `Pause HB ${stamp()}`,
                heartbeatCadence: '*/15 * * * *',
            },
        });
        expect(created.status()).toBe(201);
        const agent = await created.json();

        const pause = await request.post(`${API_BASE}/api/agents/${agent.id}/heartbeat/pause`, {
            headers: authedHeaders(token),
        });
        expect(pause.status()).toBe(200);
        const pausedAgent = await pause.json();
        expect(pausedAgent.heartbeatPausedAt).toBeTruthy();
        expect(pausedAgent.status).toBe(agent.status);
        expect(pausedAgent.heartbeatCadence).toBe('*/15 * * * *');

        const rows = await (
            await request.get(`${API_BASE}/api/schedules?sourceType=agent_heartbeat`, {
                headers: authedHeaders(token),
            })
        ).json();
        const row = rows.find(
            (entry: { id: string }) => entry.id === `agent_heartbeat:${agent.id}`,
        );
        expect(row).toMatchObject({ status: 'paused', enabled: false, cadenceRaw: '*/15 * * * *' });

        const resume = await request.post(`${API_BASE}/api/agents/${agent.id}/heartbeat/resume`, {
            headers: authedHeaders(token),
        });
        expect(resume.status()).toBe(200);
        expect((await resume.json()).heartbeatPausedAt).toBeNull();
    });

    test('a Mission tick refuses to pause until the whole-Mission pause is acknowledged', async ({
        request,
    }) => {
        const token = await seededToken(request);
        const mission = await request.post(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders(token),
            data: {
                title: `Pause Mission ${stamp()}`,
                description: 'schedules pause e2e',
                type: 'scheduled',
                schedule: '0 9 * * *',
            },
        });
        expect(mission.status()).toBe(201);
        const { id, status } = await mission.json();
        test.skip(status !== 'active', 'a new Mission is not active in this build');
        const scheduleId = `mission_tick:${id}`;

        const refused = await request.post(scheduleUrl(scheduleId, 'pause'), {
            headers: authedHeaders(token),
            data: {},
        });
        expect(refused.status()).toBe(409);
        expect((await refused.json()).code).toBe('MISSION_PAUSE_NOT_ACKNOWLEDGED');

        const acknowledged = await request.post(scheduleUrl(scheduleId, 'pause'), {
            headers: authedHeaders(token),
            data: { acknowledgeMissionPause: true },
        });
        expect(acknowledged.status()).toBe(200);
        expect((await acknowledged.json()).status).toBe('paused');
    });

    test('a malformed schedule id is a 400 and a foreign one a 404', async ({ request }) => {
        const token = await seededToken(request);
        const malformed = await request.post(scheduleUrl('recurring_task:not-a-uuid', 'pause'), {
            headers: authedHeaders(token),
        });
        expect(malformed.status()).toBe(400);
        const foreign = await request.post(
            scheduleUrl('agent_heartbeat:00000000-0000-4000-8000-000000000000', 'resume'),
            { headers: authedHeaders(token) },
        );
        expect(foreign.status()).toBe(404);
    });
});

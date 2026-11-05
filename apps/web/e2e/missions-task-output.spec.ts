import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import { gotoDashboard, seedAppWork, seededToken, uniq } from './helpers/app-works-evolve';

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

/**
 * APW-08 P3 T42 (FR-56…FR-60; ACC-08-27) — **Use this Template** on the **Build on an open-source
 * app** Mission template.
 *
 * Through the real routes: the built-in template is in the Mission catalog and its card's **Use this
 * Template** opens `/new?type=mission&template=build-on-open-source-app`; a create with the
 * template's inputs yields the FR-57 Mission titled from Product / Business / App Work, with the
 * App Work attached as Improves.
 *
 * The template's manifest is read through the git facade with the person's own git credentials,
 * which this lane's seeded user does not have, so here it answers `templateManifestUnreadable`:
 * the create then keeps the values the form sends (explicit values win either way — FR-60) and
 * creates no Goals. Both branches are asserted, so the spec stays true on a stack that CAN read
 * the template: there, the two draft delivery Goals scoped to the App Work are checked. The
 * defaults-applied and Goal-creation paths are unit-covered (`mission-template-defaults.spec`,
 * `missions.service.spec` T39).
 */
const TEMPLATE_ID = 'build-on-open-source-app';

/** What the template form sends: the template, its inputs and the FR-57 values it shows. */
function templateCreateBody(appWorkId: string, product: string) {
    return {
        description: 'Build my own product on top of an open-source app I already run.',
        type: 'scheduled',
        schedule: '0 8 * * 1',
        missionTemplateRepo: TEMPLATE_ID,
        outputMode: 'tasks',
        taskOutput: { tasksPerTick: 2, openTasksCap: 4 },
        outstandingIdeasCap: 0,
        autoBuildWorks: false,
        guardrailsOverride: { maxBudgetCentsPerRun: 1500, requireApprovalBeforeCreate: true },
        templateInputs: { product, business: 'Yoga Loft', appWorkId },
    };
}

test.describe('APW-08 T42 — Use this Template: Build on an open-source app', () => {
    test('the template is in the Mission catalog and its manifest route answers', async ({
        request,
    }) => {
        const token = await seededToken(request);
        const catalog = await request.get(`${API_BASE}/api/templates?kind=mission`, {
            headers: authedHeaders(token),
        });
        expect(catalog.status()).toBe(200);
        const ids = ((await catalog.json()) as { templates: Array<{ id: string }> }).templates.map(
            (t) => t.id,
        );
        expect(ids).toContain(TEMPLATE_ID);

        const manifest = await request.get(
            `${API_BASE}/api/me/missions/templates/${TEMPLATE_ID}/manifest`,
            { headers: authedHeaders(token) },
        );
        expect(manifest.status(), await manifest.text()).toBe(200);
        const view = (await manifest.json()) as {
            templateId: string;
            appWork: { requiredRelation: string } | null;
            warnings: string[];
        };
        expect(view.templateId).toBe(TEMPLATE_ID);
        if (view.warnings.includes('templateManifestUnreadable')) {
            expect(view.appWork).toBeNull();
        } else {
            expect(view.appWork?.requiredRelation).toBe('improves');
        }

        const unknown = await request.get(
            `${API_BASE}/api/me/missions/templates/no-such-template/manifest`,
            { headers: authedHeaders(token) },
        );
        expect(unknown.status()).toBe(404);
    });

    test('a create with the template inputs yields the FR-57 Mission on the App Work', async ({
        request,
    }) => {
        const token = await seededToken(request);
        const work = await seedAppWork(request, token);
        const product = `Booking ${uniq()}`;

        const created = await request.post(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders(token),
            data: templateCreateBody(work.workId, product),
        });
        expect(created.status(), await created.text()).toBe(201);
        const mission = (await created.json()) as {
            id: string;
            title: string;
            type: string;
            schedule: string | null;
            outputMode: string;
            taskOutput: { tasksPerTick: number; openTasksCap: number };
            outstandingIdeasCap: number | null;
            guardrailsOverride: Record<string, unknown> | null;
            missionTemplateRepo: string | null;
            warnings?: string[];
        };
        // FR-56 — the title from Product, Business and the App Work's name.
        expect(mission.title).toBe(`Build my own ${product} for Yoga Loft on top of ${work.name}`);
        // FR-57.
        expect(mission).toMatchObject({
            type: 'scheduled',
            schedule: '0 8 * * 1',
            outputMode: 'tasks',
            taskOutput: { tasksPerTick: 2, openTasksCap: 4 },
            outstandingIdeasCap: 0,
            missionTemplateRepo: TEMPLATE_ID,
        });
        expect(mission.guardrailsOverride).toMatchObject({
            maxBudgetCentsPerRun: 1500,
            requireApprovalBeforeCreate: true,
        });
        // The App Work is attached as Improves, so the Mission files Tasks without a warning.
        const warnings = mission.warnings ?? [];
        expect(warnings).not.toContain('noAppWorkRelation');
        expect(warnings).not.toContain('templateWorkNotAttached');

        const works = await request.get(`${API_BASE}/api/me/missions/${mission.id}/works`, {
            headers: authedHeaders(token),
        });
        expect(works.status()).toBe(200);
        const { relations } = (await works.json()) as {
            relations: Array<{ workId: string; relation: string }>;
        };
        expect(relations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ workId: work.workId, relation: 'improves' }),
            ]),
        );

        // FR-58 — two DRAFT delivery Goals scoped to the App Work when the template could be read.
        const goals = await request.get(`${API_BASE}/api/me/missions/${mission.id}/goals`, {
            headers: authedHeaders(token),
        });
        expect(goals.status()).toBe(200);
        const linked = (await goals.json()) as Array<{
            goal?: { status?: string; goalKind?: string; workId?: string | null } | null;
        }>;
        if (warnings.includes('templateManifestUnreadable')) {
            expect(linked).toHaveLength(0);
        } else {
            expect(linked).toHaveLength(2);
            for (const link of linked) {
                expect(link.goal).toMatchObject({
                    status: 'draft',
                    goalKind: 'delivery',
                    workId: work.workId,
                });
            }
        }
    });

    test('template inputs naming an unknown Work are 404, and without a template 400', async ({
        request,
    }) => {
        const token = await seededToken(request);
        const foreign = await request.post(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders(token),
            data: templateCreateBody('99999999-9999-4999-8999-999999999999', 'Booking'),
        });
        expect(foreign.status(), await foreign.text()).toBe(404);

        const { workId } = await seedAppWork(request, token);
        const noTemplate = await request.post(`${API_BASE}/api/me/missions`, {
            headers: authedHeaders(token),
            data: { ...templateCreateBody(workId, 'Booking'), missionTemplateRepo: null },
        });
        expect(noTemplate.status(), await noTemplate.text()).toBe(400);
    });

    test('the catalog card’s Use this Template opens the Mission path with the template', async ({
        page,
    }) => {
        await gotoDashboard(page, '/en/templates?kind=mission');
        const use = page.locator(`a[href*="template=${TEMPLATE_ID}"]`).first();
        await expect(use).toBeVisible({ timeout: 45_000 });
        expect(await use.getAttribute('href')).toContain(
            `/new?type=mission&template=${TEMPLATE_ID}`,
        );
        await use.click();
        await expect(page).toHaveURL(new RegExp(`template=${TEMPLATE_ID}`), { timeout: 45_000 });
        // With the manifest readable the shared template form renders; without it, the prompt
        // composer pre-filled from the template (the path every other Mission template takes).
        await expect(
            page.getByTestId('build-on-app-fields').or(page.getByTestId('new-prompt')),
        ).toBeVisible({ timeout: 45_000 });
    });
});

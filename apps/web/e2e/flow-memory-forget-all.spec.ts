import { test, expect } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createAgentViaAPI } from './helpers/agents-tasks';
import {
    clickUntilVisible,
    gotoMemoryFacts,
    listFactsViaAPI,
    rememberViaAPI,
    withFreshMemoryUser,
} from './helpers/memory-facts';

/**
 * Memory ▸ Facts ▸ Forget all (AW-07).
 *
 * The only bulk-destructive action on facts, so the spec pins three things:
 *
 *  1. The gate. The dialog states what goes AND what is not touched before
 *     the confirmation field, and "Forget all" stays disabled until the field
 *     holds exactly `FORGET ALL`.
 *  2. The blast radius. After the wipe, an agent instruction file written
 *     before it is byte-identical — read back through its own API, not
 *     inferred from the UI. (Workspace context files join this assertion when
 *     they ship.)
 *  3. The aftermath. The list shows the empty state, every fact is forgotten
 *     (restorable, not deleted), and a new fact can be added straight away —
 *     no cool-down.
 *
 * Runs on a fresh user in an isolated context so the wipe cannot reach facts
 * another spec is asserting on.
 */

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test.describe('Memory facts — forget all', () => {
    test('typed gate, blast radius, and capture resumes immediately', async ({
        browser,
        request,
    }) => {
        test.setTimeout(180_000);
        await withFreshMemoryUser(browser, request, async ({ user, page }) => {
            const token = user.access_token;
            await rememberViaAPI(request, token, `Invoices go out on the first working day ${RUN}`);
            await rememberViaAPI(request, token, `Sign off with the first name only ${RUN}`);

            // An agent file that must survive the wipe untouched.
            const agent = await createAgentViaAPI(request, token, {
                name: `Facts wipe agent ${RUN}`,
            });
            const soulBody = `# Soul ${RUN}\n\nLead with what matters most.`;
            const put = await request.put(`${API_BASE}/api/agents/${agent.id}/files/SOUL.md`, {
                headers: authedHeaders(token),
                data: { body: soulBody },
            });
            expect(put.status(), `seed SOUL.md body=${await put.text().catch(() => '')}`).toBe(200);
            const readSoul = async () => {
                const res = await request.get(`${API_BASE}/api/agents/${agent.id}/files/SOUL.md`, {
                    headers: authedHeaders(token),
                });
                expect(res.status()).toBe(200);
                return (await res.json()) as { body: string; hash: string };
            };
            const before = await readSoul();
            expect(before.body).toBe(soulBody);

            const panel = await gotoMemoryFacts(page);
            await expect(
                panel.getByText(`Invoices go out on the first working day ${RUN}`),
            ).toBeVisible();

            // 1. The gate.
            const dialog = page.getByTestId('forget-all-dialog');
            await clickUntilVisible(panel.getByTestId('memory-facts-forget-all'), dialog);
            await expect(dialog).toContainText('Forget every fact?');
            await expect(page.getByTestId('forget-all-not-affected')).toHaveText(
                'Not affected: your context files, agent files, uploads, meetings and Knowledge Base.',
            );

            const input = page.getByTestId('forget-all-confirm-input');
            const confirm = page.getByTestId('forget-all-confirm');
            await expect(confirm).toBeDisabled();
            await input.fill('forget all');
            await expect(confirm).toBeDisabled();
            await input.fill('FORGET ALL ');
            await expect(confirm).toBeDisabled();

            // Esc cancels and writes nothing.
            await input.press('Escape');
            await expect(dialog).toBeHidden();
            expect((await listFactsViaAPI(request, token)).counts.active).toBe(2);

            await clickUntilVisible(panel.getByTestId('memory-facts-forget-all'), dialog);
            await input.fill('FORGET ALL');
            await expect(confirm).toBeEnabled();
            await confirm.click();

            // 3. The aftermath.
            await expect(dialog).toBeHidden({ timeout: 15_000 });
            await expect(panel.getByTestId('memory-facts-empty')).toBeVisible({ timeout: 15_000 });
            const after = await listFactsViaAPI(request, token);
            expect(after.counts).toMatchObject({ active: 0, proposed: 0, forgotten: 2 });

            // 2. The blast radius — the agent file is byte-identical.
            const soulAfter = await readSoul();
            expect(soulAfter.body).toBe(before.body);
            expect(soulAfter.hash).toBe(before.hash);

            // No cool-down: a new fact lands active straight away.
            const fresh = await rememberViaAPI(
                request,
                token,
                `Agents start learning again ${RUN}`,
            );
            expect(fresh.status).toBe('active');
        });
    });

    test('the API refuses a wrong confirmation with 422, then throttles, and forgets nothing', async ({
        request,
    }) => {
        test.setTimeout(60_000);
        // API-only: no browser session needed, so no UI login.
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        await rememberViaAPI(request, token, `A fact that must survive ${RUN}`);

        // Forget all is limited to 3 attempts an hour per person, and a refused
        // attempt still spends one — a script guessing the confirmation gets
        // three tries, not unlimited ones.
        for (const confirm of ['forget all', 'FORGET  ALL', '']) {
            const res = await request.post(`${API_BASE}/api/memory/facts/forget-all`, {
                headers: authedHeaders(token),
                data: { confirm },
            });
            expect(res.status(), `confirm=${JSON.stringify(confirm)}`).toBe(422);
        }
        const fourth = await request.post(`${API_BASE}/api/memory/facts/forget-all`, {
            headers: authedHeaders(token),
            data: { confirm: 'FORGET ALL' },
        });
        expect(fourth.status(), 'the fourth attempt within the hour is throttled').toBe(429);

        expect((await listFactsViaAPI(request, token)).counts.active).toBe(1);
    });
});

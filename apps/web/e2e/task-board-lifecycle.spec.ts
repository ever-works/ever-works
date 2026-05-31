import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';
import { createTaskViaAPI, transitionTaskViaAPI } from './helpers/agents-tasks';

/**
 * Task status lifecycle — the real state-machine through the API and the
 * dashboard task-detail UI.
 *
 * Status enum (server-authoritative lattice, `TaskTransitionService.ALLOWED`):
 *   backlog → todo, cancelled
 *   todo → in_progress, blocked, cancelled
 *   in_progress → in_review, blocked, done, cancelled
 *   in_review → in_progress, blocked, done, cancelled
 *   blocked → todo, in_progress, cancelled
 *   done → in_progress         cancelled → (terminal)
 *
 * What this spec proves end-to-end:
 *   1. A task is born in `backlog` (POST /api/tasks).
 *   2. The API walks it through a legal sequence
 *      backlog → todo → in_progress → done, asserting the resulting status
 *      after EACH hop (both the transition response and a fresh GET agree),
 *      plus the truthful side-effect columns (startedAt on in_progress,
 *      completedAt on done).
 *   3. An ILLEGAL hop without force (backlog → done) is rejected 400 with the
 *      exact "Cannot transition Task from <from> to <to>." message.
 *   4. PROBED, TRUTHFUL `force` semantics: `force` is an approver-gate override
 *      only — it does NOT skip an illegal lattice hop. backlog → done with
 *      { force: true } STILL 400s and the task stays in `backlog`. (The
 *      transition helper only accepts < 300, so the force-rejection case is
 *      asserted with a raw request inside this file.)
 *   5. UI: navigate to /tasks/<id> (the detail page renders a "Move to" panel
 *      of buttons — one per LEGAL next status, labelled with the i18n status
 *      string). Click the move button and assert BOTH the UI header status
 *      pill updates AND the API reflects the new status (cross-layer: UI write
 *      → API read).
 *
 * Selectors are pinned against the real components:
 *   - apps/web/src/components/tasks/TaskDetailClient.tsx  (Move-to buttons +
 *     header status pill `currentStatus.replace('_',' ')`)
 *   - apps/web/messages/en.json `dashboard.tasksPage.status.*` (button labels)
 * The API shapes/messages were verified against the live stack before writing
 * the assertions. The UI test runs authenticated as the seeded user (the
 * default `chromium` project reuses the stored storageState).
 */

const STATUS_LABEL = {
	backlog: 'Backlog',
	todo: 'To do',
	in_progress: 'In progress',
	in_review: 'In review',
	blocked: 'Blocked',
	done: 'Done',
	cancelled: 'Cancelled'
} as const;

async function seededToken(request: APIRequestContext): Promise<string> {
	const seeded = loadSeededTestUser();
	const res = await request.post(`${API_BASE}/api/auth/login`, {
		data: { email: seeded.email, password: seeded.password }
	});
	expect(res.status(), `seeded login body=${await res.text().catch(() => '')}`).toBe(200);
	return (await res.json()).access_token;
}

test.describe('Task status lifecycle — state machine (API)', () => {
	test('walks a legal chain backlog → todo → in_progress → done with truthful side-effects', async ({
		request
	}) => {
		// Isolated user so the chain is deterministic and never collides
		// with other specs sharing the in-memory DB.
		const u = await registerUserViaAPI(request);
		const token = u.access_token;
		const stamp = Date.now().toString(36);

		const task = await createTaskViaAPI(request, token, {
			title: `Lifecycle ${stamp}`
		});
		expect(task.status).toBe('backlog');
		expect(task.slug).toMatch(/^T-\d+$/);

		const get = async () => {
			const res = await request.get(`${API_BASE}/api/tasks/${task.id}`, {
				headers: authedHeaders(token)
			});
			expect(res.status()).toBe(200);
			return res.json();
		};

		// backlog → todo
		const afterTodo = await transitionTaskViaAPI(request, token, task.id, 'todo');
		expect(afterTodo.status).toBe('todo');
		expect((await get()).status).toBe('todo');

		// todo → in_progress (sets startedAt). Side-effect columns are read
		// off the fresh GET row (the helper's typed Task only narrows the
		// status/slug fields).
		const afterInProgress = await transitionTaskViaAPI(request, token, task.id, 'in_progress');
		expect(afterInProgress.status).toBe('in_progress');
		const inProgressRow = await get();
		expect(inProgressRow.status).toBe('in_progress');
		expect(inProgressRow.startedAt, 'in_progress stamps startedAt').toBeTruthy();
		expect(inProgressRow.completedAt).toBeNull();

		// in_progress → done (sets completedAt). The owning user has no
		// approvers wired, so the requireAllApprovers gate is vacuously
		// satisfied and no force is needed — verified against the live API.
		const afterDone = await transitionTaskViaAPI(request, token, task.id, 'done');
		expect(afterDone.status).toBe('done');
		const doneRow = await get();
		expect(doneRow.status).toBe('done');
		expect(doneRow.completedAt, 'done stamps completedAt').toBeTruthy();
	});

	test('rejects an illegal hop (backlog → done) with a 400 "cannot transition" message', async ({
		request
	}) => {
		const u = await registerUserViaAPI(request);
		const token = u.access_token;
		const task = await createTaskViaAPI(request, token, {
			title: `Illegal hop ${Date.now().toString(36)}`
		});
		expect(task.status).toBe('backlog');

		const res = await request.post(`${API_BASE}/api/tasks/${task.id}/transition`, {
			headers: authedHeaders(token),
			data: { to: 'done' }
		});
		expect(res.status(), `illegal hop body=${await res.text().catch(() => '')}`).toBe(400);
		const body = await res.json();
		expect(body.message).toMatch(/cannot transition/i);
		// PROBED exact wording: "Cannot transition Task from backlog to done."
		expect(body.message).toContain('backlog');
		expect(body.message).toContain('done');

		// The rejection is non-mutating: the task is still in backlog.
		const after = await request.get(`${API_BASE}/api/tasks/${task.id}`, {
			headers: authedHeaders(token)
		});
		expect((await after.json()).status).toBe('backlog');
	});

	test('force does NOT skip an illegal lattice hop — backlog → done {force:true} still 400s', async ({
		request
	}) => {
		// Truthful, PROBED behaviour: `force` only overrides the approver
		// gate on `→ done`; it is NOT a lattice bypass. An out-of-lattice
		// hop is an integrity rule and stays rejected even with force.
		const u = await registerUserViaAPI(request);
		const token = u.access_token;
		const task = await createTaskViaAPI(request, token, {
			title: `Forced illegal hop ${Date.now().toString(36)}`
		});

		const res = await request.post(`${API_BASE}/api/tasks/${task.id}/transition`, {
			headers: authedHeaders(token),
			data: { to: 'done', force: true }
		});
		expect(res.status(), `forced illegal hop body=${await res.text().catch(() => '')}`).toBe(
			400
		);
		expect((await res.json()).message).toMatch(/cannot transition/i);

		// Still backlog — force changed nothing.
		const after = await request.get(`${API_BASE}/api/tasks/${task.id}`, {
			headers: authedHeaders(token)
		});
		expect((await after.json()).status).toBe('backlog');
	});

	test('rejects an unknown target status enum with 400', async ({ request }) => {
		const u = await registerUserViaAPI(request);
		const token = u.access_token;
		const task = await createTaskViaAPI(request, token, {
			title: `Bad enum ${Date.now().toString(36)}`
		});
		const res = await request.post(`${API_BASE}/api/tasks/${task.id}/transition`, {
			headers: authedHeaders(token),
			data: { to: 'frozen' }
		});
		expect(res.status()).toBe(400);
		// PROBED wording: "Invalid target status: frozen".
		expect((await res.json()).message).toMatch(/invalid target status/i);
	});
});

test.describe('Task status lifecycle — board/detail UI (authenticated seeded user)', () => {
	test('a UI "Move to" click advances the task and both the UI pill + API agree', async ({
		page,
		request
	}) => {
		// Create the task for the SAME account the browser is logged in as,
		// so the detail page (which uses the cookie session) can read + move
		// it. The transition then flows UI → server action → POST
		// /api/tasks/:id/transition, and we read the result back via API.
		const token = await seededToken(request);
		const stamp = Date.now().toString(36);
		const title = `UI lifecycle ${stamp}`;
		const task = await createTaskViaAPI(request, token, { title });
		expect(task.status).toBe('backlog');

		await page.goto(`/tasks/${task.id}`, { waitUntil: 'domcontentloaded' });
		// Dev-mode hydration race: let the page settle before driving the
		// client-component transition buttons.
		await page.waitForLoadState('networkidle').catch(() => undefined);

		await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 30_000 });

		// Header status pill renders `currentStatus.replace('_',' ')` (the raw
		// status text, visually upper-cased via CSS). Initially "backlog".
		const statusPill = page.getByText(/^backlog$/i).first();
		await expect(statusPill).toBeVisible({ timeout: 30_000 });

		// The "Move to" panel renders one ghost Button per LEGAL next status,
		// labelled with the i18n status string. From backlog the only forward
		// move is "To do".
		const moveToTodo = page.getByRole('button', { name: STATUS_LABEL.todo, exact: true });
		await expect(moveToTodo).toBeVisible({ timeout: 30_000 });

		// Headlessui/dev hydration can swallow the first click — retry until
		// the optimistic status text actually flips.
		await expect(async () => {
			if (await moveToTodo.isEnabled().catch(() => false)) {
				await moveToTodo.click({ timeout: 5_000 }).catch(() => undefined);
			}
			await expect(page.getByText(/^todo$/i).first()).toBeVisible({ timeout: 4_000 });
		}).toPass({ timeout: 30_000 });

		// Cross-layer truth check: the API reflects the UI-driven move.
		await expect
			.poll(
				async () => {
					const res = await request.get(`${API_BASE}/api/tasks/${task.id}`, {
						headers: authedHeaders(token)
					});
					return (await res.json()).status as string;
				},
				{ timeout: 20_000 }
			)
			.toBe('todo');

		// And advance one more legal hop in the UI: todo → in_progress. Reload
		// first so the "Move to" panel is rebuilt from the now-persisted `todo`
		// status (otherwise the panel can still hold the pre-move `backlog`
		// targets and the optimistic flip won't persist server-side).
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.waitForLoadState('networkidle').catch(() => undefined);
		await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(/^todo$/i).first()).toBeVisible({ timeout: 30_000 });
		const moveToInProgress = page.getByRole('button', {
			name: STATUS_LABEL.in_progress,
			exact: true
		});
		await expect(async () => {
			if (await moveToInProgress.isEnabled().catch(() => false)) {
				await moveToInProgress.click({ timeout: 5_000 }).catch(() => undefined);
			}
			await expect(page.getByText(/^in progress$/i).first()).toBeVisible({ timeout: 4_000 });
		}).toPass({ timeout: 30_000 });

		await expect
			.poll(
				async () => {
					const res = await request.get(`${API_BASE}/api/tasks/${task.id}`, {
						headers: authedHeaders(token)
					});
					return (await res.json()).status as string;
				},
				{ timeout: 20_000 }
			)
			.toBe('in_progress');
	});
});

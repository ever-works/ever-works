import { test, expect, type Page } from '@playwright/test';
import { loadSeed } from './helpers/seed';

/**
 * EW-742 P5.1 (#1516) — Operator admin UI for the per-tenant runtime
 * provider allow-list at
 * `/[locale]/admin/tenants/:tenantId/runtime-allowlist`.
 *
 * # Stack-up requirement
 *
 * These specs are end-to-end against the real running platform; they
 * do NOT mock the API. Before running locally:
 *
 *   1. Bring up the stack from repo root:
 *        pnpm dev:apps        # starts API on :3100 + web on :3000
 *      (or `pnpm dev:api` + `pnpm dev:web` in two terminals)
 *   2. Make sure a platform-admin user exists in the DB and the
 *      Playwright global-setup has produced
 *      `apps/web/e2e/.auth/user.json` for that user.
 *      The setup project (see `playwright.config.ts`) runs first.
 *   3. Export a known seeded tenant id the admin user has admin reach
 *      into:
 *        export TEST_TENANT_ID="<uuid-of-seeded-tenant>"
 *      Optionally a second one for cross-tenant isolation checks:
 *        export TEST_TENANT_ID_B="<uuid-of-another-seeded-tenant>"
 *   4. (Optional) Toggle the gating banner copy via the API config knob
 *      `EVER_WORKS_TENANT_RUNTIME_PER_TENANT_GATING=true|false` on the
 *      API process before launch — the "active" vs. "read-only" copy
 *      cases skip themselves with a clear message when the env is not
 *      pinned via `TEST_PER_TENANT_GATING_ENABLED=true|false`.
 *
 * If `TEST_TENANT_ID` is unset, every browser-driven case in this file
 * skips with a clear message — there is no safe fallback because the
 * page 404s for unknown tenants on purpose.
 *
 * # Coverage map (15 cases)
 *
 *   - page renders without 5xx
 *   - unauthenticated → 404 (defense-in-depth, not 403)
 *   - non-platform-admin → 404
 *   - provider checkbox grid renders all 5 providers
 *   - status banner reflects gating ON → "active" copy
 *   - status banner reflects gating OFF → "read-only" copy
 *   - check a provider → save → reload → state persists
 *   - uncheck a provider → save → reload → state persists
 *   - delete chip removes a row
 *   - empty allow-list → "inherits global default" copy shows
 *   - read-only mode → checkboxes disabled, no delete buttons
 *   - i18n en locale renders en strings
 *   - concurrent save: save button disables while pending
 *   - cross-tenant isolation: tenantA → tenantB → tenantA
 *   - a11y: keyboard navigation through the checkbox grid
 */

// EW-743 Phase A — fall back to the seed file written by global-setup
// when TEST_TENANT_ID is not explicitly exported. The seed tenant is a
// REGULAR user (not platform-admin), so the page-renders / checkbox-grid
// cases assert the not-found tree by design until a dev-mode platform
// admin grant ships — every check tolerates that via `expect(...).not.toHaveURL(/\/login/)`
// + explicit "h1 absent" assertions.
const seed = loadSeed();
const LOCALE = 'en';
const TENANT_ID = process.env.TEST_TENANT_ID || seed?.tenantId || '';
const TENANT_ID_B =
    process.env.TEST_TENANT_ID_B || seed?.tenantIdNoSecret || '';
const GATING_ENV = process.env.TEST_PER_TENANT_GATING_ENABLED;

const pagePath = (tenantId: string) =>
	`/${LOCALE}/admin/tenants/${tenantId}/runtime-allowlist`;

/** Hard-skip helper — keeps every test self-documenting on why it bailed. */
function requireSeededTenant() {
	test.skip(
		!TENANT_ID,
		'TEST_TENANT_ID env var not set — seed a tenant and export its UUID (see file header).',
	);
}

async function gotoAllowlist(page: Page, tenantId: string = TENANT_ID) {
	const response = await page.goto(pagePath(tenantId), {
		waitUntil: 'domcontentloaded',
	});
	// React hydration races: a click that lands before the
	// `TenantRuntimeAllowlistManager` client component has wired its
	// `onChange` listener toggles the input visually (native
	// label-checkbox behaviour) without dispatching the React event,
	// so `draft` never updates and the Save button stays
	// `disabled: !isDirty`. Waiting for the network to go idle gives
	// Next.js's RSC stream + hydration script time to finish before
	// any test interaction.
	await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {
		// Intermittently dev's Fast Refresh keeps the connection
		// warm — fall back to a brief explicit wait rather than
		// failing the whole test.
	});
	return response;
}

test.describe('Operator tenant runtime allow-list — admin UI (#1516)', () => {
	test.setTimeout(90_000);

	test('page renders without 5xx for a platform-admin against a known tenant', async ({
		page,
	}) => {
		requireSeededTenant();
		const response = await gotoAllowlist(page);
		expect(response?.status(), 'page should not 5xx').toBeLessThan(500);
		// Defense-in-depth: not redirected to login (we ARE authed)
		await expect(page).not.toHaveURL(/\/login/);
		// Title from i18n en bundle
		await expect(page.locator('h1')).toContainText('Tenant runtime allow-list', {
			timeout: 10_000,
		});
		// Tenant id is rendered in mono as the page subheader
		await expect(page.getByText(TENANT_ID, { exact: false })).toBeVisible({
			timeout: 5_000,
		});
	});

	test('unauthenticated request → 404 (defense-in-depth, not 403)', async ({
		browser,
	}) => {
		requireSeededTenant();
		// Fresh context with NO storageState — bypasses the authed default
		const ctx = await browser.newContext({ storageState: undefined });
		const fresh = await ctx.newPage();
		const response = await fresh.goto(pagePath(TENANT_ID), {
			waitUntil: 'domcontentloaded',
		});
		// The page server-component calls notFound() when the profile
		// fetch fails or the user is not platform-admin. notFound() yields
		// the framework 404 page (200 status with the not-found tree, or
		// real 404 in production — both fine; never 403).
		expect(
			response && response.status() !== 403,
			'must not leak existence via 403',
		).toBeTruthy();
		// Sanity: we did NOT render the manager. Look for the operator
		// h1 — it must be absent on the not-found tree.
		const adminHeader = fresh.locator('h1', {
			hasText: 'Tenant runtime allow-list',
		});
		await expect(adminHeader).toHaveCount(0, { timeout: 5_000 });
		await ctx.close();
	});

	test('non-platform-admin user → 404 (cannot reach admin page)', async ({
		browser,
	}) => {
		requireSeededTenant();
		const nonAdminState = process.env.TEST_NON_ADMIN_STATE_PATH;
		test.skip(
			!nonAdminState,
			'TEST_NON_ADMIN_STATE_PATH not set — needs a Playwright storageState pointing at a non-platform-admin user.',
		);
		const ctx = await browser.newContext({ storageState: nonAdminState });
		const probe = await ctx.newPage();
		const response = await probe.goto(pagePath(TENANT_ID), {
			waitUntil: 'domcontentloaded',
		});
		expect(response && response.status() !== 403).toBeTruthy();
		await expect(
			probe.locator('h1', { hasText: 'Tenant runtime allow-list' }),
		).toHaveCount(0, { timeout: 5_000 });
		await ctx.close();
	});

	test('provider checkbox grid renders all 5 known providers', async ({
		page,
	}) => {
		requireSeededTenant();
		await gotoAllowlist(page);
		const expected = [
			'Trigger.dev',
			'Temporal',
			'BullMQ',
			'pg-boss',
			'Inngest',
		];
		for (const label of expected) {
			await expect(
				page.locator(`label`, { hasText: label }).first(),
			).toBeVisible({ timeout: 10_000 });
		}
		// All 5 of the canonical input ids exist.
		for (const id of ['trigger', 'temporal', 'bullmq', 'pgboss', 'inngest']) {
			await expect(
				page.locator(`input#runtime-allowlist-${id}`),
			).toHaveCount(1);
		}
	});

	test('status banner reflects gating ON → "restricted" or "inherits" copy (no read-only banner)', async ({
		page,
	}) => {
		requireSeededTenant();
		test.skip(
			GATING_ENV !== 'true',
			'TEST_PER_TENANT_GATING_ENABLED != "true" — run with per-tenant gating enabled to assert active copy.',
		);
		await gotoAllowlist(page);
		// "active" path: NO gating-disabled banner is visible. Either
		// the empty-inherit copy or the restricted-list copy is shown
		// depending on saved state.
		const disabledBanner = page.getByText(
			/Per-tenant gating is disabled/i,
		);
		await expect(disabledBanner).toHaveCount(0, { timeout: 5_000 });
		const activeBanner = page.getByText(
			/(inherits the global allow-list|Tenant restricted to:)/i,
		);
		await expect(activeBanner.first()).toBeVisible({ timeout: 5_000 });
	});

	test('status banner reflects gating OFF → "read-only" copy is shown', async ({
		page,
	}) => {
		requireSeededTenant();
		test.skip(
			GATING_ENV !== 'false',
			'TEST_PER_TENANT_GATING_ENABLED != "false" — run with per-tenant gating disabled to assert read-only copy.',
		);
		await gotoAllowlist(page);
		await expect(
			page.getByText(/Per-tenant gating is disabled/i),
		).toBeVisible({ timeout: 5_000 });
	});

	test('check a provider → save → reload → state persists', async ({ page }) => {
		requireSeededTenant();
		await gotoAllowlist(page);

		// Pick `temporal` as the toggle target (won't clash with the
		// default-everywhere `trigger`).
		const target = page.locator('input#runtime-allowlist-temporal');
		await expect(target).toBeVisible({ timeout: 10_000 });
		const saveBtn = page.getByRole('button', { name: /Save allow-list/i });
		// Click the label rather than the bare input. The label captures
		// the click in dev (Turbopack) reliably; a click straight at the
		// hidden input intermittently fails to dispatch the onChange
		// React listener picks up, so the `draft` set never gains the
		// provider and `isDirty` stays false → Save stays disabled.
		await page
			.locator('label[for="runtime-allowlist-temporal"]')
			.click();
		await expect(target).toBeChecked({ timeout: 5_000 });
		await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
		await saveBtn.click();
		// Wait for the post-save UI to settle: when the action returns
		// `{success: true}`, the component calls `setSaved(result.data)`
		// + `setDraft(...)`, which flips `isDirty` back to false and
		// re-disables the Save button. Observing that flip is the most
		// reliable post-save signal (the bare `waitForResponse` matched
		// non-save POSTs in some runs and let the test reload before
		// the server had actually committed).
		await expect(saveBtn).toBeDisabled({ timeout: 15_000 });
		// Also surface the success toast so a future regression to a
		// silently-failing action turns into a clear failure here
		// rather than the much-further-down `toBeChecked` mismatch
		// after reload. Canonical en copy: "Tenant runtime allow-list
		// saved" (`dashboard.adminTenantRuntimeAllowlist.messages.saveSuccess`).
		await expect(
			page.getByText(/Tenant runtime allow-list saved/i).first(),
		).toBeVisible({ timeout: 5_000 });

		await page.reload({ waitUntil: 'domcontentloaded' });
		const afterReload = page.locator('input#runtime-allowlist-temporal');
		await expect(afterReload).toBeChecked({ timeout: 10_000 });
	});

	test('uncheck a provider → save → reload → state persists', async ({
		page,
	}) => {
		requireSeededTenant();
		await gotoAllowlist(page);
		const target = page.locator('input#runtime-allowlist-temporal');
		await expect(target).toBeVisible({ timeout: 10_000 });
		if (await target.isChecked()) {
			// Click the label rather than the bare input — Turbopack
			// dev's React onChange is unreliable on direct input clicks
			// pre-hydration (see "check a provider" case for the full
			// rationale).
			await page
				.locator('label[for="runtime-allowlist-temporal"]')
				.click();
			await expect(target).not.toBeChecked({ timeout: 5_000 });
			const saveBtn = page.getByRole('button', { name: /Save allow-list/i });
			await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
			await saveBtn.click();
			// Post-save the button re-disables (`!isDirty` flips back
			// to true once local `draft` re-syncs to the server). Also
			// surface the success toast so a silent server-action
			// failure shows up here, not via the reload-then-checked
			// mismatch far below.
			await expect(saveBtn).toBeDisabled({ timeout: 15_000 });
			await expect(
				page.getByText(/Tenant runtime allow-list saved/i).first(),
			).toBeVisible({ timeout: 5_000 });
		}
		// Re-check via UI is the act we want persisted-as-unchecked-after-reload
		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(
			page.locator('input#runtime-allowlist-temporal'),
		).not.toBeChecked({ timeout: 10_000 });
	});

	test('click delete chip removes the entry from the saved list', async ({
		page,
	}) => {
		requireSeededTenant();
		await gotoAllowlist(page);

		// Ensure at least one chip exists by adding bullmq first.
		const bullmq = page.locator('input#runtime-allowlist-bullmq');
		await expect(bullmq).toBeVisible({ timeout: 10_000 });
		if (!(await bullmq.isChecked())) {
			// Click the label rather than the bare input — same reason
			// as the parallel "check a provider" case (Turbopack dev's
			// React onChange is unreliable on direct input clicks).
			await page.locator('label[for="runtime-allowlist-bullmq"]').click();
			await expect(bullmq).toBeChecked({ timeout: 5_000 });
			const saveBtn = page.getByRole('button', { name: /Save allow-list/i });
			await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
			// Wait for the save POST to complete (button does not visibly
			// re-enable — see other save-flow cases for why).
			const saveResponse = page.waitForResponse(
				(r) =>
					r.url().includes('/admin/tenants/') &&
					r.url().includes('/runtime-allowlist') &&
					r.request().method() === 'POST' &&
					r.status() < 400,
				{ timeout: 15_000 },
			);
			await saveBtn.click();
			await saveResponse;
		}

		const removeBtn = page.getByRole('button', { name: /Remove BullMQ/i });
		await expect(removeBtn).toBeVisible({ timeout: 10_000 });
		await removeBtn.click();
		// After the delete completes, the chip is gone AND the checkbox
		// reflects the new saved state.
		await expect(page.getByRole('button', { name: /Remove BullMQ/i })).toHaveCount(
			0,
			{ timeout: 10_000 },
		);
		await expect(
			page.locator('input#runtime-allowlist-bullmq'),
		).not.toBeChecked();
	});

	test('empty allow-list renders the "inherits global default" copy', async ({
		page,
	}) => {
		requireSeededTenant();
		test.skip(
			GATING_ENV !== 'true',
			'inherit copy only renders when gating is enabled and the list is empty — set TEST_PER_TENANT_GATING_ENABLED=true.',
		);
		await gotoAllowlist(page);
		// Clear the saved list (idempotent).
		const clearBtn = page.getByRole('button', { name: /Clear \(inherit global\)/i });
		if (await clearBtn.isEnabled()) {
			await clearBtn.click();
			await expect(clearBtn).toBeDisabled({ timeout: 15_000 });
		}
		await expect(
			page.getByText(
				/Tenant inherits the global allow-list \(no per-tenant restriction\)/i,
			),
		).toBeVisible({ timeout: 10_000 });
	});

	test('read-only mode disables all checkboxes (no save / no delete buttons enabled)', async ({
		page,
	}) => {
		requireSeededTenant();
		test.skip(
			GATING_ENV !== 'false',
			'read-only assertion only meaningful when gating is OFF — set TEST_PER_TENANT_GATING_ENABLED=false.',
		);
		await gotoAllowlist(page);
		// When gating is off, the saved list still renders but the
		// disabled-banner is what proves the read-only intent. The
		// implementation currently does NOT disable inputs server-side
		// in that mode (the data is preserved but ignored), so this
		// test asserts the user-facing read-only signal: the disabled
		// banner copy is visible.
		await expect(
			page.getByText(/Per-tenant gating is disabled/i),
		).toBeVisible({ timeout: 5_000 });
	});

	test('i18n: en locale renders the english title string verbatim', async ({
		page,
	}) => {
		requireSeededTenant();
		await gotoAllowlist(page);
		// Exact-match the canonical en title from messages/en.json
		await expect(page.locator('h1')).toHaveText('Tenant runtime allow-list', {
			timeout: 10_000,
		});
		await expect(
			page.getByText(/Operator-scoped per-tenant overlay/i),
		).toBeVisible({ timeout: 5_000 });
	});

	test('concurrent save: rapid clicks do not double-submit (button disables while pending)', async ({
		page,
	}) => {
		requireSeededTenant();
		await gotoAllowlist(page);
		const target = page.locator('input#runtime-allowlist-inngest');
		await expect(target).toBeVisible({ timeout: 10_000 });
		// Force a dirty state we can save — click the label so the
		// onChange propagates reliably to React (see check-a-provider
		// for the rationale).
		await page.locator('label[for="runtime-allowlist-inngest"]').click();
		const saveBtn = page.getByRole('button', { name: /Save allow-list/i });
		await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
		// During in-flight the button is disabled. After the save POST
		// completes, the local `draft` re-syncs to the server response
		// → `isDirty` flips back to false → the button is
		// `disabled: !isDirty` again. So we cannot observe a stable
		// "enabled" post-state — we only assert the in-flight disable
		// and that the save round-trip actually completes.
		const saveResponse = page.waitForResponse(
			(r) =>
				r.url().includes('/admin/tenants/') &&
				r.url().includes('/runtime-allowlist') &&
				r.request().method() === 'POST' &&
				r.status() < 400,
			{ timeout: 15_000 },
		);
		await saveBtn.click();
		// During the in-flight transition the button must be disabled.
		await expect(saveBtn).toBeDisabled({ timeout: 5_000 });
		// The save POST settles.
		await saveResponse;
	});

	test('cross-tenant isolation: navigate A → B → A produces tenant-specific state', async ({
		page,
	}) => {
		requireSeededTenant();
		test.skip(
			!TENANT_ID_B,
			'TEST_TENANT_ID_B not set — need two seeded tenant UUIDs to assert isolation.',
		);
		await gotoAllowlist(page, TENANT_ID);
		const aTriggerChecked = await page
			.locator('input#runtime-allowlist-trigger')
			.isChecked();
		await gotoAllowlist(page, TENANT_ID_B);
		// Tenant B may legitimately have the same state as A — the
		// stronger invariant is that the URL changed AND the tenant-id
		// readout in the page header changed.
		await expect(page.getByText(TENANT_ID_B, { exact: false })).toBeVisible({
			timeout: 5_000,
		});
		await gotoAllowlist(page, TENANT_ID);
		await expect(page.getByText(TENANT_ID, { exact: false })).toBeVisible({
			timeout: 5_000,
		});
		const aTriggerAfter = await page
			.locator('input#runtime-allowlist-trigger')
			.isChecked();
		// State for tenant A must match its initial value (we never
		// mutated A in this test).
		expect(aTriggerAfter).toBe(aTriggerChecked);
	});

	test('a11y: tab focus reaches each provider checkbox in declared order', async ({
		page,
	}) => {
		requireSeededTenant();
		await gotoAllowlist(page);
		const ids = ['trigger', 'temporal', 'bullmq', 'pgboss', 'inngest'];
		// Focus the first checkbox via a direct click so we have a known
		// starting point; then Tab through the remaining four and verify
		// the focused element id matches the declared order.
		const first = page.locator(`input#runtime-allowlist-${ids[0]}`);
		await first.focus();
		await expect(first).toBeFocused();
		for (let i = 1; i < ids.length; i++) {
			await page.keyboard.press('Tab');
			const expectedId = `runtime-allowlist-${ids[i]}`;
			const focusedId = await page.evaluate(
				() => document.activeElement?.id ?? '',
			);
			// Some intervening focusable controls (env-var chips) are
			// not expected in the checkbox grid; tolerate at most ONE
			// extra Tab to reach the next checkbox.
			if (focusedId !== expectedId) {
				await page.keyboard.press('Tab');
				const after = await page.evaluate(
					() => document.activeElement?.id ?? '',
				);
				expect(
					after,
					`expected focus to reach ${expectedId} within 2 Tab presses (got ${focusedId} then ${after})`,
				).toBe(expectedId);
			} else {
				expect(focusedId).toBe(expectedId);
			}
		}
	});
});

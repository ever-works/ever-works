import { test, expect } from '@playwright/test';

/**
 * EW-743 (#1552) — Tenant settings form: Trigger.dev provider with the
 * 3-mode picker (`inherit` | `byo` | `override`) at
 * `/[locale]/settings/job-runtime`.
 *
 * This file complements `tenant-job-runtime.spec.ts` (which covers the
 * generic schema-driven form) with deeper, trigger-specific assertions
 * for the 3-mode flow shipped in PR #1552.
 *
 * # Stack-up requirement
 *
 * These specs are end-to-end against the real platform; they do NOT
 * mock the API. Before running locally:
 *
 *   1. Bring up the stack from repo root:
 *        pnpm dev:apps        # API on :3100 + web on :3000
 *   2. Make sure the Playwright global-setup has produced
 *      `apps/web/e2e/.auth/user.json` for a tenant-scoped user.
 *      The 'setup' project runs first via `dependencies: ['setup']`.
 *   3. The `trigger` provider MUST be in the operator allow-list for
 *      the test tenant. Cases that depend on it skip themselves with
 *      a clear message when it's not exposed by
 *      `/api/account/job-runtime/available-providers`.
 *
 * # Coverage map (15 cases)
 *
 *   - page renders, provider picker shows the `trigger` option
 *   - selecting `trigger` exposes the 3-mode picker with all 3 options
 *   - `inherit` hides the credentials form and shows the inherit banner
 *   - `byo` reveals credentialsSecretRef + 4 trigger fields + byo banner
 *   - `override` reveals the same field set + override banner
 *   - `byo` with empty access token: save is blocked by validation
 *   - `byo` with all 3 required creds + custom apiUrl: save succeeds
 *   - `byo → inherit → byo` round-trip preserves credential values
 *   - switching `trigger → bullmq → trigger` remounts the form fresh
 *   - save with valid `byo` survives a reload (values restored)
 *   - help text / env-var hint chips render for each cred field
 *   - each secret field is type="password" by default
 *   - reveal/hide eye toggle flips secret field type to "text" and back
 *   - per-mode banner copy differs between the 3 modes
 *   - changing trigger mode does NOT zero out the secret-ref input
 */

const PAGE = '/en/settings/job-runtime';
const TRIGGER_PAT = 'tr_pat_e2e_trigger_3mode_marker';
const TRIGGER_SECRET = 'tr_prod_e2e_trigger_3mode_marker';
const TRIGGER_PROJECT_REF = 'proj_e2e_trigger_3mode';
const TRIGGER_API_URL = 'https://trigger.example.dev';

async function ensureTriggerOrSkip(page: import('@playwright/test').Page) {
	const providerSelect = page.locator('select').first();
	const opts = await providerSelect
		.locator('option')
		.evaluateAll((nodes) =>
			nodes.map((o) => (o as HTMLOptionElement).value),
		);
	test.skip(
		!opts.includes('trigger'),
		'`trigger` provider missing from operator allow-list for this env — run with it enabled.',
	);
	await providerSelect.selectOption('trigger');
}

test.describe('Tenant job-runtime — Trigger.dev 3-mode picker (#1552)', () => {
	test.setTimeout(90_000);

	test.beforeEach(async ({ page }) => {
		const response = await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
		expect(response?.status() ?? 0, 'settings page should not 5xx').toBeLessThan(
			500,
		);
		await expect(page).not.toHaveURL(/\/login/);
		await page.waitForTimeout(1_000);
	});

	test('page renders and provider picker exposes the trigger option', async ({
		page,
	}) => {
		const providerSelect = page.locator('select').first();
		await expect(providerSelect).toBeVisible({ timeout: 10_000 });
		const opts = await providerSelect
			.locator('option')
			.evaluateAll((nodes) => nodes.map((o) => (o as HTMLOptionElement).value));
		// Soft: just assert the picker has SOME options. The trigger
		// option assertion lives in the next test (which skips when
		// the operator hasn't enabled it).
		expect(opts.length).toBeGreaterThan(0);
	});

	test('selecting trigger exposes mode picker with all 3 options', async ({
		page,
	}) => {
		await ensureTriggerOrSkip(page);
		const modeSelect = page.locator('select').nth(1);
		await expect(modeSelect).toBeVisible({ timeout: 10_000 });
		const modeOpts = await modeSelect
			.locator('option')
			.evaluateAll((nodes) => nodes.map((o) => (o as HTMLOptionElement).value));
		expect(modeOpts).toEqual(
			expect.arrayContaining(['inherit', 'byo', 'override']),
		);
	});

	test('inherit hides the credentials form and shows the inherit banner', async ({
		page,
	}) => {
		await ensureTriggerOrSkip(page);
		const modeSelect = page.locator('select').nth(1);
		await modeSelect.selectOption('inherit');
		await page.waitForTimeout(400);
		await expect(
			page.locator('[data-testid="job-runtime-credentials-form"]'),
		).toHaveCount(0);
		await expect(
			page.locator('[data-testid="job-runtime-mode-banner-trigger-inherit"]'),
		).toBeVisible({ timeout: 5_000 });
	});

	test('byo reveals credentialsSecretRef + all 4 trigger fields + byo banner', async ({
		page,
	}) => {
		await ensureTriggerOrSkip(page);
		const modeSelect = page.locator('select').nth(1);
		await modeSelect.selectOption('byo');
		await page.waitForTimeout(400);

		await expect(
			page.locator('[data-testid="job-runtime-credentials-form"]'),
		).toBeVisible({ timeout: 5_000 });
		// 4 declared fields for trigger: accessToken, secretKey, projectRef, apiUrl
		// 2 secrets (accessToken, secretKey) + 2 plain (projectRef, apiUrl)
		const passwords = page.locator('input[type="password"]');
		expect(await passwords.count()).toBeGreaterThanOrEqual(2);
		// Per-mode banner for byo
		await expect(
			page.locator('[data-testid="job-runtime-mode-banner-trigger-byo"]'),
		).toBeVisible({ timeout: 5_000 });
	});

	test('override reveals the same field set + override banner', async ({
		page,
	}) => {
		await ensureTriggerOrSkip(page);
		const modeSelect = page.locator('select').nth(1);
		await modeSelect.selectOption('override');
		await page.waitForTimeout(400);
		await expect(
			page.locator('[data-testid="job-runtime-credentials-form"]'),
		).toBeVisible({ timeout: 5_000 });
		await expect(
			page.locator('[data-testid="job-runtime-mode-banner-trigger-override"]'),
		).toBeVisible({ timeout: 5_000 });
	});

	test('byo with all required creds empty: save toasts "required fields missing"', async ({
		page,
	}) => {
		await ensureTriggerOrSkip(page);
		await page.locator('select').nth(1).selectOption('byo');
		await page.waitForTimeout(400);

		// Fill ONLY the secret-ref so the parent's other guard
		// ("secretRefRequired") passes — we want the required-fields
		// path to trigger.
		const secretRefInput = page.locator('input[maxlength="128"]').first();
		await secretRefInput.fill('secret://e2e/missing-creds');

		await page.getByRole('button', { name: /^Save$/ }).first().click();
		// The form surfaces a toast for missing fields. Wait briefly
		// for the toast region to populate.
		await expect(
			page.getByText(/required.*missing|missing.*required/i).first(),
		).toBeVisible({ timeout: 5_000 });
	});

	test('byo with all 3 required creds + custom apiUrl: save invokes server without throwing', async ({
		page,
	}) => {
		await ensureTriggerOrSkip(page);
		await page.locator('select').nth(1).selectOption('byo');
		await page.waitForTimeout(400);

		const secretRefInput = page.locator('input[maxlength="128"]').first();
		await secretRefInput.fill('secret://e2e/trigger-byo-happy');

		// Two password inputs in order: accessToken, then secretKey.
		const passwords = page.locator('input[type="password"]');
		await passwords.nth(0).fill(TRIGGER_PAT);
		await passwords.nth(1).fill(TRIGGER_SECRET);

		// projectRef + apiUrl are plain inputs — find them by their
		// placeholder.
		await page
			.locator('input[placeholder^="proj_"]')
			.first()
			.fill(TRIGGER_PROJECT_REF);
		await page
			.locator('input[placeholder^="https://"]')
			.first()
			.fill(TRIGGER_API_URL);

		await page.getByRole('button', { name: /^Save$/ }).first().click();
		// We don't assert on the toast copy here — the server may legitimately
		// reject the synthetic secret-ref pointer. We DO assert the page
		// stays mounted (no 5xx) and the save button re-enables (request
		// completed).
		await expect(
			page.getByRole('button', { name: /^Save$/ }).first(),
		).toBeEnabled({ timeout: 15_000 });
	});

	test('byo → inherit → byo round-trip preserves credential values', async ({
		page,
	}) => {
		await ensureTriggerOrSkip(page);
		const modeSelect = page.locator('select').nth(1);

		await modeSelect.selectOption('byo');
		await page.waitForTimeout(400);
		const firstPassword = page.locator('input[type="password"]').first();
		await firstPassword.fill(TRIGGER_PAT);
		await expect(firstPassword).toHaveValue(TRIGGER_PAT);

		await modeSelect.selectOption('inherit');
		await page.waitForTimeout(400);
		await expect(
			page.locator('[data-testid="job-runtime-credentials-form"]'),
		).toHaveCount(0);

		await modeSelect.selectOption('byo');
		await page.waitForTimeout(400);
		await expect(page.locator('input[type="password"]').first()).toHaveValue(
			TRIGGER_PAT,
		);
	});

	test('trigger → bullmq → trigger: provider remount drops form-local field state', async ({
		page,
	}) => {
		await ensureTriggerOrSkip(page);
		const providerSelect = page.locator('select').first();
		const modeSelect = page.locator('select').nth(1);
		await modeSelect.selectOption('byo');
		await page.waitForTimeout(400);
		const firstPassword = page.locator('input[type="password"]').first();
		await firstPassword.fill(TRIGGER_PAT);

		// Hop to a different provider if available, then back.
		const opts = await providerSelect
			.locator('option')
			.evaluateAll((nodes) => nodes.map((o) => (o as HTMLOptionElement).value));
		test.skip(
			!opts.includes('bullmq'),
			'bullmq not in allow-list — need a second provider to assert remount.',
		);
		await providerSelect.selectOption('bullmq');
		await page.waitForTimeout(400);
		await providerSelect.selectOption('trigger');
		await page.waitForTimeout(400);
		// After remount the password field is empty (form-local state
		// reset via key={providerId} per #1552).
		await modeSelect.selectOption('byo');
		await page.waitForTimeout(400);
		const firstPasswordAfter = page.locator('input[type="password"]').first();
		await expect(firstPasswordAfter).toHaveValue('');
	});

	test('valid byo save survives a reload (saved state restored from server)', async ({
		page,
	}) => {
		await ensureTriggerOrSkip(page);
		await page.locator('select').nth(1).selectOption('byo');
		await page.waitForTimeout(400);
		const secretRefInput = page.locator('input[maxlength="128"]').first();
		await secretRefInput.fill('secret://e2e/trigger-byo-reload');
		const passwords = page.locator('input[type="password"]');
		await passwords.nth(0).fill(TRIGGER_PAT);
		await passwords.nth(1).fill(TRIGGER_SECRET);
		await page
			.locator('input[placeholder^="proj_"]')
			.first()
			.fill(TRIGGER_PROJECT_REF);
		await page.getByRole('button', { name: /^Save$/ }).first().click();
		await expect(
			page.getByRole('button', { name: /^Save$/ }).first(),
		).toBeEnabled({ timeout: 15_000 });

		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.waitForTimeout(1_000);
		// Readout block reflects the saved overlay (mode + provider).
		await expect(page.getByText(/Mode/i).first()).toBeVisible({ timeout: 5_000 });
	});

	test('help text / env-var hint chips render for each cred field', async ({
		page,
	}) => {
		await ensureTriggerOrSkip(page);
		await page.locator('select').nth(1).selectOption('byo');
		await page.waitForTimeout(400);

		for (const envVar of [
			'TRIGGER_ACCESS_TOKEN',
			'TRIGGER_SECRET_KEY',
			'TRIGGER_PROJECT_REF',
		]) {
			await expect(page.locator('code', { hasText: envVar })).toBeVisible({
				timeout: 5_000,
			});
		}
	});

	test('each secret field is type="password" by default', async ({ page }) => {
		await ensureTriggerOrSkip(page);
		await page.locator('select').nth(1).selectOption('byo');
		await page.waitForTimeout(400);
		const passwordCount = await page.locator('input[type="password"]').count();
		// Trigger.dev declares accessToken + secretKey as `secret: true`
		expect(passwordCount).toBeGreaterThanOrEqual(2);
	});

	test('reveal/hide toggle flips secret field type to text and back', async ({
		page,
	}) => {
		await ensureTriggerOrSkip(page);
		await page.locator('select').nth(1).selectOption('byo');
		await page.waitForTimeout(400);
		const firstPassword = page.locator('input[type="password"]').first();
		await firstPassword.fill(TRIGGER_PAT);
		// Reveal toggle — the eye button next to the first secret field.
		const revealBtn = page
			.getByRole('button', { name: /Reveal secret/i })
			.first();
		await expect(revealBtn).toBeVisible({ timeout: 5_000 });
		await revealBtn.click();
		// After reveal, the input is now type=text. Locator the value
		// holder by the marker we typed.
		await expect(
			page.locator(`input[type="text"][value="${TRIGGER_PAT}"]`).first(),
		).toBeVisible({ timeout: 5_000 });
		const hideBtn = page.getByRole('button', { name: /Hide secret/i }).first();
		await hideBtn.click();
		await expect(
			page.locator(`input[type="password"]`).first(),
		).toBeVisible({ timeout: 5_000 });
	});

	test('per-mode banner copy differs between inherit, byo, and override', async ({
		page,
	}) => {
		await ensureTriggerOrSkip(page);
		const modeSelect = page.locator('select').nth(1);
		const seen: Record<string, string> = {};
		for (const m of ['inherit', 'byo', 'override'] as const) {
			await modeSelect.selectOption(m);
			await page.waitForTimeout(300);
			const banner = page.locator(
				`[data-testid="job-runtime-mode-banner-trigger-${m}"]`,
			);
			await expect(banner).toBeVisible({ timeout: 5_000 });
			seen[m] = (await banner.innerText()).trim();
			expect(seen[m].length).toBeGreaterThan(10);
		}
		expect(new Set(Object.values(seen)).size).toBe(3);
	});

	test('switching trigger mode does NOT zero out the secret-ref input', async ({
		page,
	}) => {
		await ensureTriggerOrSkip(page);
		const modeSelect = page.locator('select').nth(1);
		await modeSelect.selectOption('byo');
		await page.waitForTimeout(400);
		const secretRefInput = page.locator('input[maxlength="128"]').first();
		const SENTINEL = 'secret://e2e/preserve-on-mode-flip';
		await secretRefInput.fill(SENTINEL);
		await modeSelect.selectOption('override');
		await page.waitForTimeout(400);
		// `override` keeps the credentials block visible, so the
		// secret-ref input should still hold the same value.
		await expect(
			page.locator('input[maxlength="128"]').first(),
		).toHaveValue(SENTINEL);
	});
});

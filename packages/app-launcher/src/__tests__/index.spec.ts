import { describe, expect, it, vi } from 'vitest';

/**
 * T10 — the entry point.
 *
 * The one thing this spec exists for: importing `src/index.ts` more than once
 * must never throw `NotSupportedError: the name "ever-app-launcher" has already
 * been used with this registry`. A host that loads the component from a React
 * `useEffect` and the P2 fixture pages that load `dist/index.js` from a
 * `<script type="module">` tag can both evaluate the module; the guard in
 * `ever-app-launcher.ts` is what keeps that idempotent.
 */
describe('@ever-works/app-launcher entry point', () => {
	it('registers the element when it is imported', async () => {
		const entry = await import('../index.js');
		expect(entry.EverAppLauncher).toBeTypeOf('function');
		expect(customElements.get('ever-app-launcher')).toBe(entry.EverAppLauncher);
	});

	it('is importable twice without a customElements.define error', async () => {
		await import('../index.js');
		vi.resetModules();
		await expect(import('../index.js')).resolves.toBeTruthy();
		vi.resetModules();
		await expect(import('../index.js')).resolves.toBeTruthy();
		expect(customElements.get('ever-app-launcher')).toBeTypeOf('function');
	});

	it('still imports when the tag is already taken by another definition', async () => {
		const tag = 'ever-app-launcher-import-guard-probe';
		if (!customElements.get(tag)) {
			customElements.define(tag, class extends HTMLElement {});
		}
		vi.resetModules();
		const entry = await import('../index.js');
		expect(entry.EverAppLauncher).toBeTypeOf('function');
		// The element's own tag is untouched by the probe.
		expect(customElements.get('ever-app-launcher')).toBeTypeOf('function');
	});

	it('re-exports the public surface the host and the fixtures use', async () => {
		const entry = await import('../index.js');
		expect(entry.DEFAULT_LAUNCHER_STRINGS.controlLabel).toBe('App Launcher');
		expect(entry.EVER_APP_LAUNCHER_STYLES).toContain(':host');
		expect(entry.EVER_APP_LAUNCHER_TAG).toBe('ever-app-launcher');
		expect(typeof entry.safeLauncherUrl).toBe('function');
		expect(typeof entry.isSafeLauncherUrl).toBe('function');
		expect(typeof entry.nextGridIndex).toBe('function');
		expect(typeof entry.typeaheadIndex).toBe('function');
		expect(Array.isArray(entry.GRID_NAVIGATION_KEYS)).toBe(true);
	});
});

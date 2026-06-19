/**
 * EW-742 P3.2 follow-up — type-level shape assertions for the
 * `ISecretStoreProvider` plugin contract + `secret-store-resolver`
 * plugin category.
 *
 * This is a contract-only test — concrete implementations live in
 * `packages/plugins/secret-store-{vault,k8s,infisical,doppler}` (each
 * with its own runtime tests) plus the in-process default in
 * `packages/agent/src/tasks/in-process-secret-store-resolver.service.ts`.
 *
 * What this spec pins:
 *   1. The `secret-store-resolver` category is in `PLUGIN_CATEGORIES`.
 *   2. `ISecretStoreProvider` is structurally `IPlugin`-shaped (so the
 *      plugin registry holds it without special-casing).
 *   3. `resolveSecret` returns `Promise<Record<string, unknown> | null>`
 *      (fail-open contract — implementations return null, never throw,
 *      on missing/malformed pointers).
 *   4. `SECRET_STORE_CAPABILITIES.RESOLVE` is the capability string
 *      implementations declare in their plugin manifest.
 */

import { describe, expectTypeOf, it } from 'vitest';
import { PLUGIN_CATEGORIES, type PluginCategory, isPluginCategory } from '../plugin-manifest.types.js';
import {
	SECRET_STORE_CAPABILITIES,
	type ISecretStoreProvider,
	type SecretStoreCapability
} from '../capabilities/secret-store.interface.js';
import type { IPlugin } from '../plugin.interface.js';

describe('ISecretStoreProvider — contract surface', () => {
	it("'secret-store-resolver' is in PLUGIN_CATEGORIES", () => {
		expectTypeOf<'secret-store-resolver'>().toExtend<PluginCategory>();
		// Runtime check too — the readonly tuple values are the source of truth.
		const found = PLUGIN_CATEGORIES.includes('secret-store-resolver');
		if (!found) throw new Error("'secret-store-resolver' missing from PLUGIN_CATEGORIES");
	});

	it("isPluginCategory('secret-store-resolver') returns true", () => {
		const value: string = 'secret-store-resolver';
		if (!isPluginCategory(value)) {
			throw new Error("isPluginCategory rejected 'secret-store-resolver'");
		}
	});

	it('ISecretStoreProvider extends IPlugin (registry-compatible)', () => {
		expectTypeOf<ISecretStoreProvider>().toMatchTypeOf<IPlugin>();
	});

	it('resolveSecret returns Promise<Record<string, unknown> | null> (fail-open)', () => {
		type Provider = ISecretStoreProvider;
		expectTypeOf<Provider['resolveSecret']>().toEqualTypeOf<
			(pointer: string) => Promise<Record<string, unknown> | null>
		>();
	});

	it('SECRET_STORE_CAPABILITIES.RESOLVE is the capability string', () => {
		expectTypeOf(SECRET_STORE_CAPABILITIES.RESOLVE).toEqualTypeOf<'secret-store-resolve'>();
		expectTypeOf<SecretStoreCapability>().toEqualTypeOf<'secret-store-resolve'>();
	});

	it('a concrete provider satisfies the interface (structural check via mock)', () => {
		const mock: ISecretStoreProvider = {
			id: 'mock-secret-store',
			name: 'Mock Secret Store',
			version: '0.0.0-test',
			category: 'secret-store-resolver',
			capabilities: [SECRET_STORE_CAPABILITIES.RESOLVE],
			settingsSchema: { type: 'object', properties: {} },
			async resolveSecret(pointer: string) {
				if (pointer.startsWith('mock:')) {
					return { token: 'from-mock' };
				}
				return null;
			},
			async onLoad() {
				/* no-op */
			},
			async onUnload() {
				/* no-op */
			}
		} satisfies ISecretStoreProvider;
		expectTypeOf(mock).toMatchTypeOf<ISecretStoreProvider>();
	});
});

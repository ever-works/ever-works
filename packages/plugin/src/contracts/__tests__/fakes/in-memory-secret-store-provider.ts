import type { ISecretStoreProvider } from '../../capabilities/secret-store.interface.js';
import { SECRET_STORE_CAPABILITIES } from '../../capabilities/secret-store.interface.js';
import type { PluginCategory, PluginContext } from '../../index.js';
import type { JsonSchema } from '../../../settings/json-schema.types.js';

/**
 * EW-742 P3.2 — reference in-memory `ISecretStoreProvider` used by
 * `runSecretStoreContractSuite`. Self-applies the same conformance
 * suite concrete plugins (Vault / K8s / Infisical / Doppler / AWS-SM
 * / GCP-SM / Azure-KV) run, so contract drift fails at the
 * `@ever-works/plugin` layer first.
 *
 * Recognises a tiny scheme matrix:
 *   - `inline:<base64-of-json>` — credential bag carried in the pointer
 *   - `fake:<key>` — looks up a pre-seeded map for unit-test scenarios
 *
 * Anything else (or any thrown error inside the resolver) is fail-open
 * → `null`, matching the contract.
 */

export interface InMemorySecretStoreSeed {
	readonly [key: string]: Readonly<Record<string, unknown>>;
}

export class InMemorySecretStoreProvider implements ISecretStoreProvider {
	readonly id = 'secret-store-in-memory';
	readonly name = 'In-memory Secret Store (test fake)';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'secret-store-resolver';
	readonly capabilities: readonly string[] = [SECRET_STORE_CAPABILITIES.RESOLVE];
	readonly settingsSchema: JsonSchema = { type: 'object', properties: {} };

	constructor(private readonly seed: InMemorySecretStoreSeed = {}) {}

	async onLoad(_ctx: PluginContext): Promise<void> {
		// noop
	}
	async onUnload(): Promise<void> {
		// noop
	}

	async resolveSecret(pointer: string): Promise<Record<string, unknown> | null> {
		try {
			if (pointer.startsWith('inline:')) {
				const decoded = Buffer.from(pointer.slice('inline:'.length), 'base64').toString('utf-8');
				const parsed: unknown = JSON.parse(decoded);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					return parsed as Record<string, unknown>;
				}
				return null;
			}
			if (pointer.startsWith('fake:')) {
				const key = pointer.slice('fake:'.length);
				return this.seed[key] ?? null;
			}
			return null;
		} catch {
			return null;
		}
	}
}

export function createInMemorySecretStoreProvider(
	seed: InMemorySecretStoreSeed = {}
): InMemorySecretStoreProvider {
	return new InMemorySecretStoreProvider(seed);
}

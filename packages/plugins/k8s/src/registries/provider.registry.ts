import type { RegistryKind } from '../types.js';
import { K8sPluginError } from '../errors.js';
import type { RegistryProvider } from './provider.js';
import { GitHubRegistryProvider } from './github.provider.js';
import { DockerHubRegistryProvider } from './dockerhub.provider.js';
import { GenericRegistryProvider } from './generic.provider.js';

/**
 * Strategy registry for container registry providers. Built-ins are
 * registered up front; downstream code can register more without changing
 * deploy logic.
 */
export class RegistryProviderRegistry {
	private readonly providers = new Map<RegistryKind, RegistryProvider>();

	constructor() {
		this.register(new GitHubRegistryProvider());
		this.register(new DockerHubRegistryProvider());
		this.register(new GenericRegistryProvider());
	}

	register(provider: RegistryProvider): void {
		this.providers.set(provider.kind, provider);
	}

	resolve(kind: RegistryKind): RegistryProvider {
		const provider = this.providers.get(kind);
		if (!provider) {
			throw new K8sPluginError('UNKNOWN', `No registry provider registered for kind '${kind}'`);
		}
		return provider;
	}

	knownKinds(): RegistryKind[] {
		return Array.from(this.providers.keys());
	}
}

/**
 * Default singleton used by the plugin. Tests can construct their own.
 */
export const defaultRegistryProviderRegistry = new RegistryProviderRegistry();

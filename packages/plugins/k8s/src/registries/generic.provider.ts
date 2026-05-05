import type {
	GenericRegistryConfig,
	RegistryConfig,
	RegistryDeployContext,
	RegistryWorkflowLogin,
	ResolvedImageVisibility
} from '../types.js';
import { K8sPluginError } from '../errors.js';
import type { RegistryProvider } from './provider.js';

export class GenericRegistryProvider implements RegistryProvider {
	readonly kind = 'generic' as const;

	imageBase(config: RegistryConfig, _ctx: RegistryDeployContext): string {
		const cfg = this.expect(config);
		return `${normaliseHost(cfg.server)}/${cfg.username.toLowerCase()}`;
	}

	resolveVisibility(_config: RegistryConfig, _ctx: RegistryDeployContext): ResolvedImageVisibility {
		return 'private';
	}

	workflowLogin(config: RegistryConfig): RegistryWorkflowLogin {
		const cfg = this.expect(config);
		return {
			registry: normaliseHost(cfg.server),
			username: '${{ secrets.REGISTRY_USERNAME }}',
			passwordEnv: 'REGISTRY_PASSWORD'
		};
	}

	pullSecretCredentials(
		config: RegistryConfig,
		_ctx: RegistryDeployContext,
		visibility: ResolvedImageVisibility
	): { server: string; username: string; password: string } | null {
		if (visibility === 'public') {
			return null;
		}
		const cfg = this.expect(config);
		return {
			server: normaliseHost(cfg.server),
			username: cfg.username,
			password: cfg.password
		};
	}

	private expect(config: RegistryConfig): GenericRegistryConfig {
		if (config.kind !== 'generic') {
			throw new K8sPluginError('UNKNOWN', `GenericRegistryProvider received non-generic config: ${config.kind}`);
		}
		return config;
	}
}

function normaliseHost(server: string): string {
	return server.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

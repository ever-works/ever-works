import type {
	DockerHubRegistryConfig,
	RegistryConfig,
	RegistryDeployContext,
	RegistryWorkflowLogin,
	ResolvedImageVisibility,
} from '../types.js';
import { K8sPluginError } from '../errors.js';
import type { RegistryProvider } from './provider.js';

const DOCKERHUB_HOST = 'docker.io';

export class DockerHubRegistryProvider implements RegistryProvider {
	readonly kind = 'dockerhub' as const;

	imageBase(config: RegistryConfig, _ctx: RegistryDeployContext): string {
		const cfg = this.expect(config);
		return `${DOCKERHUB_HOST}/${cfg.username.toLowerCase()}`;
	}

	resolveVisibility(_config: RegistryConfig, _ctx: RegistryDeployContext): ResolvedImageVisibility {
		// Docker Hub auth is always provided; assume private and provision
		// a pull secret. Public Docker Hub repos still pull fine with the
		// pull secret, so this is the safe default.
		return 'private';
	}

	workflowLogin(_config: RegistryConfig): RegistryWorkflowLogin {
		return {
			registry: DOCKERHUB_HOST,
			username: '${{ secrets.REGISTRY_USERNAME }}',
			passwordEnv: 'REGISTRY_PASSWORD',
		};
	}

	pullSecretCredentials(
		config: RegistryConfig,
		_ctx: RegistryDeployContext,
		visibility: ResolvedImageVisibility,
	): { server: string; username: string; password: string } | null {
		if (visibility === 'public') {
			return null;
		}
		const cfg = this.expect(config);
		return {
			server: DOCKERHUB_HOST,
			username: cfg.username,
			password: cfg.password,
		};
	}

	private expect(config: RegistryConfig): DockerHubRegistryConfig {
		if (config.kind !== 'dockerhub') {
			throw new K8sPluginError(
				'UNKNOWN',
				`DockerHubRegistryProvider received non-dockerhub config: ${config.kind}`,
			);
		}
		return config;
	}
}

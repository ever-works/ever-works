import type {
	ModelCliCommand,
	ModelExecutionIo,
	ModelExecutionProvider,
	ModelProcessContainment
} from './model-process.internal';
import { createWindowsJobModelProcessContainmentInternal } from '../windows-job-launcher/windows-job-model-containment.internal';
import type { WindowsJobHelperTrustPolicyInternal } from '../windows-job-launcher/windows-job-helper-trust.internal';

export interface ProductionModelExecutionConfigInternal {
	readonly commands: Readonly<Record<ModelExecutionProvider, ModelCliCommand>>;
	readonly windowsJobLauncher?: WindowsJobHelperTrustPolicyInternal;
}

export interface ProductionModelExecutionFactoryDependenciesInternal {
	readonly platform: NodeJS.Platform;
	readonly createWindowsContainment: (policy: WindowsJobHelperTrustPolicyInternal) => ModelProcessContainment;
}

const defaultDependencies: ProductionModelExecutionFactoryDependenciesInternal = {
	platform: process.platform,
	createWindowsContainment: (policy) => createWindowsJobModelProcessContainmentInternal(policy)
};

export function createProductionModelExecutionIoInternal(
	config: ProductionModelExecutionConfigInternal,
	dependencyOverrides: Partial<ProductionModelExecutionFactoryDependenciesInternal> = {}
): ModelExecutionIo {
	const dependencies = { ...defaultDependencies, ...dependencyOverrides };
	const commands: Readonly<Record<ModelExecutionProvider, ModelCliCommand>> = Object.freeze({
		'claude-code': Object.freeze({ ...config.commands['claude-code'] }),
		codex: Object.freeze({ ...config.commands.codex })
	});
	if (dependencies.platform !== 'win32' || config.windowsJobLauncher === undefined) {
		return Object.freeze({ commands });
	}
	const windowsJobLauncher: WindowsJobHelperTrustPolicyInternal = Object.freeze({
		...config.windowsJobLauncher
	});
	return Object.freeze({
		commands,
		createModelProcessContainment: async () => dependencies.createWindowsContainment(windowsJobLauncher)
	});
}

import type { IPlugin } from '../contracts/plugin.interface.js';
import type { IGitProviderPlugin } from '../contracts/capabilities/git-provider.interface.js';
import type { IDeploymentPlugin } from '../contracts/capabilities/deployment.interface.js';
import type { IScreenshotPlugin } from '../contracts/capabilities/screenshot.interface.js';
import type { ISearchPlugin } from '../contracts/capabilities/search.interface.js';
import type { IAiProviderPlugin } from '../contracts/capabilities/ai-provider.interface.js';
import type { IPipelineModifierPlugin } from '../contracts/capabilities/pipeline-modifier.interface.js';
import type { IPipelinePlugin } from '../contracts/capabilities/pipeline-plugin.interface.js';
import { isPluginCategory, PLUGIN_CATEGORIES } from '../contracts/plugin-manifest.types.js';
import { createTestHarness, type PluginTestHarness, type PluginTestResult } from './plugin-test-harness.js';

/**
 * Contract test suite for base plugin interface
 */
export async function testBasePluginContract(plugin: IPlugin): Promise<PluginTestResult[]> {
	const harness = createTestHarness(plugin);
	const results: PluginTestResult[] = [];

	results.push(
		await harness.test('has required id property', async () => {
			harness.assert(typeof plugin.id === 'string', 'id must be a string');
			harness.assert(plugin.id.length > 0, 'id must not be empty');
		})
	);

	results.push(
		await harness.test('has required name property', async () => {
			harness.assert(typeof plugin.name === 'string', 'name must be a string');
			harness.assert(plugin.name.length > 0, 'name must not be empty');
		})
	);

	results.push(
		await harness.test('has required version property', async () => {
			harness.assert(typeof plugin.version === 'string', 'version must be a string');
			harness.assert(/^\d+\.\d+\.\d+/.test(plugin.version), 'version must be semver');
		})
	);

	results.push(
		await harness.test('has required category property', async () => {
			harness.assert(typeof plugin.category === 'string', 'category must be a string');
			harness.assert(
				isPluginCategory(plugin.category),
				`category must be one of: ${PLUGIN_CATEGORIES.join(', ')}`
			);
		})
	);

	results.push(
		await harness.test('has capabilities array', async () => {
			harness.assert(Array.isArray(plugin.capabilities), 'capabilities must be an array');
		})
	);

	results.push(
		await harness.test('has settingsSchema object', async () => {
			harness.assert(typeof plugin.settingsSchema === 'object', 'settingsSchema must be an object');
		})
	);

	results.push(
		await harness.test('implements lifecycle methods', async () => {
			harness.assert(typeof plugin.onLoad === 'function', 'onLoad must be a function');
			harness.assert(typeof plugin.onUnload === 'function', 'onUnload must be a function');
		})
	);

	results.push(
		await harness.test('implements validateSettings', async () => {
			harness.assert(typeof plugin.validateSettings === 'function', 'validateSettings must be a function');
		})
	);

	// Run lifecycle tests
	results.push(...(await harness.testLifecycle()));

	return results;
}

/**
 * Contract test suite for git provider plugins
 */
export async function testGitProviderContract(plugin: IGitProviderPlugin): Promise<PluginTestResult[]> {
	const results = await testBasePluginContract(plugin);
	const harness = createTestHarness(plugin);

	results.push(
		await harness.test('has git-provider capability', async () => {
			harness.assert(plugin.capabilities.includes('git-provider'), 'must have git-provider capability');
		})
	);

	results.push(
		await harness.test('has providerName property', async () => {
			harness.assert(typeof plugin.providerName === 'string', 'providerName must be a string');
		})
	);

	results.push(
		await harness.test('implements getAuth', async () => {
			harness.assert(typeof plugin.getAuth === 'function', 'getAuth must be a function');
		})
	);

	results.push(
		await harness.test('implements getCloneUrl', async () => {
			harness.assert(typeof plugin.getCloneUrl === 'function', 'getCloneUrl must be a function');
		})
	);

	results.push(
		await harness.test('implements getWebUrl', async () => {
			harness.assert(typeof plugin.getWebUrl === 'function', 'getWebUrl must be a function');
		})
	);

	return results;
}

/**
 * Contract test suite for deployment plugins
 */
export async function testDeploymentContract(plugin: IDeploymentPlugin): Promise<PluginTestResult[]> {
	const results = await testBasePluginContract(plugin);
	const harness = createTestHarness(plugin);

	results.push(
		await harness.test('has deployment capability', async () => {
			harness.assert(plugin.capabilities.includes('deployment'), 'must have deployment capability');
		})
	);

	results.push(
		await harness.test('has providerName property', async () => {
			harness.assert(typeof plugin.providerName === 'string', 'providerName must be a string');
		})
	);

	results.push(
		await harness.test('implements deploy', async () => {
			harness.assert(typeof plugin.deploy === 'function', 'deploy must be a function');
		})
	);

	results.push(
		await harness.test('implements getDeploymentStatus', async () => {
			harness.assert(typeof plugin.getDeploymentStatus === 'function', 'getDeploymentStatus must be a function');
		})
	);

	return results;
}

/**
 * Contract test suite for screenshot plugins
 */
export async function testScreenshotContract(plugin: IScreenshotPlugin): Promise<PluginTestResult[]> {
	const results = await testBasePluginContract(plugin);
	const harness = createTestHarness(plugin);

	results.push(
		await harness.test('has screenshot capability', async () => {
			harness.assert(plugin.capabilities.includes('screenshot'), 'must have screenshot capability');
		})
	);

	results.push(
		await harness.test('has providerName property', async () => {
			harness.assert(typeof plugin.providerName === 'string', 'providerName must be a string');
		})
	);

	results.push(
		await harness.test('implements capture', async () => {
			harness.assert(typeof plugin.capture === 'function', 'capture must be a function');
		})
	);

	results.push(
		await harness.test('implements isAvailable', async () => {
			harness.assert(typeof plugin.isAvailable === 'function', 'isAvailable must be a function');
		})
	);

	return results;
}

/**
 * Contract test suite for search plugins
 */
export async function testSearchContract(plugin: ISearchPlugin): Promise<PluginTestResult[]> {
	const results = await testBasePluginContract(plugin);
	const harness = createTestHarness(plugin);

	results.push(
		await harness.test('has search capability', async () => {
			harness.assert(plugin.capabilities.includes('search'), 'must have search capability');
		})
	);

	results.push(
		await harness.test('has providerName property', async () => {
			harness.assert(typeof plugin.providerName === 'string', 'providerName must be a string');
		})
	);

	results.push(
		await harness.test('implements search', async () => {
			harness.assert(typeof plugin.search === 'function', 'search must be a function');
		})
	);

	results.push(
		await harness.test('implements isAvailable', async () => {
			harness.assert(typeof plugin.isAvailable === 'function', 'isAvailable must be a function');
		})
	);

	return results;
}

/**
 * Contract test suite for AI provider plugins
 */
export async function testAiProviderContract(plugin: IAiProviderPlugin): Promise<PluginTestResult[]> {
	const results = await testBasePluginContract(plugin);
	const harness = createTestHarness(plugin);

	results.push(
		await harness.test('has ai-provider capability', async () => {
			harness.assert(plugin.capabilities.includes('ai-provider'), 'must have ai-provider capability');
		})
	);

	results.push(
		await harness.test('has providerType property', async () => {
			harness.assert(typeof plugin.providerType === 'string', 'providerType must be a string');
		})
	);

	results.push(
		await harness.test('has providerName property', async () => {
			harness.assert(typeof plugin.providerName === 'string', 'providerName must be a string');
		})
	);

	results.push(
		await harness.test('implements createChatCompletion', async () => {
			harness.assert(
				typeof plugin.createChatCompletion === 'function',
				'createChatCompletion must be a function'
			);
		})
	);

	results.push(
		await harness.test('implements listModels', async () => {
			harness.assert(typeof plugin.listModels === 'function', 'listModels must be a function');
		})
	);

	results.push(
		await harness.test('implements getCapabilities', async () => {
			harness.assert(typeof plugin.getCapabilities === 'function', 'getCapabilities must be a function');
		})
	);

	return results;
}

/**
 * Contract test suite for pipeline plugins
 */
export async function testPipelineContract(plugin: IPipelinePlugin): Promise<PluginTestResult[]> {
	const results = await testBasePluginContract(plugin);
	const harness = createTestHarness(plugin);

	results.push(
		await harness.test('has pipeline capability', async () => {
			harness.assert(plugin.capabilities.includes('pipeline'), 'must have pipeline capability');
		})
	);

	results.push(
		await harness.test('implements getStepDefinitions', async () => {
			harness.assert(typeof plugin.getStepDefinitions === 'function', 'getStepDefinitions must be a function');
			const steps = plugin.getStepDefinitions();
			harness.assert(Array.isArray(steps), 'getStepDefinitions must return an array');
			harness.assert(steps.length > 0, 'getStepDefinitions must return at least one step');
		})
	);

	results.push(
		await harness.test('implements execute', async () => {
			harness.assert(typeof plugin.execute === 'function', 'execute must be a function');
		})
	);

	results.push(
		await harness.test('step definitions have required fields', async () => {
			const steps = plugin.getStepDefinitions();
			for (const step of steps) {
				harness.assert(typeof step.id === 'string', `step.id must be a string, got ${typeof step.id}`);
				harness.assert(typeof step.name === 'string', `step.name must be a string, got ${typeof step.name}`);
				harness.assert(
					typeof step.position === 'object',
					`step.position must be an object for step "${step.id}"`
				);
			}
		})
	);

	return results;
}

/**
 * Contract test suite for pipeline modifier plugins
 */
export async function testPipelineModifierContract(plugin: IPipelineModifierPlugin): Promise<PluginTestResult[]> {
	const results = await testBasePluginContract(plugin);
	const harness = createTestHarness(plugin);

	results.push(
		await harness.test('has pipeline-modifier capability', async () => {
			harness.assert(plugin.capabilities.includes('pipeline-modifier'), 'must have pipeline-modifier capability');
		})
	);

	results.push(
		await harness.test('has targetPipelines', async () => {
			harness.assert(Array.isArray(plugin.targetPipelines), 'targetPipelines must be an array');
			harness.assert(plugin.targetPipelines.length > 0, 'targetPipelines must not be empty');
		})
	);

	results.push(
		await harness.test('implements execute', async () => {
			harness.assert(typeof plugin.execute === 'function', 'execute must be a function');
		})
	);

	results.push(
		await harness.test('getStepDefinition returns valid definition', async () => {
			const definition = plugin.getStepDefinition?.();
			harness.assert(definition !== undefined, 'definition must not be undefined');
			if (definition) {
				harness.assert(typeof definition.id === 'string', 'definition.id must be a string');
				harness.assert(typeof definition.name === 'string', 'definition.name must be a string');
				harness.assert(typeof definition.position === 'object', 'definition.position must be an object');
			}
		})
	);

	return results;
}

/**
 * Run all applicable contract tests for a plugin
 */
export async function runContractTests(plugin: IPlugin): Promise<PluginTestResult[]> {
	const results: PluginTestResult[] = [];

	// Always run base tests
	results.push(...(await testBasePluginContract(plugin)));

	// Run capability-specific tests
	if (plugin.capabilities.includes('git-provider')) {
		results.push(...(await testGitProviderContract(plugin as IGitProviderPlugin)));
	}

	if (plugin.capabilities.includes('deployment')) {
		results.push(...(await testDeploymentContract(plugin as IDeploymentPlugin)));
	}

	if (plugin.capabilities.includes('screenshot')) {
		results.push(...(await testScreenshotContract(plugin as IScreenshotPlugin)));
	}

	if (plugin.capabilities.includes('search')) {
		results.push(...(await testSearchContract(plugin as ISearchPlugin)));
	}

	if (plugin.capabilities.includes('ai-provider')) {
		results.push(...(await testAiProviderContract(plugin as IAiProviderPlugin)));
	}

	if (plugin.capabilities.includes('pipeline')) {
		results.push(...(await testPipelineContract(plugin as IPipelinePlugin)));
	}

	if (plugin.capabilities.includes('pipeline-modifier')) {
		results.push(...(await testPipelineModifierContract(plugin as IPipelineModifierPlugin)));
	}

	return results;
}

import type { IPlugin } from '../contracts/plugin.interface.js';
import type { IGitProviderPlugin } from '../contracts/capabilities/git-provider.interface.js';
import type { IDeploymentPlugin } from '../contracts/capabilities/deployment.interface.js';
import type { IScreenshotPlugin } from '../contracts/capabilities/screenshot.interface.js';
import type { ISearchPlugin } from '../contracts/capabilities/search.interface.js';
import type { IAiProviderPlugin } from '../contracts/capabilities/ai-provider.interface.js';
import type { IPipelineStepPlugin } from '../contracts/capabilities/pipeline-step.interface.js';
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
			harness.assert(typeof plugin.onEnable === 'function', 'onEnable must be a function');
			harness.assert(typeof plugin.onDisable === 'function', 'onDisable must be a function');
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
 * Contract test suite for pipeline step plugins
 */
export async function testPipelineStepContract(plugin: IPipelineStepPlugin): Promise<PluginTestResult[]> {
	const results = await testBasePluginContract(plugin);
	const harness = createTestHarness(plugin);

	results.push(
		await harness.test('has pipeline-step capability', async () => {
			harness.assert(plugin.capabilities.includes('pipeline-step'), 'must have pipeline-step capability');
		})
	);

	results.push(
		await harness.test('implements getStepDefinition', async () => {
			harness.assert(typeof plugin.getStepDefinition === 'function', 'getStepDefinition must be a function');
		})
	);

	results.push(
		await harness.test('implements execute', async () => {
			harness.assert(typeof plugin.execute === 'function', 'execute must be a function');
		})
	);

	results.push(
		await harness.test('getStepDefinition returns valid definition', async () => {
			const definition = plugin.getStepDefinition();
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

	if (plugin.capabilities.includes('pipeline-step')) {
		results.push(...(await testPipelineStepContract(plugin as IPipelineStepPlugin)));
	}

	return results;
}

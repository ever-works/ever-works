import type { IPlugin } from '../contracts/plugin.interface.js';
import type { PluginContext } from '../contracts/plugin-context.interface.js';
import type { PluginHealthCheck } from '../contracts/lifecycle.types.js';
import { createMockPluginContext, type MockPluginContextOptions } from './mock-plugin-context.js';

/**
 * Plugin test result
 */
export interface PluginTestResult {
	readonly passed: boolean;
	readonly name: string;
	readonly duration: number;
	readonly error?: Error;
}

/**
 * Plugin test suite result
 */
export interface PluginTestSuiteResult {
	readonly plugin: string;
	readonly passed: number;
	readonly failed: number;
	readonly total: number;
	readonly duration: number;
	readonly results: readonly PluginTestResult[];
}

/**
 * Test harness options
 */
export interface PluginTestHarnessOptions extends MockPluginContextOptions {
	/** Timeout for operations in ms */
	timeout?: number;
}

/**
 * Test harness for plugin testing
 * Provides utilities for testing plugin lifecycle and operations
 */
export class PluginTestHarness<T extends IPlugin = IPlugin> {
	readonly plugin: T;
	readonly context: PluginContext;
	readonly options: PluginTestHarnessOptions;

	private loadedAt?: number;
	private testResults: PluginTestResult[] = [];

	constructor(plugin: T, options: PluginTestHarnessOptions = {}) {
		this.plugin = plugin;
		this.options = options;
		this.context = createMockPluginContext({
			pluginId: plugin.id,
			...options
		});
	}

	/**
	 * Load the plugin
	 */
	async load(): Promise<void> {
		await this.plugin.onLoad(this.context);
		this.loadedAt = Date.now();
	}

	/**
	 * Unload the plugin
	 */
	async unload(): Promise<void> {
		await this.plugin.onUnload();
		this.loadedAt = undefined;
	}

	/**
	 * Check if plugin is loaded
	 */
	get isLoaded(): boolean {
		return this.loadedAt !== undefined;
	}

	/**
	 * Perform health check
	 */
	async healthCheck(): Promise<PluginHealthCheck | undefined> {
		if (this.plugin.healthCheck) {
			return this.plugin.healthCheck();
		}
		return undefined;
	}

	/**
	 * Run a test case
	 */
	async test(name: string, fn: (harness: this) => Promise<void>): Promise<PluginTestResult> {
		const start = Date.now();
		let error: Error | undefined;

		try {
			await fn(this);
		} catch (e) {
			error = e instanceof Error ? e : new Error(String(e));
		}

		const result: PluginTestResult = {
			passed: !error,
			name,
			duration: Date.now() - start,
			error
		};

		this.testResults.push(result);
		return result;
	}

	/**
	 * Get test results
	 */
	getResults(): PluginTestSuiteResult {
		const passed = this.testResults.filter((r) => r.passed).length;
		const failed = this.testResults.filter((r) => !r.passed).length;
		const duration = this.testResults.reduce((sum, r) => sum + r.duration, 0);

		return {
			plugin: this.plugin.id,
			passed,
			failed,
			total: this.testResults.length,
			duration,
			results: [...this.testResults]
		};
	}

	/**
	 * Clear test results
	 */
	clearResults(): void {
		this.testResults = [];
	}

	/**
	 * Assert a condition
	 */
	assert(condition: boolean, message: string): void {
		if (!condition) {
			throw new Error(`Assertion failed: ${message}`);
		}
	}

	/**
	 * Assert equality
	 */
	assertEqual<U>(actual: U, expected: U, message?: string): void {
		if (actual !== expected) {
			const msg = message ?? `Expected ${expected}, got ${actual}`;
			throw new Error(msg);
		}
	}

	/**
	 * Assert deep equality
	 */
	assertDeepEqual<U>(actual: U, expected: U, message?: string): void {
		if (JSON.stringify(actual) !== JSON.stringify(expected)) {
			const msg = message ?? `Objects are not deeply equal`;
			throw new Error(msg);
		}
	}

	/**
	 * Assert that a promise rejects
	 */
	async assertRejects(fn: () => Promise<unknown>, message?: string): Promise<Error> {
		try {
			await fn();
			throw new Error(message ?? 'Expected promise to reject');
		} catch (e) {
			if (e instanceof Error && e.message === (message ?? 'Expected promise to reject')) {
				throw e;
			}
			return e instanceof Error ? e : new Error(String(e));
		}
	}

	/**
	 * Run full lifecycle test
	 */
	async testLifecycle(): Promise<PluginTestResult[]> {
		const results: PluginTestResult[] = [];

		results.push(
			await this.test('plugin loads successfully', async () => {
				await this.load();
				this.assert(this.isLoaded, 'Plugin should be loaded');
			})
		);

		results.push(
			await this.test('plugin unloads successfully', async () => {
				await this.unload();
				this.assert(!this.isLoaded, 'Plugin should be unloaded');
			})
		);

		return results;
	}
}

/**
 * Create a test harness for a plugin
 */
export function createTestHarness<T extends IPlugin>(
	plugin: T,
	options?: PluginTestHarnessOptions
): PluginTestHarness<T> {
	return new PluginTestHarness(plugin, options);
}

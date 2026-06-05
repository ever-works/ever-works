import { describe, it, expect } from 'vitest';
import { isPluginDistribution, isPluginExecutionProfile, resolvePluginDistribution } from '../plugin-manifest.types.js';

describe('PluginManifest distribution (EW-693)', () => {
	describe('resolvePluginDistribution', () => {
		it('returns the explicit distribution when set to core', () => {
			expect(resolvePluginDistribution({ distribution: 'core', systemPlugin: false })).toBe('core');
		});

		it('returns the explicit distribution when set to registry', () => {
			expect(resolvePluginDistribution({ distribution: 'registry', systemPlugin: true })).toBe('registry');
		});

		it('defaults to core when omitted and systemPlugin is true', () => {
			expect(resolvePluginDistribution({ systemPlugin: true })).toBe('core');
		});

		it('defaults to registry when omitted and systemPlugin is false', () => {
			expect(resolvePluginDistribution({ systemPlugin: false })).toBe('registry');
		});

		it('defaults to registry when both fields are omitted', () => {
			expect(resolvePluginDistribution({})).toBe('registry');
		});

		it('treats invalid distribution values as missing and falls back to systemPlugin', () => {
			expect(
				resolvePluginDistribution({
					distribution: 'invalid' as unknown as 'core',
					systemPlugin: true
				})
			).toBe('core');
			expect(
				resolvePluginDistribution({
					distribution: 'invalid' as unknown as 'core',
					systemPlugin: false
				})
			).toBe('registry');
		});
	});

	describe('isPluginDistribution', () => {
		it('accepts the two valid values', () => {
			expect(isPluginDistribution('core')).toBe(true);
			expect(isPluginDistribution('registry')).toBe(true);
		});

		it('rejects everything else', () => {
			expect(isPluginDistribution(undefined)).toBe(false);
			expect(isPluginDistribution(null)).toBe(false);
			expect(isPluginDistribution('')).toBe(false);
			expect(isPluginDistribution('Core')).toBe(false);
			expect(isPluginDistribution('npm')).toBe(false);
			expect(isPluginDistribution(0)).toBe(false);
			expect(isPluginDistribution({})).toBe(false);
		});
	});

	describe('isPluginExecutionProfile', () => {
		it('accepts the two valid values', () => {
			expect(isPluginExecutionProfile('sync')).toBe(true);
			expect(isPluginExecutionProfile('long-running')).toBe(true);
		});

		it('rejects everything else', () => {
			expect(isPluginExecutionProfile(undefined)).toBe(false);
			expect(isPluginExecutionProfile(null)).toBe(false);
			expect(isPluginExecutionProfile('async')).toBe(false);
			expect(isPluginExecutionProfile('background')).toBe(false);
			expect(isPluginExecutionProfile('long_running')).toBe(false);
		});
	});
});

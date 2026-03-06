import { describe, it, expect } from 'vitest';
import { validateSettingsConstraints } from '../validate-settings-constraints.js';
import type { PluginSettingsSchemaProperty } from '../api-response.types.js';

describe('validateSettingsConstraints', () => {
	it('should return no errors for valid values', () => {
		const properties: Record<string, PluginSettingsSchemaProperty> = {
			maxResults: { type: 'number', minimum: 1, maximum: 100 },
			name: { type: 'string', minLength: 2, maxLength: 50 }
		};
		const errors = validateSettingsConstraints({ maxResults: 10, name: 'test' }, properties);
		expect(errors).toHaveLength(0);
	});

	it('should skip empty/null/undefined values', () => {
		const properties: Record<string, PluginSettingsSchemaProperty> = {
			maxResults: { type: 'number', minimum: 1 },
			name: { type: 'string', minLength: 5 }
		};
		const errors = validateSettingsConstraints({ maxResults: undefined, name: null }, properties);
		expect(errors).toHaveLength(0);
	});

	it('should validate number minimum', () => {
		const properties: Record<string, PluginSettingsSchemaProperty> = {
			maxResults: { type: 'number', title: 'Max Results', minimum: 1, maximum: 100 }
		};
		const errors = validateSettingsConstraints({ maxResults: 0 }, properties);
		expect(errors).toHaveLength(1);
		expect(errors[0].field).toBe('maxResults');
		expect(errors[0].message).toBe('Max Results must be at least 1');
	});

	it('should validate number maximum', () => {
		const properties: Record<string, PluginSettingsSchemaProperty> = {
			maxResults: { type: 'number', title: 'Max Results', minimum: 1, maximum: 100 }
		};
		const errors = validateSettingsConstraints({ maxResults: 101 }, properties);
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toBe('Max Results must be at most 100');
	});

	it('should validate string minLength', () => {
		const properties: Record<string, PluginSettingsSchemaProperty> = {
			apiKey: { type: 'string', title: 'API Key', minLength: 10 }
		};
		const errors = validateSettingsConstraints({ apiKey: 'short' }, properties);
		expect(errors).toHaveLength(1);
		expect(errors[0].field).toBe('apiKey');
		expect(errors[0].message).toBe('API Key must be at least 10 characters');
	});

	it('should validate string maxLength', () => {
		const properties: Record<string, PluginSettingsSchemaProperty> = {
			name: { type: 'string', maxLength: 5 }
		};
		const errors = validateSettingsConstraints({ name: 'toolong' }, properties);
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toBe('name must be at most 5 characters');
	});

	it('should validate string pattern', () => {
		const properties: Record<string, PluginSettingsSchemaProperty> = {
			code: { type: 'string', title: 'Code', pattern: '^[A-Z]{3}$' }
		};
		const errors = validateSettingsConstraints({ code: 'abc' }, properties);
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toBe('Code has an invalid format');
	});

	it('should ignore invalid regex patterns', () => {
		const properties: Record<string, PluginSettingsSchemaProperty> = {
			code: { type: 'string', pattern: '[invalid' }
		};
		const errors = validateSettingsConstraints({ code: 'test' }, properties);
		expect(errors).toHaveLength(0);
	});

	it('should validate enum values', () => {
		const properties: Record<string, PluginSettingsSchemaProperty> = {
			format: { type: 'string', title: 'Format', enum: ['png', 'jpg', 'webp'] }
		};
		const errors = validateSettingsConstraints({ format: 'bmp' }, properties);
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toBe('Format must be one of: png, jpg, webp');
	});

	it('should collect multiple errors', () => {
		const properties: Record<string, PluginSettingsSchemaProperty> = {
			width: { type: 'number', minimum: 100, maximum: 2000 },
			height: { type: 'number', minimum: 100, maximum: 2000 }
		};
		const errors = validateSettingsConstraints({ width: 50, height: 3000 }, properties);
		expect(errors).toHaveLength(2);
	});

	it('should use field key as label when no title', () => {
		const properties: Record<string, PluginSettingsSchemaProperty> = {
			maxResults: { type: 'number', minimum: 1 }
		};
		const errors = validateSettingsConstraints({ maxResults: 0 }, properties);
		expect(errors[0].message).toBe('maxResults must be at least 1');
	});
});

import { describe, it, expect } from 'vitest';
import {
	splitSettingsBySecret,
	getVisibleProperties,
	getRequiredFields,
	validateRequiredSettings,
	sanitizeSettingsForSave
} from '../settings-helpers.js';
import type { PluginSettingsSchema } from '../api-response.types.js';

const makeSchema = (overrides?: Partial<PluginSettingsSchema>): PluginSettingsSchema => ({
	type: 'object',
	properties: {
		apiKey: { type: 'string', title: 'API Key', secret: true, scope: 'user' },
		model: { type: 'string', title: 'Model', default: 'gpt-4', scope: 'user' },
		temperature: { type: 'number', title: 'Temperature', default: 0.7, scope: 'directory' },
		internalFlag: { type: 'string', hidden: true, scope: 'global' },
		globalSetting: { type: 'string', title: 'Global Setting', scope: 'global' }
	},
	required: ['apiKey', 'model'],
	...overrides
});

describe('splitSettingsBySecret', () => {
	it('should split settings into regular and secret based on schema', () => {
		const schema = makeSchema();
		const result = splitSettingsBySecret({ apiKey: 'sk-123', model: 'gpt-4' }, schema, ['global', 'user']);
		expect(result.secret).toEqual({ apiKey: 'sk-123' });
		expect(result.regular).toEqual({ model: 'gpt-4' });
	});

	it('should populate defaults for visible fields with no saved value', () => {
		const schema = makeSchema();
		const result = splitSettingsBySecret({}, schema, ['global', 'user']);
		expect(result.regular.model).toBe('gpt-4');
	});

	it('should not populate defaults for out-of-scope fields', () => {
		const schema = makeSchema();
		const result = splitSettingsBySecret({}, schema, ['user']);
		expect(result.regular.temperature).toBeUndefined();
	});

	it('should not populate defaults for hidden fields', () => {
		const schema: PluginSettingsSchema = {
			type: 'object',
			properties: {
				hidden: { type: 'string', hidden: true, default: 'x', scope: 'global' }
			}
		};
		const result = splitSettingsBySecret({}, schema, ['global']);
		expect(result.regular.hidden).toBeUndefined();
	});

	it('should not overwrite existing values with defaults', () => {
		const schema = makeSchema();
		const result = splitSettingsBySecret({ model: 'claude-3' }, schema, ['global', 'user']);
		expect(result.regular.model).toBe('claude-3');
	});

	it('should handle undefined schema gracefully', () => {
		const result = splitSettingsBySecret({ foo: 'bar' }, undefined, ['global']);
		expect(result.regular).toEqual({ foo: 'bar' });
		expect(result.secret).toEqual({});
	});
});

describe('getVisibleProperties', () => {
	it('should return properties matching the given scopes', () => {
		const schema = makeSchema();
		const result = getVisibleProperties(schema, ['user']);
		expect(Object.keys(result)).toEqual(['apiKey', 'model']);
	});

	it('should exclude hidden properties', () => {
		const schema = makeSchema();
		const result = getVisibleProperties(schema, ['global']);
		expect(result.internalFlag).toBeUndefined();
		expect(result.globalSetting).toBeDefined();
	});

	it('should return empty object for undefined schema', () => {
		expect(getVisibleProperties(undefined, ['global'])).toEqual({});
	});

	it('should return all scoped properties when multiple scopes given', () => {
		const schema = makeSchema();
		const result = getVisibleProperties(schema, ['global', 'user', 'directory']);
		expect(Object.keys(result)).toEqual(['apiKey', 'model', 'temperature', 'globalSetting']);
	});
});

describe('getRequiredFields', () => {
	it('should return required fields matching the given scopes', () => {
		const schema = makeSchema();
		const result = getRequiredFields(schema, ['user']);
		expect(result).toEqual(['apiKey', 'model']);
	});

	it('should exclude required fields not in scope', () => {
		const schema = makeSchema();
		const result = getRequiredFields(schema, ['directory']);
		expect(result).toEqual([]);
	});

	it('should return empty array for undefined schema', () => {
		expect(getRequiredFields(undefined, ['global'])).toEqual([]);
	});

	it('should handle schema with no required fields', () => {
		const schema = makeSchema({ required: undefined });
		expect(getRequiredFields(schema, ['user'])).toEqual([]);
	});
});

describe('validateRequiredSettings', () => {
	it('should return empty array when all required fields have values', () => {
		const schema = makeSchema();
		const errors = validateRequiredSettings({ model: 'gpt-4' }, { apiKey: 'sk-123' }, schema, ['user'], 'user');
		expect(errors).toEqual([]);
	});

	it('should return labels for missing required fields', () => {
		const schema = makeSchema();
		const errors = validateRequiredSettings({}, {}, schema, ['user'], 'user');
		expect(errors).toEqual(['API Key', 'Model']);
	});

	it('should allow inheritance from fallbackSettings at directory scope', () => {
		const schema: PluginSettingsSchema = {
			type: 'object',
			properties: {
				apiKey: { type: 'string', title: 'API Key', secret: true, scope: 'user' }
			},
			required: ['apiKey']
		};
		const errors = validateRequiredSettings({}, {}, schema, ['user'], 'directory', { apiKey: 'inherited-key' });
		expect(errors).toEqual([]);
	});

	it('should not allow inheritance at user scope', () => {
		const schema: PluginSettingsSchema = {
			type: 'object',
			properties: {
				apiKey: { type: 'string', title: 'API Key', scope: 'user' }
			},
			required: ['apiKey']
		};
		const errors = validateRequiredSettings({}, {}, schema, ['user'], 'user', { apiKey: 'inherited-key' });
		expect(errors).toEqual(['API Key']);
	});

	it('should validate requiredGroups', () => {
		const schema: PluginSettingsSchema = {
			type: 'object',
			properties: {
				keyA: { type: 'string', title: 'Key A', scope: 'user' },
				keyB: { type: 'string', title: 'Key B', scope: 'user' }
			},
			requiredGroups: [{ fields: ['keyA', 'keyB'], message: 'Provide at least one key' }]
		};
		const errors = validateRequiredSettings({}, {}, schema, ['user'], 'user');
		expect(errors).toEqual(['Provide at least one key']);
	});

	it('should pass requiredGroups when at least one field has value', () => {
		const schema: PluginSettingsSchema = {
			type: 'object',
			properties: {
				keyA: { type: 'string', title: 'Key A', scope: 'user' },
				keyB: { type: 'string', title: 'Key B', scope: 'user' }
			},
			requiredGroups: [{ fields: ['keyA', 'keyB'] }]
		};
		const errors = validateRequiredSettings({ keyA: 'value' }, {}, schema, ['user'], 'user');
		expect(errors).toEqual([]);
	});

	it('should generate default message for groups without message', () => {
		const schema: PluginSettingsSchema = {
			type: 'object',
			properties: {
				keyA: { type: 'string', title: 'Key A', scope: 'user' },
				keyB: { type: 'string', title: 'Key B', scope: 'user' }
			},
			requiredGroups: [{ fields: ['keyA', 'keyB'] }]
		};
		const errors = validateRequiredSettings({}, {}, schema, ['user'], 'user');
		expect(errors).toEqual(['At least one of: Key A, Key B']);
	});
});

describe('sanitizeSettingsForSave', () => {
	it('should convert undefined to null', () => {
		const result = sanitizeSettingsForSave({ foo: undefined, bar: 'value' }, 'user');
		expect(result).toEqual({ foo: null, bar: 'value' });
	});

	it('should convert empty string to null at directory scope', () => {
		const result = sanitizeSettingsForSave({ foo: '', bar: 'value' }, 'directory');
		expect(result).toEqual({ foo: null, bar: 'value' });
	});

	it('should keep empty string at user scope', () => {
		const result = sanitizeSettingsForSave({ foo: '' }, 'user');
		expect(result).toEqual({ foo: '' });
	});

	it('should pass through normal values unchanged', () => {
		const result = sanitizeSettingsForSave({ str: 'hello', num: 42, bool: true }, 'user');
		expect(result).toEqual({ str: 'hello', num: 42, bool: true });
	});

	it('should strip masked placeholder values containing ••••', () => {
		const result = sanitizeSettingsForSave({ apiKey: '••••••••', model: 'gpt-4', baseUrl: 'sk-o••••1234' }, 'user');
		expect(result).toEqual({ model: 'gpt-4' });
	});

	it('should strip masked values at directory scope too', () => {
		const result = sanitizeSettingsForSave({ secretField: '••••••••', normalField: 'value' }, 'directory');
		expect(result).toEqual({ normalField: 'value' });
	});
});

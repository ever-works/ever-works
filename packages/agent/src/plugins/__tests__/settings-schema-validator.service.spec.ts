import { Test, TestingModule } from '@nestjs/testing';
import {
    SettingsSchemaValidatorService,
    SettingsScope,
} from '../services/settings-schema-validator.service';
import type { JsonSchema } from '@ever-works/plugin';

describe('SettingsSchemaValidatorService', () => {
    let service: SettingsSchemaValidatorService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [SettingsSchemaValidatorService],
        }).compile();

        service = module.get<SettingsSchemaValidatorService>(SettingsSchemaValidatorService);
    });

    afterEach(() => {
        service.clearCache();
    });

    describe('validateSettings', () => {
        it('should return valid for empty settings when no schema', () => {
            const result = service.validateSettings({}, undefined, 'user');
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it('should validate string type correctly', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    apiKey: { type: 'string' },
                },
            };

            const validResult = service.validateSettings({ apiKey: 'test-key' }, schema, 'global');
            expect(validResult.valid).toBe(true);

            const invalidResult = service.validateSettings({ apiKey: 123 }, schema, 'global');
            expect(invalidResult.valid).toBe(false);
            expect(invalidResult.errors.length).toBeGreaterThan(0);
        });

        it('should validate number type correctly', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    maxItems: { type: 'number' },
                },
            };

            const validResult = service.validateSettings({ maxItems: 10 }, schema, 'global');
            expect(validResult.valid).toBe(true);

            const invalidResult = service.validateSettings({ maxItems: 'ten' }, schema, 'global');
            expect(invalidResult.valid).toBe(false);
        });

        it('should validate boolean type correctly', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    enabled: { type: 'boolean' },
                },
            };

            const validResult = service.validateSettings({ enabled: true }, schema, 'global');
            expect(validResult.valid).toBe(true);

            const invalidResult = service.validateSettings({ enabled: 'true' }, schema, 'global');
            expect(invalidResult.valid).toBe(false);
        });

        it('should validate enum values', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    theme: { type: 'string', enum: ['light', 'dark', 'auto'] },
                },
            };

            const validResult = service.validateSettings({ theme: 'dark' }, schema, 'global');
            expect(validResult.valid).toBe(true);

            const invalidResult = service.validateSettings({ theme: 'blue' }, schema, 'global');
            expect(invalidResult.valid).toBe(false);
        });

        it('should filter properties by scope', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    globalSetting: { type: 'string', 'x-scope': 'global' },
                    userSetting: { type: 'string', 'x-scope': 'user' },
                    directorySetting: { type: 'string', 'x-scope': 'directory' },
                },
            };

            // At global scope, only global settings should be validated
            const globalResult = service.validateSettings(
                {
                    globalSetting: 'value',
                    userSetting: 123, // Wrong type but should be ignored at global scope
                },
                schema,
                'global',
            );
            expect(globalResult.valid).toBe(true);

            // At user scope, global and user settings should be validated
            const userResult = service.validateSettings(
                {
                    globalSetting: 'value',
                    userSetting: 123, // Wrong type
                },
                schema,
                'user',
            );
            expect(userResult.valid).toBe(false);

            // At directory scope, only global and directory settings should be validated
            const directoryResult = service.validateSettings(
                {
                    globalSetting: 'value',
                    userSetting: 123, // Wrong type but should be ignored at directory scope
                    directorySetting: 123, // Wrong type - should be caught
                },
                schema,
                'directory',
            );
            expect(directoryResult.valid).toBe(false);

            // At directory scope, user-scoped wrong types are ignored
            const directoryValidResult = service.validateSettings(
                {
                    globalSetting: 'value',
                    userSetting: 123, // Wrong type but ignored at directory scope
                    directorySetting: 'value',
                },
                schema,
                'directory',
            );
            expect(directoryValidResult.valid).toBe(true);
        });
    });

    describe('validateRequiredFields', () => {
        it('should return valid when all required fields are present', () => {
            const schema: JsonSchema = {
                type: 'object',
                required: ['apiKey'],
                properties: {
                    apiKey: { type: 'string' },
                },
            };

            const result = service.validateRequiredFields({ apiKey: 'test' }, schema, 'global');
            expect(result.valid).toBe(true);
        });

        it('should return invalid when required field is missing', () => {
            const schema: JsonSchema = {
                type: 'object',
                required: ['apiKey'],
                properties: {
                    apiKey: { type: 'string' },
                },
            };

            const result = service.validateRequiredFields({}, schema, 'global');
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Missing required fields: apiKey');
        });

        it('should return invalid when required field is empty string', () => {
            const schema: JsonSchema = {
                type: 'object',
                required: ['apiKey'],
                properties: {
                    apiKey: { type: 'string' },
                },
            };

            const result = service.validateRequiredFields({ apiKey: '' }, schema, 'global');
            expect(result.valid).toBe(false);
        });

        it('should not require user-scoped fields when validating at directory scope', () => {
            const schema: JsonSchema = {
                type: 'object',
                required: ['apiKey', 'defaultModel'],
                properties: {
                    apiKey: { type: 'string', 'x-scope': 'user' },
                    defaultModel: { type: 'string', 'x-scope': 'global' },
                },
            };

            // At directory scope, only global+directory fields required — apiKey is user-scoped
            const result = service.validateRequiredFields(
                { defaultModel: 'gemini-2.5-flash' },
                schema,
                'directory',
            );
            expect(result.valid).toBe(true);
        });

        it('should require user-scoped fields when validating at user scope', () => {
            const schema: JsonSchema = {
                type: 'object',
                required: ['apiKey'],
                properties: {
                    apiKey: { type: 'string', 'x-scope': 'user' },
                },
            };

            const result = service.validateRequiredFields({}, schema, 'user');
            expect(result.valid).toBe(false);
        });

        it('should only check required fields for the given scope', () => {
            const schema: JsonSchema = {
                type: 'object',
                required: ['globalField', 'directoryField'],
                properties: {
                    globalField: { type: 'string', 'x-scope': 'global' },
                    directoryField: { type: 'string', 'x-scope': 'directory' },
                },
            };

            // At global scope, only globalField should be required
            const result = service.validateRequiredFields(
                { globalField: 'value' },
                schema,
                'global',
            );
            expect(result.valid).toBe(true);

            // At directory scope, both should be required
            const directoryResult = service.validateRequiredFields(
                { globalField: 'value' },
                schema,
                'directory',
            );
            expect(directoryResult.valid).toBe(false);
        });
    });

    describe('validateRequiredFields with x-requiredGroups', () => {
        it('should pass when at least one field in the group is set', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    oauthToken: { type: 'string' },
                    apiKey: { type: 'string' },
                },
                'x-requiredGroups': [
                    { fields: ['oauthToken', 'apiKey'], message: 'Need one credential' },
                ],
            };

            const result = service.validateRequiredFields(
                { oauthToken: '', apiKey: 'sk-123' },
                schema,
                'global',
            );
            expect(result.valid).toBe(true);
        });

        it('should fail when no field in the group is set', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    oauthToken: { type: 'string' },
                    apiKey: { type: 'string' },
                },
                'x-requiredGroups': [
                    { fields: ['oauthToken', 'apiKey'], message: 'Need one credential' },
                ],
            };

            const result = service.validateRequiredFields(
                { oauthToken: '', apiKey: '' },
                schema,
                'global',
            );
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Need one credential');
        });

        it('should use default message when no custom message provided', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    fieldA: { type: 'string' },
                    fieldB: { type: 'string' },
                },
                'x-requiredGroups': [{ fields: ['fieldA', 'fieldB'] }],
            };

            const result = service.validateRequiredFields({}, schema, 'global');
            expect(result.valid).toBe(false);
            expect(result.errors[0]).toBe('At least one of [fieldA, fieldB] is required');
        });

        it('should validate multiple groups independently', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    oauthToken: { type: 'string' },
                    apiKey: { type: 'string' },
                    webhookUrl: { type: 'string' },
                    pollingEnabled: { type: 'string' },
                },
                'x-requiredGroups': [
                    { fields: ['oauthToken', 'apiKey'], message: 'Need auth' },
                    { fields: ['webhookUrl', 'pollingEnabled'], message: 'Need delivery method' },
                ],
            };

            const result = service.validateRequiredFields({ apiKey: 'sk-123' }, schema, 'global');
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Need delivery method');
            expect(result.errors).not.toContain('Need auth');
        });

        it('should include user-scoped group fields at directory scope (inherited values)', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    oauthToken: { type: 'string', 'x-scope': 'user' },
                    apiKey: { type: 'string', 'x-scope': 'user' },
                },
                'x-requiredGroups': [
                    { fields: ['oauthToken', 'apiKey'], message: 'Need credential' },
                ],
            };

            // At directory scope with empty settings, user-scoped fields are now
            // included (merged settings would carry inherited user values).
            // Empty settings → group fails.
            const result = service.validateRequiredFields({}, schema, 'directory');
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Need credential');
        });

        it('should pass group at directory scope when user-scoped field has inherited value', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    oauthToken: { type: 'string', 'x-scope': 'user' },
                    apiKey: { type: 'string' },
                },
                'x-requiredGroups': [
                    { fields: ['oauthToken', 'apiKey'], message: 'Need credential' },
                ],
            };

            // At directory scope, merged settings include inherited user oauthToken
            const result = service.validateRequiredFields(
                { oauthToken: 'inherited-token' },
                schema,
                'directory',
            );
            expect(result.valid).toBe(true);
        });

        it('should fail group at directory scope when user-scoped and global fields are both empty', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    oauthToken: { type: 'string', 'x-scope': 'user' },
                    apiKey: { type: 'string' },
                },
                'x-requiredGroups': [
                    { fields: ['oauthToken', 'apiKey'], message: 'Need credential' },
                ],
            };

            const result = service.validateRequiredFields({}, schema, 'directory');
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Need credential');
        });

        it('should enforce group at matching scope', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    oauthToken: { type: 'string', 'x-scope': 'user' },
                    apiKey: { type: 'string', 'x-scope': 'user' },
                },
                'x-requiredGroups': [
                    { fields: ['oauthToken', 'apiKey'], message: 'Need credential' },
                ],
            };

            const result = service.validateRequiredFields({}, schema, 'user');
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Need credential');
        });
    });

    describe('validate', () => {
        it('should validate both required fields and schema', () => {
            const schema: JsonSchema = {
                type: 'object',
                required: ['apiKey'],
                properties: {
                    apiKey: { type: 'string' },
                    maxItems: { type: 'number' },
                },
            };

            // Valid settings
            const validResult = service.validate(
                { apiKey: 'test', maxItems: 10 },
                schema,
                'global',
            );
            expect(validResult.valid).toBe(true);

            // Missing required field
            const missingResult = service.validate({ maxItems: 10 }, schema, 'global');
            expect(missingResult.valid).toBe(false);

            // Wrong type
            const wrongTypeResult = service.validate(
                { apiKey: 'test', maxItems: 'ten' },
                schema,
                'global',
            );
            expect(wrongTypeResult.valid).toBe(false);
        });
    });

    describe('format validation', () => {
        it('should validate email format', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    email: { type: 'string', format: 'email' },
                },
            };

            const validResult = service.validateSettings(
                { email: 'test@example.com' },
                schema,
                'global',
            );
            expect(validResult.valid).toBe(true);

            const invalidResult = service.validateSettings(
                { email: 'not-an-email' },
                schema,
                'global',
            );
            expect(invalidResult.valid).toBe(false);
        });

        it('should validate uri format', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    website: { type: 'string', format: 'uri' },
                },
            };

            const validResult = service.validateSettings(
                { website: 'https://example.com' },
                schema,
                'global',
            );
            expect(validResult.valid).toBe(true);

            const invalidResult = service.validateSettings(
                { website: 'not-a-url' },
                schema,
                'global',
            );
            expect(invalidResult.valid).toBe(false);
        });
    });

    describe('minLength/maxLength validation', () => {
        it('should validate string length constraints', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    password: { type: 'string', minLength: 8, maxLength: 20 },
                },
            };

            const validResult = service.validateSettings(
                { password: 'validpass123' },
                schema,
                'global',
            );
            expect(validResult.valid).toBe(true);

            const tooShortResult = service.validateSettings(
                { password: 'short' },
                schema,
                'global',
            );
            expect(tooShortResult.valid).toBe(false);

            const tooLongResult = service.validateSettings(
                { password: 'this-password-is-way-too-long' },
                schema,
                'global',
            );
            expect(tooLongResult.valid).toBe(false);
        });
    });

    describe('minimum/maximum validation', () => {
        it('should validate number range constraints', () => {
            const schema: JsonSchema = {
                type: 'object',
                properties: {
                    age: { type: 'number', minimum: 0, maximum: 120 },
                },
            };

            const validResult = service.validateSettings({ age: 25 }, schema, 'global');
            expect(validResult.valid).toBe(true);

            const tooLowResult = service.validateSettings({ age: -5 }, schema, 'global');
            expect(tooLowResult.valid).toBe(false);

            const tooHighResult = service.validateSettings({ age: 150 }, schema, 'global');
            expect(tooHighResult.valid).toBe(false);
        });
    });
});

import { ConfigService } from '@nestjs/config';
import { CrmConfigService } from './crm-config.service';

type ConfigShape = Record<string, unknown>;

const mockConfigService = (values: ConfigShape): ConfigService => {
    return {
        get: <T>(key: string, defaultValue?: T) => {
            if (key in values) return values[key] as T;
            return defaultValue as T;
        },
    } as unknown as ConfigService;
};

describe('CrmConfigService', () => {
    describe('twentyCrmConfig', () => {
        it('reads all six environment values from ConfigService and uses defaults for timeout / retry attempts / retry delay', () => {
            const service = new CrmConfigService(
                mockConfigService({
                    TWENTY_CRM_BASE_URL: 'https://crm.example.com',
                    TWENTY_CRM_API_KEY: 'secret',
                    TWENTY_CRM_WORKSPACE_ID: 'ws-1',
                }),
            );

            expect(service.twentyCrmConfig).toEqual({
                apiUrl: 'https://crm.example.com',
                apiKey: 'secret',
                workspaceId: 'ws-1',
                timeout: 30000,
                retryAttempts: 3,
                retryDelay: 1000,
            });
        });

        it('honors explicit timeout / retryAttempts / retryDelay values when supplied', () => {
            const service = new CrmConfigService(
                mockConfigService({
                    TWENTY_CRM_BASE_URL: 'https://crm.example.com',
                    TWENTY_CRM_API_KEY: 'secret',
                    TWENTY_CRM_WORKSPACE_ID: 'ws-1',
                    TWENTY_CRM_TIMEOUT_MS: 7500,
                    TWENTY_CRM_MAX_RETRIES: 5,
                    TWENTY_CRM_RETRY_DELAY_MS: 250,
                }),
            );

            expect(service.twentyCrmConfig.timeout).toBe(7500);
            expect(service.twentyCrmConfig.retryAttempts).toBe(5);
            expect(service.twentyCrmConfig.retryDelay).toBe(250);
        });

        it('returns undefined for unset required keys (does not throw at read time)', () => {
            const service = new CrmConfigService(mockConfigService({}));
            expect(service.twentyCrmConfig.apiUrl).toBeUndefined();
            expect(service.twentyCrmConfig.apiKey).toBeUndefined();
            expect(service.twentyCrmConfig.workspaceId).toBeUndefined();
        });
    });

    describe('isEnabled', () => {
        it('is true only when apiUrl + apiKey + workspaceId are all set', () => {
            const service = new CrmConfigService(
                mockConfigService({
                    TWENTY_CRM_BASE_URL: 'https://crm.example.com',
                    TWENTY_CRM_API_KEY: 'k',
                    TWENTY_CRM_WORKSPACE_ID: 'ws',
                }),
            );

            expect(service.isEnabled).toBe(true);
        });

        it('is false when apiUrl is missing', () => {
            const service = new CrmConfigService(
                mockConfigService({
                    TWENTY_CRM_API_KEY: 'k',
                    TWENTY_CRM_WORKSPACE_ID: 'ws',
                }),
            );
            expect(service.isEnabled).toBe(false);
        });

        it('is false when apiKey is missing', () => {
            const service = new CrmConfigService(
                mockConfigService({
                    TWENTY_CRM_BASE_URL: 'u',
                    TWENTY_CRM_WORKSPACE_ID: 'ws',
                }),
            );
            expect(service.isEnabled).toBe(false);
        });

        it('is false when workspaceId is missing', () => {
            const service = new CrmConfigService(
                mockConfigService({
                    TWENTY_CRM_BASE_URL: 'u',
                    TWENTY_CRM_API_KEY: 'k',
                }),
            );
            expect(service.isEnabled).toBe(false);
        });

        it('coerces empty-string values to a falsy `isEnabled`', () => {
            const service = new CrmConfigService(
                mockConfigService({
                    TWENTY_CRM_BASE_URL: '',
                    TWENTY_CRM_API_KEY: '',
                    TWENTY_CRM_WORKSPACE_ID: '',
                }),
            );
            expect(service.isEnabled).toBe(false);
        });
    });

    describe('validateConfig', () => {
        it('returns true when every required key is present', () => {
            const service = new CrmConfigService(
                mockConfigService({
                    TWENTY_CRM_BASE_URL: 'u',
                    TWENTY_CRM_API_KEY: 'k',
                    TWENTY_CRM_WORKSPACE_ID: 'ws',
                }),
            );
            expect(service.validateConfig()).toBe(true);
        });

        it('lists every missing key in the error message', () => {
            const service = new CrmConfigService(mockConfigService({}));
            expect(() => service.validateConfig()).toThrow(
                'Missing required Twenty CRM configuration: TWENTY_CRM_BASE_URL, TWENTY_CRM_API_KEY, TWENTY_CRM_WORKSPACE_ID',
            );
        });

        it('lists only the keys that are actually missing', () => {
            const service = new CrmConfigService(
                mockConfigService({
                    TWENTY_CRM_BASE_URL: 'u',
                }),
            );
            expect(() => service.validateConfig()).toThrow(
                'Missing required Twenty CRM configuration: TWENTY_CRM_API_KEY, TWENTY_CRM_WORKSPACE_ID',
            );
        });
    });

    describe('configForTenant (per-tenant workspace credentials)', () => {
        const baseEnv = {
            TWENTY_CRM_BASE_URL: 'https://crm.example.com',
            TWENTY_CRM_API_KEY: 'default-key',
            TWENTY_CRM_WORKSPACE_ID: 'default-ws',
        };

        it('returns the default config when no tenantId is given (internal/system callers)', () => {
            const service = new CrmConfigService(mockConfigService(baseEnv));
            expect(service.configForTenant()).toMatchObject({
                apiKey: 'default-key',
                workspaceId: 'default-ws',
            });
        });

        it('falls back to the default config when the tenant has no entry', () => {
            const service = new CrmConfigService(
                mockConfigService({
                    ...baseEnv,
                    TWENTY_CRM_TENANTS: JSON.stringify({ 'other-tenant': { apiKey: 'x' } }),
                }),
            );
            expect(service.configForTenant('tenant-1')).toMatchObject({
                apiKey: 'default-key',
                workspaceId: 'default-ws',
            });
        });

        it("uses the tenant's OWN workspace credentials when an entry exists", () => {
            const service = new CrmConfigService(
                mockConfigService({
                    ...baseEnv,
                    TWENTY_CRM_TENANTS: JSON.stringify({
                        'tenant-1': {
                            apiKey: 't1-key',
                            workspaceId: 't1-ws',
                            apiUrl: 'https://t1.example.com',
                        },
                    }),
                }),
            );
            expect(service.configForTenant('tenant-1')).toMatchObject({
                apiUrl: 'https://t1.example.com',
                apiKey: 't1-key',
                workspaceId: 't1-ws',
            });
        });

        it('inherits base fields the override omits, and isolates two tenants from each other', () => {
            const service = new CrmConfigService(
                mockConfigService({
                    ...baseEnv,
                    TWENTY_CRM_TENANTS: JSON.stringify({
                        'tenant-a': { apiKey: 'a-key' },
                        'tenant-b': { apiKey: 'b-key', workspaceId: 'b-ws' },
                    }),
                }),
            );

            const a = service.configForTenant('tenant-a');
            const b = service.configForTenant('tenant-b');

            // tenant-a inherits the default workspace; tenant-b overrides it.
            expect(a).toMatchObject({ apiKey: 'a-key', workspaceId: 'default-ws' });
            expect(b).toMatchObject({ apiKey: 'b-key', workspaceId: 'b-ws' });
            expect(a.apiKey).not.toBe(b.apiKey);
        });

        it('ignores a malformed TWENTY_CRM_TENANTS JSON value and falls back to the default', () => {
            const service = new CrmConfigService(
                mockConfigService({ ...baseEnv, TWENTY_CRM_TENANTS: '{not json' }),
            );
            jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
            expect(service.configForTenant('tenant-1')).toMatchObject({ apiKey: 'default-key' });
        });
    });
});

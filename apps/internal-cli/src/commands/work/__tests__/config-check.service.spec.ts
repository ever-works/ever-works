import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@ever-works/cli-shared', () => ({
    displayConfigurationError: vi.fn(),
}));

import { displayConfigurationError } from '@ever-works/cli-shared';
import { ConfigCheckService } from '../config-check.service';

const m = (fn: any) => fn as ReturnType<typeof vi.fn>;

interface ConfigStub {
    loadConfig: ReturnType<typeof vi.fn>;
    validateConfig: ReturnType<typeof vi.fn>;
}

function makeStub(overrides?: Partial<ConfigStub>): ConfigStub {
    return {
        loadConfig: vi.fn(),
        validateConfig: vi.fn(),
        ...overrides,
    };
}

describe('ConfigCheckService', () => {
    let stub: ConfigStub;
    let service: ConfigCheckService;

    beforeEach(() => {
        vi.clearAllMocks();
        stub = makeStub();
        // The service expects a ConfigService — its only methods used are
        // `loadConfig` and `validateConfig`, so a stub is sufficient.
        service = new ConfigCheckService(stub as unknown as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('checkConfiguration', () => {
        it('returns false and reports "No configuration found" when loadConfig returns null', async () => {
            stub.loadConfig.mockResolvedValue(null);
            await expect(service.checkConfiguration()).resolves.toBe(false);
            expect(displayConfigurationError).toHaveBeenCalledWith('No configuration found');
            expect(stub.validateConfig).not.toHaveBeenCalled();
        });

        it('returns false with validation errors when validateConfig fails', async () => {
            const cfg = { GIT_TOKEN: 't' };
            stub.loadConfig.mockResolvedValue(cfg);
            stub.validateConfig.mockReturnValue({
                isValid: false,
                errors: ['GIT_OWNER is required'],
                warnings: [],
            });

            await expect(service.checkConfiguration()).resolves.toBe(false);
            expect(stub.validateConfig).toHaveBeenCalledWith(cfg);
            expect(displayConfigurationError).toHaveBeenCalledWith(
                'Configuration validation failed',
                ['GIT_OWNER is required'],
            );
        });

        it('returns true when validateConfig.isValid===true', async () => {
            stub.loadConfig.mockResolvedValue({ GIT_TOKEN: 't' });
            stub.validateConfig.mockReturnValue({ isValid: true, errors: [], warnings: [] });

            await expect(service.checkConfiguration()).resolves.toBe(true);
            expect(displayConfigurationError).not.toHaveBeenCalled();
        });

        it('returns false and reports the wrapped error when loadConfig throws', async () => {
            stub.loadConfig.mockRejectedValue(new Error('disk error'));
            await expect(service.checkConfiguration()).resolves.toBe(false);
            expect(displayConfigurationError).toHaveBeenCalledWith(
                'Failed to load configuration',
                ['disk error'],
            );
        });
    });

    describe('requireConfiguration', () => {
        it('does NOT exit when checkConfiguration returns true', async () => {
            const exitSpy = vi
                .spyOn(process, 'exit')
                .mockImplementation((() => undefined as never) as typeof process.exit);
            stub.loadConfig.mockResolvedValue({ GIT_TOKEN: 't' });
            stub.validateConfig.mockReturnValue({ isValid: true, errors: [], warnings: [] });

            await service.requireConfiguration();
            expect(exitSpy).not.toHaveBeenCalled();
            exitSpy.mockRestore();
        });

        it('calls process.exit(1) when checkConfiguration returns false', async () => {
            const exitSpy = vi
                .spyOn(process, 'exit')
                .mockImplementation((() => undefined as never) as typeof process.exit);
            stub.loadConfig.mockResolvedValue(null);

            await service.requireConfiguration();
            expect(exitSpy).toHaveBeenCalledWith(1);
            exitSpy.mockRestore();
        });
    });
});

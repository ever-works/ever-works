import type { ExecutionContext } from '@nestjs/common';
import { CrmSyncGuard } from './crm-sync.guard';
import type { CrmConfigService } from '../config/crm-config.service';

describe('CrmSyncGuard', () => {
    const stubExecutionContext = {} as ExecutionContext;

    it('returns false (and warns) when CRM integration is disabled', () => {
        const config = {
            isEnabled: false,
            validateConfig: jest.fn(),
        } as unknown as CrmConfigService;
        const guard = new CrmSyncGuard(config);
        // Silence the Logger to keep the test output clean — we only assert
        // on the boolean return.
        const warn = jest.spyOn((guard as any).logger, 'warn').mockImplementation(() => undefined);

        expect(guard.canActivate(stubExecutionContext)).toBe(false);
        expect(config.validateConfig as jest.Mock).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith('CRM integration is disabled - request blocked');
    });

    it('returns true when isEnabled is true and validateConfig succeeds', () => {
        const config = {
            isEnabled: true,
            validateConfig: jest.fn().mockReturnValue(true),
        } as unknown as CrmConfigService;
        const guard = new CrmSyncGuard(config);

        expect(guard.canActivate(stubExecutionContext)).toBe(true);
        expect(config.validateConfig as jest.Mock).toHaveBeenCalledTimes(1);
    });

    it('returns false (and logs error) when validateConfig throws', () => {
        const err = new Error('Missing TWENTY_CRM_API_KEY');
        const config = {
            isEnabled: true,
            validateConfig: jest.fn().mockImplementation(() => {
                throw err;
            }),
        } as unknown as CrmConfigService;
        const guard = new CrmSyncGuard(config);
        const errorSpy = jest
            .spyOn((guard as any).logger, 'error')
            .mockImplementation(() => undefined);

        expect(guard.canActivate(stubExecutionContext)).toBe(false);
        expect(errorSpy).toHaveBeenCalledWith('CRM configuration validation failed:', err);
    });
});

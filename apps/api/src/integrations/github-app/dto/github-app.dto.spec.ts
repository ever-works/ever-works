import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { GitHubAppCallbackQueryDto, GitHubAppSetupQueryDto } from './github-app.dto';

const constraintsFor = (
    errs: { property: string; constraints?: Record<string, string> }[],
    property: string,
) => errs.find((e) => e.property === property)?.constraints ?? {};

describe('GitHubAppSetupQueryDto', () => {
    it('accepts an installation_id-only payload', async () => {
        const dto = plainToInstance(GitHubAppSetupQueryDto, { installation_id: '123' });
        expect(await validate(dto)).toHaveLength(0);
    });

    it('accepts an installation_id + setup_action="install"', async () => {
        const dto = plainToInstance(GitHubAppSetupQueryDto, {
            installation_id: '123',
            setup_action: 'install',
        });
        expect(await validate(dto)).toHaveLength(0);
    });

    it('accepts an installation_id + setup_action="request"', async () => {
        const dto = plainToInstance(GitHubAppSetupQueryDto, {
            installation_id: '123',
            setup_action: 'request',
        });
        expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects an unknown setup_action via @IsIn', async () => {
        const dto = plainToInstance(GitHubAppSetupQueryDto, {
            installation_id: '123',
            setup_action: 'uninstall',
        });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'setup_action').isIn).toBeDefined();
    });

    it('rejects uppercase setup_action — @IsIn is case-sensitive', async () => {
        const dto = plainToInstance(GitHubAppSetupQueryDto, {
            installation_id: '123',
            setup_action: 'INSTALL',
        });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'setup_action').isIn).toBeDefined();
    });

    it('rejects non-string installation_id via @IsString', async () => {
        const dto = plainToInstance(GitHubAppSetupQueryDto, {
            installation_id: 123 as unknown as string,
        });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'installation_id').isString).toBeDefined();
    });

    it('rejects missing installation_id via @IsString (undefined fails IsString)', async () => {
        const dto = plainToInstance(GitHubAppSetupQueryDto, {});
        const errs = await validate(dto);
        expect(errs.find((e) => e.property === 'installation_id')).toBeDefined();
    });

    it('does NOT enforce @IsNotEmpty on installation_id (empty string accepted)', async () => {
        // Pinned: only @IsString runs at the DTO layer. The controller's `setupAction`
        // path is responsible for surfacing missing/invalid installation IDs as a
        // `BadRequest('GitHub App installation could not be persisted')` downstream.
        const dto = plainToInstance(GitHubAppSetupQueryDto, { installation_id: '' });
        expect(await validate(dto)).toHaveLength(0);
    });

    it('accepts a redirectTo string', async () => {
        const dto = plainToInstance(GitHubAppSetupQueryDto, {
            installation_id: '123',
            redirectTo: '/dashboard',
        });
        expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects non-string redirectTo via @IsString', async () => {
        const dto = plainToInstance(GitHubAppSetupQueryDto, {
            installation_id: '123',
            redirectTo: 42 as unknown as string,
        });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'redirectTo').isString).toBeDefined();
    });
});

describe('GitHubAppCallbackQueryDto', () => {
    it('accepts a valid code + state pair', async () => {
        const dto = plainToInstance(GitHubAppCallbackQueryDto, {
            code: 'oauth-code-1',
            state: 'state-token-1',
        });
        expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects non-string code via @IsString', async () => {
        const dto = plainToInstance(GitHubAppCallbackQueryDto, {
            code: 42 as unknown as string,
            state: 'state-token-1',
        });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'code').isString).toBeDefined();
    });

    it('rejects missing code via @IsString (undefined fails)', async () => {
        const dto = plainToInstance(GitHubAppCallbackQueryDto, {
            state: 'state-token-1',
        });
        const errs = await validate(dto);
        expect(errs.find((e) => e.property === 'code')).toBeDefined();
    });

    it('rejects non-string state via @IsString', async () => {
        const dto = plainToInstance(GitHubAppCallbackQueryDto, {
            code: 'oauth-code-1',
            state: 42 as unknown as string,
        });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'state').isString).toBeDefined();
    });

    it('rejects missing state via @IsString (undefined fails)', async () => {
        // Pinned: state is REQUIRED (not @IsOptional()). The HMAC verification path in
        // GitHubAppOnboardingService relies on every callback carrying a state token —
        // a future @IsOptional() addition would silently bypass CSRF protection.
        const dto = plainToInstance(GitHubAppCallbackQueryDto, {
            code: 'oauth-code-1',
        });
        const errs = await validate(dto);
        expect(errs.find((e) => e.property === 'state')).toBeDefined();
    });

    it('does NOT enforce @IsNotEmpty on either field — empty strings accepted', async () => {
        // Pinned: only @IsString runs. Empty strings flow through to the handler which
        // surfaces them as `Unauthorized('OAuth code missing')` / `Unauthorized('Invalid state')`
        // downstream. A DTO-layer @IsNotEmpty would convert those into 400s instead of 401s,
        // changing the public error contract.
        const dto = plainToInstance(GitHubAppCallbackQueryDto, { code: '', state: '' });
        expect(await validate(dto)).toHaveLength(0);
    });
});

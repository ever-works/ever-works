import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { GitHubAppWebhookController } from './github-app-webhook.controller';

jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({}));
jest.mock('@ever-works/agent/import', () => ({}));
jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@src/auth/decorators/public.decorator', () => ({
    Public: () => () => undefined,
}));

describe('GitHubAppWebhookController', () => {
    function createController() {
        const gitHubAppService = {
            verifyWebhookSignature: jest.fn(),
        };
        const gitHubAppSyncService = {
            handleWebhook: jest.fn(),
        };
        const controller = new GitHubAppWebhookController(
            gitHubAppService as any,
            gitHubAppSyncService as any,
        );
        return { controller, gitHubAppService, gitHubAppSyncService };
    }

    function makeReq(rawBody?: string, body: any = { foo: 'bar' }) {
        return { body, rawBody };
    }

    describe('handleWebhook (POST /api/github-app/webhooks)', () => {
        it('throws BadRequestException when x-github-event header is missing', async () => {
            const { controller, gitHubAppService, gitHubAppSyncService } = createController();
            await expect(
                controller.handleWebhook(makeReq('raw') as any, 'sig', undefined),
            ).rejects.toThrow(BadRequestException);
            await expect(
                controller.handleWebhook(makeReq('raw') as any, 'sig', undefined),
            ).rejects.toThrow('Missing GitHub event header');
            // Should not even attempt signature verification or dispatch.
            expect(gitHubAppService.verifyWebhookSignature).not.toHaveBeenCalled();
            expect(gitHubAppSyncService.handleWebhook).not.toHaveBeenCalled();
        });

        it('throws BadRequestException when raw body is missing (empty string is also missing)', async () => {
            const { controller, gitHubAppService, gitHubAppSyncService } = createController();
            await expect(
                controller.handleWebhook(makeReq(undefined) as any, 'sig', 'push'),
            ).rejects.toThrow('Missing raw webhook payload');
            await expect(
                controller.handleWebhook(makeReq('') as any, 'sig', 'push'),
            ).rejects.toThrow('Missing raw webhook payload');
            expect(gitHubAppService.verifyWebhookSignature).not.toHaveBeenCalled();
            expect(gitHubAppSyncService.handleWebhook).not.toHaveBeenCalled();
        });

        it('throws UnauthorizedException when signature verification fails (and does not dispatch)', async () => {
            const { controller, gitHubAppService, gitHubAppSyncService } = createController();
            gitHubAppService.verifyWebhookSignature.mockReturnValue(false);

            await expect(
                controller.handleWebhook(
                    makeReq('raw-body-here', { action: 'opened' }) as any,
                    'sig=bad',
                    'push',
                ),
            ).rejects.toThrow(UnauthorizedException);
            await expect(
                controller.handleWebhook(
                    makeReq('raw-body-here', { action: 'opened' }) as any,
                    'sig=bad',
                    'push',
                ),
            ).rejects.toThrow('Invalid GitHub webhook signature');
            expect(gitHubAppService.verifyWebhookSignature).toHaveBeenCalledWith(
                'raw-body-here',
                'sig=bad',
            );
            expect(gitHubAppSyncService.handleWebhook).not.toHaveBeenCalled();
        });

        it('forwards rawBody + signature to verifyWebhookSignature; signature header may be undefined', async () => {
            const { controller, gitHubAppService } = createController();
            gitHubAppService.verifyWebhookSignature.mockReturnValue(false);
            await expect(
                controller.handleWebhook(makeReq('rb') as any, undefined, 'push'),
            ).rejects.toThrow(UnauthorizedException);
            expect(gitHubAppService.verifyWebhookSignature).toHaveBeenCalledWith('rb', undefined);
        });

        it('happy path: dispatches via handleWebhook and returns { ok: true }', async () => {
            const { controller, gitHubAppService, gitHubAppSyncService } = createController();
            gitHubAppService.verifyWebhookSignature.mockReturnValue(true);
            gitHubAppSyncService.handleWebhook.mockResolvedValue(undefined);

            const body = { action: 'opened', repository: { id: 1 } };
            const result = await controller.handleWebhook(
                makeReq('raw-body', body) as any,
                'sig=good',
                'pull_request',
            );

            expect(gitHubAppService.verifyWebhookSignature).toHaveBeenCalledWith(
                'raw-body',
                'sig=good',
            );
            expect(gitHubAppSyncService.handleWebhook).toHaveBeenCalledWith('pull_request', body);
            expect(result).toEqual({ ok: true });
        });

        it('propagates errors from handleWebhook (no envelope on failure)', async () => {
            const { controller, gitHubAppService, gitHubAppSyncService } = createController();
            gitHubAppService.verifyWebhookSignature.mockReturnValue(true);
            gitHubAppSyncService.handleWebhook.mockRejectedValue(new Error('handler boom'));
            await expect(
                controller.handleWebhook(makeReq('raw', {}) as any, 'sig', 'installation'),
            ).rejects.toThrow('handler boom');
        });

        it('the @Public decorator semantics: handler is callable without auth context (smoke check)', async () => {
            // The @Public decorator only attaches metadata — it does not affect the
            // controller method's runtime behavior. Confirm no auth-context object is
            // required for invocation.
            const { controller, gitHubAppService, gitHubAppSyncService } = createController();
            gitHubAppService.verifyWebhookSignature.mockReturnValue(true);
            gitHubAppSyncService.handleWebhook.mockResolvedValue(undefined);
            await controller.handleWebhook(makeReq('raw', {}) as any, 'sig', 'ping');
            expect(gitHubAppSyncService.handleWebhook).toHaveBeenCalledTimes(1);
        });
    });
});

import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { HEADERS_METADATA } from '@nestjs/common/constants';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { WellKnownController } from './well-known.controller';
import { RegisterWorkRequestDto } from './dto/register-work.dto';

jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    OnboardingRequest: class OnboardingRequest {},
    WebhookSubscription: class WebhookSubscription {},
}));
jest.mock('@nestjs/throttler', () => ({
    Throttle: () => () => {},
    ThrottlerGuard: class {},
}));

describe('OnboardingController', () => {
    let controller: OnboardingController;
    let wellKnownController: WellKnownController;
    let mockService: { handle: jest.Mock; getStatus: jest.Mock };
    let validationPipe: ValidationPipe;

    beforeEach(() => {
        mockService = {
            handle: jest.fn(),
            getStatus: jest.fn(),
        };

        controller = new OnboardingController(mockService as unknown as OnboardingService);
        wellKnownController = new WellKnownController();
        validationPipe = new ValidationPipe({ whitelist: true, transform: true });
        jest.clearAllMocks();
    });

    const validateBody = async (value: Record<string, unknown>): Promise<RegisterWorkRequestDto> =>
        validationPipe.transform(value, {
            type: 'body',
            metatype: RegisterWorkRequestDto,
        }) as Promise<RegisterWorkRequestDto>;

    describe('register', () => {
        it('returns 202 payload on success and forwards the github token', async () => {
            mockService.handle.mockResolvedValue({
                onboardingId: 'ob-1',
                workId: 'w-1',
                status: 'received',
                statusUrl: '/api/register-work/ob-1',
                subdomain: 'mydir.ever.works',
            });

            const body = await validateBody({
                repo: 'https://github.com/octocat/awesome-mcp',
            });
            const result = await controller.register(body, 'gh_pat_xxx');

            expect(result.onboardingId).toBe('ob-1');
            expect(result.subdomain).toBe('mydir.ever.works');
            expect(mockService.handle).toHaveBeenCalledTimes(1);
            expect(mockService.handle).toHaveBeenCalledWith({
                body,
                githubToken: 'gh_pat_xxx',
                idempotencyKey: undefined,
            });
        });

        it('throws 400 when X-GitHub-Token is missing', async () => {
            const body = await validateBody({
                repo: 'https://github.com/octocat/awesome-mcp',
            });

            await expect(controller.register(body, '')).rejects.toThrow(BadRequestException);
            expect(mockService.handle).not.toHaveBeenCalled();
        });

        it('rejects non-github repo URLs through validation', async () => {
            await expect(
                validateBody({
                    repo: 'https://gitlab.com/foo/bar',
                }),
            ).rejects.toThrow(BadRequestException);
            expect(mockService.handle).not.toHaveBeenCalled();
        });

        it('strips unknown body fields via whitelist validation', async () => {
            mockService.handle.mockResolvedValue({
                onboardingId: 'ob-1',
                workId: 'w-1',
                status: 'received',
                statusUrl: '/api/register-work/ob-1',
                subdomain: 'mydir.ever.works',
            });

            const body = await validateBody({
                repo: 'https://github.com/octocat/awesome-mcp',
                nonsense: { whatever: true },
            });

            await controller.register(body, 'gh_pat_xxx');

            const arg = mockService.handle.mock.calls[0][0];
            expect(arg.body.nonsense).toBeUndefined();
        });

        it('forwards Idempotency-Key to the service', async () => {
            mockService.handle.mockResolvedValue({
                onboardingId: 'ob-1',
                workId: 'w-1',
                status: 'received',
                statusUrl: '/api/register-work/ob-1',
                subdomain: 'mydir.ever.works',
            });

            const body = await validateBody({
                repo: 'https://github.com/octocat/awesome-mcp',
            });
            await controller.register(body, 'gh_pat_xxx', 'idem-1');

            expect(mockService.handle).toHaveBeenCalledWith({
                body,
                githubToken: 'gh_pat_xxx',
                idempotencyKey: 'idem-1',
            });
        });
    });

    describe('agent card', () => {
        it('serves the Agent Card payload', () => {
            const result = wellKnownController.agentCard();

            expect(result.name).toBe('Ever Works');
            expect(result.capabilities[0].id).toBe('register_work');
            expect(result.capabilities[0].rest?.method).toBe('POST');
        });

        it('declares cache headers on the endpoint metadata', () => {
            const headers = Reflect.getMetadata(
                HEADERS_METADATA,
                WellKnownController.prototype.agentCard,
            ) as Array<{ name: string; value: string }>;

            expect(headers).toEqual(
                expect.arrayContaining([
                    { name: 'Cache-Control', value: 'public, max-age=300' },
                    { name: 'Content-Type', value: 'application/json; charset=utf-8' },
                ]),
            );
        });
    });
});

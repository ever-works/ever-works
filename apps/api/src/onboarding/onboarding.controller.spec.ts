import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { WellKnownController } from './well-known.controller';

jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    OnboardingRequest: class OnboardingRequest {},
    WebhookSubscription: class WebhookSubscription {},
}));
jest.mock('@nestjs/throttler', () => ({
    Throttle: () => () => {},
    ThrottlerGuard: class {},
}));

describe('OnboardingController (HTTP)', () => {
    let app: INestApplication;
    let mockService: { handle: jest.Mock; getStatus: jest.Mock };

    beforeAll(async () => {
        mockService = {
            handle: jest.fn(),
            getStatus: jest.fn(),
        };

        const moduleRef = await Test.createTestingModule({
            controllers: [OnboardingController, WellKnownController],
            providers: [
                {
                    provide: OnboardingService,
                    useValue: mockService,
                },
            ],
        }).compile();

        app = moduleRef.createNestApplication();
        app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
        await app.init();
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('POST /register-work', () => {
        it('returns 202 on success and forwards header to service', async () => {
            mockService.handle.mockResolvedValue({
                onboardingId: 'ob-1',
                workId: 'w-1',
                status: 'received',
                statusUrl: '/api/register-work/ob-1',
                subdomain: 'mydir.ever.works',
            });

            const res = await request(app.getHttpServer())
                .post('/api/register-work')
                .set('X-GitHub-Token', 'gh_pat_xxx')
                .send({ repo: 'https://github.com/octocat/awesome-mcp' });

            expect(res.status).toBe(202);
            expect(res.body.onboardingId).toBe('ob-1');
            expect(res.body.subdomain).toBe('mydir.ever.works');
            expect(mockService.handle).toHaveBeenCalledTimes(1);
            const arg = mockService.handle.mock.calls[0][0];
            expect(arg.githubToken).toBe('gh_pat_xxx');
        });

        it('returns 400 when X-GitHub-Token header is missing', async () => {
            const res = await request(app.getHttpServer())
                .post('/api/register-work')
                .send({ repo: 'https://github.com/octocat/awesome-mcp' });

            expect(res.status).toBe(400);
            expect(res.body.code).toBe('validation_error');
            expect(mockService.handle).not.toHaveBeenCalled();
        });

        it('returns 400 when repo is not a github URL', async () => {
            const res = await request(app.getHttpServer())
                .post('/api/register-work')
                .set('X-GitHub-Token', 'gh_pat_xxx')
                .send({ repo: 'https://gitlab.com/foo/bar' });

            expect(res.status).toBe(400);
            expect(mockService.handle).not.toHaveBeenCalled();
        });

        it('strips unknown body fields (whitelist)', async () => {
            mockService.handle.mockResolvedValue({
                onboardingId: 'ob-1',
                workId: 'w-1',
                status: 'received',
                statusUrl: '/api/register-work/ob-1',
                subdomain: 'mydir.ever.works',
            });

            await request(app.getHttpServer())
                .post('/api/register-work')
                .set('X-GitHub-Token', 'gh_pat_xxx')
                .send({
                    repo: 'https://github.com/octocat/awesome-mcp',
                    nonsense: { whatever: true },
                })
                .expect(202);

            const arg = mockService.handle.mock.calls[0][0];
            expect(arg.body.nonsense).toBeUndefined();
        });

        it('forwards Idempotency-Key header to service', async () => {
            mockService.handle.mockResolvedValue({
                onboardingId: 'ob-1',
                workId: 'w-1',
                status: 'received',
                statusUrl: '/api/register-work/ob-1',
                subdomain: 'mydir.ever.works',
            });

            await request(app.getHttpServer())
                .post('/api/register-work')
                .set('X-GitHub-Token', 'gh_pat_xxx')
                .set('Idempotency-Key', 'idem-1')
                .send({ repo: 'https://github.com/octocat/awesome-mcp' })
                .expect(202);

            const arg = mockService.handle.mock.calls[0][0];
            expect(arg.idempotencyKey).toBe('idem-1');
        });
    });

    describe('GET /.well-known/agent.json', () => {
        it('serves the Agent Card', async () => {
            const res = await request(app.getHttpServer()).get('/.well-known/agent.json');

            expect(res.status).toBe(200);
            expect(res.body.name).toBe('Ever Works');
            expect(res.body.capabilities[0].id).toBe('register_work');
            expect(res.body.capabilities[0].rest.method).toBe('POST');
            expect(res.headers['cache-control']).toContain('max-age=300');
        });
    });
});

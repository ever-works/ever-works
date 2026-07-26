import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

jest.mock('@ever-works/agent/digest', () => ({
    DigestService: class {},
    DIGEST_PERIODS: ['daily', 'weekly'],
}));

import { DigestController } from './digest.controller';
import { GetDigestQueryDto } from './dto/get-digest.dto';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';

/**
 * `GET /api/digest` — the REST operation the manifest-driven web tool
 * registry needs before `get_digest` can exist on the web side.
 */
describe('DigestController (GET /api/digest)', () => {
    function createController() {
        const digest = {
            composeDigest: jest.fn().mockResolvedValue({
                period: 'daily',
                since: '2026-07-25T00:00:00.000Z',
                until: '2026-07-26T00:00:00.000Z',
                quiet: false,
                markdown: '## Today\n- 1 run completed',
                text: '1 run completed',
                counts: {
                    runsCompleted: 1,
                    runsFailed: 0,
                    tasksDone: 2,
                    tasksInReview: 0,
                    prsOpened: 1,
                    eventsBySource: { github: 3 },
                    eventsTotal: 3,
                    goalsTracked: 1,
                },
            }),
        };
        return { controller: new DigestController(digest as never), digest };
    }

    it('returns the composed digest shape for the current user', async () => {
        const { controller } = createController();

        const result = await controller.getDigest({ userId: 'user-1' } as never, {
            period: 'weekly',
        });

        expect(result).toEqual(
            expect.objectContaining({
                period: 'daily',
                since: expect.any(String),
                until: expect.any(String),
                quiet: false,
                markdown: expect.any(String),
                text: expect.any(String),
                counts: expect.objectContaining({
                    runsCompleted: expect.any(Number),
                    tasksDone: expect.any(Number),
                    eventsBySource: expect.any(Object),
                    eventsTotal: expect.any(Number),
                    goalsTracked: expect.any(Number),
                }),
            }),
        );
    });

    it('composes for the AUTHENTICATED user and never for a caller-supplied id', async () => {
        const { controller, digest } = createController();

        await controller.getDigest(
            { userId: 'user-1' } as never,
            {
                // A hostile client cannot ask for someone else's activity:
                // the DTO has no `userId` and the controller passes only the
                // session's own id.
                userId: 'victim',
            } as never,
        );

        expect(digest.composeDigest).toHaveBeenCalledWith('user-1', { period: 'daily' });
    });

    it('defaults the window to daily and forwards an explicit period', async () => {
        const { controller, digest } = createController();

        await controller.getDigest({ userId: 'user-1' } as never, {});
        expect(digest.composeDigest).toHaveBeenLastCalledWith('user-1', { period: 'daily' });

        await controller.getDigest({ userId: 'user-1' } as never, { period: 'weekly' });
        expect(digest.composeDigest).toHaveBeenLastCalledWith('user-1', { period: 'weekly' });
    });

    it('is NOT @Public() — an unauthenticated call is 401ed by the global auth guard', () => {
        expect(Reflect.getMetadata(IS_PUBLIC_KEY, DigestController)).toBeUndefined();
        expect(
            Reflect.getMetadata(IS_PUBLIC_KEY, DigestController.prototype.getDigest),
        ).toBeUndefined();
    });

    describe('GetDigestQueryDto', () => {
        it('accepts the supported periods and an omitted period', async () => {
            for (const period of [undefined, 'daily', 'weekly']) {
                const dto = plainToInstance(GetDigestQueryDto, { period });
                expect(await validate(dto)).toHaveLength(0);
            }
        });

        it('rejects an unsupported period', async () => {
            const dto = plainToInstance(GetDigestQueryDto, { period: 'hourly' });
            const errors = await validate(dto);
            expect(errors).toHaveLength(1);
            expect(errors[0].property).toBe('period');
        });
    });
});

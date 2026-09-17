import 'reflect-metadata';
import { BadRequestException, ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { HomeSummaryQueryDto } from './home-summary-query.dto';

// Mirrors `app.useGlobalPipes(...)` in apps/api/src/main.ts: whitelist +
// transform + forbidNonWhitelisted is what turns an unknown parameter into a
// 400 rather than a silent drop.
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const metadata: ArgumentMetadata = {
    type: 'query',
    metatype: HomeSummaryQueryDto,
    data: undefined,
};

const transform = (query: Record<string, unknown>) =>
    pipe.transform(query, metadata) as Promise<HomeSummaryQueryDto>;

async function expectRejected(query: Record<string, unknown>): Promise<void> {
    await expect(transform(query)).rejects.toBeInstanceOf(BadRequestException);
}

describe('HomeSummaryQueryDto', () => {
    it('accepts an empty query', async () => {
        await expect(transform({})).resolves.toEqual({});
    });

    it.each(['Europe/Kyiv', 'America/New_York', 'Pacific/Kiritimati', 'UTC', 'GMT'])(
        'accepts the timezone %s',
        async (tz) => {
            await expect(transform({ tz })).resolves.toMatchObject({ tz });
        },
    );

    it('refuses a timezone that is not a real zone', async () => {
        await expectRejected({ tz: 'Mars/Olympus_Mons' });
        await expectRejected({ tz: 'Europe/' + 'x'.repeat(70) });
    });

    it('parses blocks from a CSV and from repeated parameters', async () => {
        await expect(transform({ blocks: 'today, needsYou' })).resolves.toMatchObject({
            blocks: ['today', 'needsYou'],
        });
        await expect(transform({ blocks: ['thisWeek', 'glance'] })).resolves.toMatchObject({
            blocks: ['thisWeek', 'glance'],
        });
    });

    it('refuses an unknown block id', async () => {
        await expectRejected({ blocks: 'today,tomorrow' });
    });

    it('refuses more entries than there are blocks', async () => {
        await expectRejected({
            blocks: 'needsYou,glance,today,thisWeek,workingNow,recentActivity,today',
        });
    });

    it('has no parameter by which a caller names another user or Organization', async () => {
        await expectRejected({ userId: '11111111-1111-4111-8111-111111111111' });
        await expectRejected({ organizationId: '22222222-2222-4222-8222-222222222222' });
    });
});

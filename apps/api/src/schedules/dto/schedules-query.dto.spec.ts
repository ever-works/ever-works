import 'reflect-metadata';
import { BadRequestException, ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { getMetadataStorage } from 'class-validator';
import { ScheduleQueryDto } from './schedules-query.dto';

/**
 * Contract pin for `GET /api/schedules`' query surface.
 *
 * This is the server half of a two-sided contract test. The client half lives
 * in `apps/web/src/app/[locale]/(dashboard)/(home)/dashboard-data.unit.spec.ts`,
 * which asserts that the dashboard's Soon block only ever emits parameters from
 * {@link SUPPORTED_QUERY_PARAMS}. This spec asserts that that same set is
 * *exactly* what the DTO accepts — so if anyone adds, renames, or drops a filter
 * here, this file fails and the web-side whitelist has to be updated with it.
 *
 * Why it exists: the Soon block shipped calling
 * `?status=active&sort=nextRunAt:asc&limit=3`. None of those three are
 * whitelisted, the global pipe runs with `forbidNonWhitelisted`, and the web
 * caller swallowed the resulting 400 — so the block was permanently empty in
 * every environment and nothing surfaced it.
 *
 * The pipe below is constructed with the *same* options as the global one in
 * `apps/api/src/main.ts` (`whitelist` + `transform` + `forbidNonWhitelisted`);
 * that triple is what makes an unknown parameter a 400 rather than a silent
 * drop, so the test would be meaningless without it.
 */

// Mirrors `app.useGlobalPipes(...)` in apps/api/src/main.ts.
const GLOBAL_PIPE_OPTIONS = {
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
} as const;

/**
 * Every query parameter `GET /api/schedules` supports. Kept as a literal (not
 * derived from the DTO) so it reads as the published contract; the
 * "no undeclared filters" test below proves the DTO has not drifted from it.
 */
const SUPPORTED_QUERY_PARAMS = ['sourceType', 'entityKind', 'enabledOnly'] as const;

/**
 * The parameters the dashboard's Soon block used to send. Every one of them is
 * rejected — this is the reproduction of the defect, kept as a regression pin
 * so nobody "fixes" the caller by re-adding them.
 */
const LEGACY_SOON_BLOCK_PARAMS = { status: 'active', sort: 'nextRunAt:asc', limit: '3' };

const pipe = new ValidationPipe(GLOBAL_PIPE_OPTIONS);
const metadata: ArgumentMetadata = { type: 'query', metatype: ScheduleQueryDto, data: undefined };

const transform = (query: Record<string, unknown>) => pipe.transform(query, metadata);

/** Collect the BadRequestException's `message` array, whatever its nesting. */
async function rejectionMessages(query: Record<string, unknown>): Promise<string[]> {
    try {
        await transform(query);
    } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        const response = (error as BadRequestException).getResponse();
        const message = (response as { message?: unknown }).message;
        return Array.isArray(message) ? (message as string[]) : [String(message)];
    }
    throw new Error(`expected ${JSON.stringify(query)} to be rejected, but it validated cleanly`);
}

describe('ScheduleQueryDto — GET /api/schedules query contract', () => {
    describe('the supported filter surface', () => {
        it('accepts an empty query (every filter is optional)', async () => {
            await expect(transform({})).resolves.toEqual({});
        });

        it.each([
            ['sourceType', { sourceType: 'work_schedule' }],
            ['entityKind', { entityKind: 'work' }],
            ['enabledOnly', { enabledOnly: 'true' }],
        ])('accepts %s on its own', async (_name, query) => {
            await expect(transform(query)).resolves.toBeDefined();
        });

        it('accepts all three together — the full surface a client may send', async () => {
            await expect(
                transform({
                    sourceType: 'mission_tick',
                    entityKind: 'mission',
                    enabledOnly: 'true',
                }),
            ).resolves.toEqual({
                sourceType: 'mission_tick',
                entityKind: 'mission',
                enabledOnly: true,
            });
        });

        it('coerces the enabledOnly query string to a real boolean', async () => {
            await expect(transform({ enabledOnly: 'true' })).resolves.toEqual({
                enabledOnly: true,
            });
            await expect(transform({ enabledOnly: 'false' })).resolves.toEqual({
                enabledOnly: false,
            });
        });

        it('declares no filters beyond SUPPORTED_QUERY_PARAMS', () => {
            // Derived from class-validator's metadata: the properties the DTO
            // actually validates. If a filter is added to the DTO without being
            // added to the published set above (and to the web-side whitelist
            // this set is shared with), this fails.
            const declared = new Set(
                getMetadataStorage()
                    .getTargetValidationMetadatas(ScheduleQueryDto, '', false, false)
                    .map((meta) => meta.propertyName),
            );
            expect([...declared].sort()).toEqual([...SUPPORTED_QUERY_PARAMS].sort());
        });
    });

    describe('unknown parameters are rejected, not ignored', () => {
        it('400s on the exact params the dashboard Soon block used to send', async () => {
            const messages = await rejectionMessages(LEGACY_SOON_BLOCK_PARAMS);
            // The precise strings observed in the dev web pod logs.
            expect(messages).toEqual(
                expect.arrayContaining([
                    'property status should not exist',
                    'property sort should not exist',
                    'property limit should not exist',
                ]),
            );
        });

        it.each(Object.keys(LEGACY_SOON_BLOCK_PARAMS))(
            'rejects %s even alongside otherwise-valid filters',
            async (param) => {
                const messages = await rejectionMessages({ enabledOnly: 'true', [param]: 'x' });
                expect(messages).toContain(`property ${param} should not exist`);
            },
        );

        it('rejects a typo of a supported filter rather than silently ignoring it', async () => {
            const messages = await rejectionMessages({ sourcetype: 'work_schedule' });
            expect(messages).toContain('property sourcetype should not exist');
        });
    });

    describe('supported filters still police their own values', () => {
        it('rejects an out-of-enum sourceType', async () => {
            const messages = await rejectionMessages({ sourceType: 'not_a_source' });
            expect(messages.join(' ')).toMatch(/sourceType/);
        });

        it('rejects an out-of-enum entityKind', async () => {
            const messages = await rejectionMessages({ entityKind: 'organization' });
            expect(messages.join(' ')).toMatch(/entityKind/);
        });

        it('rejects a non-boolean enabledOnly', async () => {
            const messages = await rejectionMessages({ enabledOnly: 'yes' });
            expect(messages.join(' ')).toMatch(/enabledOnly/);
        });
    });
});

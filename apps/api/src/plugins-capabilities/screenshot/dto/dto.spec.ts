import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CaptureScreenshotDto, GetScreenshotUrlDto } from './screenshot.dto';

const constraintsFor = (
    errs: { property: string; constraints?: Record<string, string> }[],
    property: string,
) => errs.find((e) => e.property === property)?.constraints ?? {};

describe('plugins-capabilities/screenshot CaptureScreenshotDto', () => {
    it('accepts a url-only payload (all other fields are optional)', async () => {
        const dto = plainToInstance(CaptureScreenshotDto, { url: 'https://example.com' });
        expect(await validate(dto)).toHaveLength(0);
    });

    it('accepts a fully populated payload', async () => {
        const dto = plainToInstance(CaptureScreenshotDto, {
            url: 'https://example.com',
            providerOverride: 'screenshotone',
            workId: 'a0499a65-9b8c-4bf7-857e-895f52da30b3',
            viewportWidth: 1280,
            viewportHeight: 720,
            format: 'png',
            fullPage: false,
            delay: 1000,
            blockAds: true,
            blockTrackers: true,
            blockCookieBanners: true,
        });
        expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects an invalid URL via @IsUrl', async () => {
        const dto = plainToInstance(CaptureScreenshotDto, { url: 'not-a-url' });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'url').isUrl).toBeDefined();
    });

    it('rejects a missing url via @IsUrl', async () => {
        const dto = plainToInstance(CaptureScreenshotDto, {});
        const errs = await validate(dto);
        expect(errs.find((e) => e.property === 'url')).toBeDefined();
    });

    describe('providerOverride', () => {
        it('rejects non-string providerOverride via @IsString', async () => {
            const dto = plainToInstance(CaptureScreenshotDto, {
                url: 'https://example.com',
                providerOverride: 42 as unknown as string,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'providerOverride').isString).toBeDefined();
        });
    });

    describe('workId', () => {
        it('rejects non-UUID workId via @IsUUID', async () => {
            const dto = plainToInstance(CaptureScreenshotDto, {
                url: 'https://example.com',
                workId: 'not-a-uuid',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'workId').isUuid).toBeDefined();
        });

        it('accepts a v4 UUID workId', async () => {
            const dto = plainToInstance(CaptureScreenshotDto, {
                url: 'https://example.com',
                workId: 'a0499a65-9b8c-4bf7-857e-895f52da30b3',
            });
            expect(await validate(dto)).toHaveLength(0);
        });
    });

    describe('viewportWidth boundaries', () => {
        it('accepts 320 (lower bound)', async () => {
            const dto = plainToInstance(CaptureScreenshotDto, {
                url: 'https://example.com',
                viewportWidth: 320,
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts 3840 (upper bound)', async () => {
            const dto = plainToInstance(CaptureScreenshotDto, {
                url: 'https://example.com',
                viewportWidth: 3840,
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects below 320 via @Min(320)', async () => {
            const dto = plainToInstance(CaptureScreenshotDto, {
                url: 'https://example.com',
                viewportWidth: 319,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'viewportWidth').min).toBeDefined();
        });

        it('rejects above 3840 via @Max(3840)', async () => {
            const dto = plainToInstance(CaptureScreenshotDto, {
                url: 'https://example.com',
                viewportWidth: 3841,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'viewportWidth').max).toBeDefined();
        });
    });

    describe('viewportHeight boundaries', () => {
        it('accepts 240 (lower bound)', async () => {
            const dto = plainToInstance(CaptureScreenshotDto, {
                url: 'https://example.com',
                viewportHeight: 240,
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts 2160 (upper bound)', async () => {
            const dto = plainToInstance(CaptureScreenshotDto, {
                url: 'https://example.com',
                viewportHeight: 2160,
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects below 240 via @Min(240)', async () => {
            const dto = plainToInstance(CaptureScreenshotDto, {
                url: 'https://example.com',
                viewportHeight: 239,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'viewportHeight').min).toBeDefined();
        });

        it('rejects above 2160 via @Max(2160)', async () => {
            const dto = plainToInstance(CaptureScreenshotDto, {
                url: 'https://example.com',
                viewportHeight: 2161,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'viewportHeight').max).toBeDefined();
        });
    });

    describe('format', () => {
        it('accepts each documented format literal', async () => {
            for (const format of ['png', 'jpg', 'webp'] as const) {
                const dto = plainToInstance(CaptureScreenshotDto, {
                    url: 'https://example.com',
                    format,
                });
                expect(await validate(dto)).toHaveLength(0);
            }
        });

        it('rejects an unknown format via @IsIn', async () => {
            const dto = plainToInstance(CaptureScreenshotDto, {
                url: 'https://example.com',
                format: 'gif' as never,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'format').isIn).toBeDefined();
        });

        it('rejects uppercase variants — @IsIn is case-sensitive', async () => {
            const dto = plainToInstance(CaptureScreenshotDto, {
                url: 'https://example.com',
                format: 'PNG' as never,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'format').isIn).toBeDefined();
        });
    });

    describe('boolean flags', () => {
        it.each(['fullPage', 'blockAds', 'blockTrackers', 'blockCookieBanners'] as const)(
            'rejects non-boolean %s via @IsBoolean',
            async (field) => {
                const dto = plainToInstance(CaptureScreenshotDto, {
                    url: 'https://example.com',
                    [field]: 'yes',
                });
                const errs = await validate(dto);
                expect(constraintsFor(errs, field).isBoolean).toBeDefined();
            },
        );
    });

    describe('delay boundaries', () => {
        it('accepts 0 (lower bound — no delay)', async () => {
            const dto = plainToInstance(CaptureScreenshotDto, {
                url: 'https://example.com',
                delay: 0,
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts 10000 (upper bound — 10s ceiling)', async () => {
            const dto = plainToInstance(CaptureScreenshotDto, {
                url: 'https://example.com',
                delay: 10000,
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects below 0 via @Min(0)', async () => {
            const dto = plainToInstance(CaptureScreenshotDto, {
                url: 'https://example.com',
                delay: -1,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'delay').min).toBeDefined();
        });

        it('rejects above 10000 via @Max(10000)', async () => {
            const dto = plainToInstance(CaptureScreenshotDto, {
                url: 'https://example.com',
                delay: 10001,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'delay').max).toBeDefined();
        });
    });
});

describe('plugins-capabilities/screenshot GetScreenshotUrlDto', () => {
    it('inherits the full validation surface from CaptureScreenshotDto', async () => {
        // Pinned: GetScreenshotUrlDto is `class GetScreenshotUrlDto extends CaptureScreenshotDto`
        // — every rule applies. A future "diverge GetScreenshotUrlDto" change would
        // surface here.
        const dto = plainToInstance(GetScreenshotUrlDto, { url: 'not-a-url' });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'url').isUrl).toBeDefined();
    });

    it('accepts the same valid payload as CaptureScreenshotDto', async () => {
        const dto = plainToInstance(GetScreenshotUrlDto, { url: 'https://example.com' });
        expect(await validate(dto)).toHaveLength(0);
    });
});

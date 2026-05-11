import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
    AddCustomTemplateDto,
    ArchiveCustomTemplateDto,
    ForkTemplateDto,
    ListTemplatesQueryDto,
    RefreshTemplatesDto,
    SetDefaultTemplateDto,
    UpdateCustomTemplateDto,
} from './list-templates.dto';

const constraintsFor = (
    errs: { property: string; constraints?: Record<string, string> }[],
    property: string,
) => errs.find((e) => e.property === property)?.constraints ?? {};

describe('template-catalog DTOs validation', () => {
    describe('ListTemplatesQueryDto', () => {
        it('accepts kind="website"', async () => {
            const dto = plainToInstance(ListTemplatesQueryDto, { kind: 'website' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts kind="work"', async () => {
            const dto = plainToInstance(ListTemplatesQueryDto, { kind: 'work' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects missing kind via @IsString', async () => {
            const dto = plainToInstance(ListTemplatesQueryDto, {});
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'kind').isString).toBeDefined();
        });

        it('rejects out-of-enum kind via @IsIn', async () => {
            const dto = plainToInstance(ListTemplatesQueryDto, {
                kind: 'invalid' as 'website' | 'work',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'kind').isIn).toBeDefined();
        });

        it('rejects uppercase kind (case-sensitive @IsIn)', async () => {
            const dto = plainToInstance(ListTemplatesQueryDto, {
                kind: 'WEBSITE' as 'website' | 'work',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'kind').isIn).toBeDefined();
        });
    });

    describe('AddCustomTemplateDto', () => {
        const valid = {
            kind: 'website' as const,
            repositoryUrl: 'https://github.com/org/template',
        };

        it('accepts a minimal valid payload', async () => {
            const dto = plainToInstance(AddCustomTemplateDto, valid);
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts a fully populated payload', async () => {
            const dto = plainToInstance(AddCustomTemplateDto, {
                ...valid,
                name: 'My Template',
                description: 'A great template',
                framework: 'next.js',
                previewImageUrl: 'https://cdn.example.com/preview.png',
                branch: 'main',
                betaBranch: 'beta',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects http URL without protocol via @IsUrl({require_protocol:true})', async () => {
            const dto = plainToInstance(AddCustomTemplateDto, {
                ...valid,
                repositoryUrl: 'github.com/org/template',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'repositoryUrl').isUrl).toBeDefined();
        });

        it('rejects ftp:// URL (only http/https allowed)', async () => {
            const dto = plainToInstance(AddCustomTemplateDto, {
                ...valid,
                repositoryUrl: 'ftp://example.com/repo',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'repositoryUrl').isUrl).toBeDefined();
        });

        it('rejects invalid previewImageUrl protocol', async () => {
            const dto = plainToInstance(AddCustomTemplateDto, {
                ...valid,
                previewImageUrl: 'data:image/png;base64,abc',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'previewImageUrl').isUrl).toBeDefined();
        });

        it('rejects out-of-enum kind', async () => {
            const dto = plainToInstance(AddCustomTemplateDto, {
                ...valid,
                kind: 'unknown' as 'website' | 'work',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'kind').isIn).toBeDefined();
        });

        it('rejects non-string name via @IsString', async () => {
            const dto = plainToInstance(AddCustomTemplateDto, {
                ...valid,
                name: 42 as unknown as string,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'name').isString).toBeDefined();
        });
    });

    describe('SetDefaultTemplateDto', () => {
        it('accepts a valid payload', async () => {
            const dto = plainToInstance(SetDefaultTemplateDto, {
                kind: 'website',
                templateId: 'tpl-1',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects missing templateId via @IsString', async () => {
            const dto = plainToInstance(SetDefaultTemplateDto, { kind: 'work' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'templateId').isString).toBeDefined();
        });

        it('rejects non-string templateId via @IsString', async () => {
            const dto = plainToInstance(SetDefaultTemplateDto, {
                kind: 'work',
                templateId: 42 as unknown as string,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'templateId').isString).toBeDefined();
        });
    });

    describe('UpdateCustomTemplateDto', () => {
        it('accepts kind-only payload (every other field optional)', async () => {
            const dto = plainToInstance(UpdateCustomTemplateDto, { kind: 'website' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts a fully populated payload', async () => {
            const dto = plainToInstance(UpdateCustomTemplateDto, {
                kind: 'work',
                name: 'X',
                description: 'Y',
                framework: 'next.js',
                previewImageUrl: 'https://cdn.example.com/p.png',
                branch: 'main',
                betaBranch: 'next',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects invalid previewImageUrl', async () => {
            const dto = plainToInstance(UpdateCustomTemplateDto, {
                kind: 'website',
                previewImageUrl: 'not-a-url',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'previewImageUrl').isUrl).toBeDefined();
        });

        it('rejects non-string betaBranch via @IsString', async () => {
            const dto = plainToInstance(UpdateCustomTemplateDto, {
                kind: 'website',
                betaBranch: 42 as unknown as string,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'betaBranch').isString).toBeDefined();
        });
    });

    describe('ArchiveCustomTemplateDto', () => {
        it('accepts kind="work"', async () => {
            const dto = plainToInstance(ArchiveCustomTemplateDto, { kind: 'work' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects out-of-enum kind', async () => {
            const dto = plainToInstance(ArchiveCustomTemplateDto, {
                kind: 'unknown' as 'website' | 'work',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'kind').isIn).toBeDefined();
        });
    });

    describe('ForkTemplateDto', () => {
        const valid = { kind: 'website' as const, templateId: 'tpl-1', targetOwner: 'octocat' };

        it('accepts a fully valid payload', async () => {
            const dto = plainToInstance(ForkTemplateDto, valid);
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects missing templateId via @IsString', async () => {
            const dto = plainToInstance(ForkTemplateDto, { kind: 'website', targetOwner: 'oct' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'templateId').isString).toBeDefined();
        });

        it('rejects missing targetOwner via @IsString', async () => {
            const dto = plainToInstance(ForkTemplateDto, { kind: 'website', templateId: 't1' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'targetOwner').isString).toBeDefined();
        });

        it('rejects non-string targetOwner via @IsString', async () => {
            const dto = plainToInstance(ForkTemplateDto, {
                ...valid,
                targetOwner: 42 as unknown as string,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'targetOwner').isString).toBeDefined();
        });
    });

    describe('RefreshTemplatesDto', () => {
        it('accepts kind="website"', async () => {
            const dto = plainToInstance(RefreshTemplatesDto, { kind: 'website' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects missing kind via @IsString', async () => {
            const dto = plainToInstance(RefreshTemplatesDto, {});
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'kind').isString).toBeDefined();
        });
    });
});

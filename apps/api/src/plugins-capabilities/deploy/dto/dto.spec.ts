import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { BatchDeployDto, BatchDeployItemDto } from './batch-deploy.dto';
import { DeployWorkDto, GetTeamsDto, ValidateTokenDto } from './deploy.dto';

const constraintsFor = (
    errs: { property: string; constraints?: Record<string, string> }[],
    property: string,
) => errs.find((e) => e.property === property)?.constraints ?? {};

describe('plugins-capabilities/deploy DTO validation', () => {
    describe('DeployWorkDto', () => {
        it('accepts an empty payload (teamScope is optional)', async () => {
            const dto = plainToInstance(DeployWorkDto, {});
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts a string teamScope', async () => {
            const dto = plainToInstance(DeployWorkDto, { teamScope: 'team-acme' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-string teamScope via @IsString', async () => {
            const dto = plainToInstance(DeployWorkDto, { teamScope: 42 as unknown as string });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'teamScope').isString).toBeDefined();
        });

        it('accepts an empty-string teamScope (no IsNotEmpty rule)', async () => {
            // Pinned: a future "must be non-empty" change would silently reject callers
            // that want to clear the team scope by sending `''`.
            const dto = plainToInstance(DeployWorkDto, { teamScope: '' });
            expect(await validate(dto)).toHaveLength(0);
        });
    });

    describe('ValidateTokenDto', () => {
        it('accepts a string providerId', async () => {
            const dto = plainToInstance(ValidateTokenDto, { providerId: 'vercel' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-string providerId via @IsString', async () => {
            const dto = plainToInstance(ValidateTokenDto, {
                providerId: 42 as unknown as string,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'providerId').isString).toBeDefined();
        });

        it('rejects missing providerId via @IsString (undefined fails IsString)', async () => {
            const dto = plainToInstance(ValidateTokenDto, {});
            const errs = await validate(dto);
            expect(errs.find((e) => e.property === 'providerId')).toBeDefined();
        });

        it('does NOT enforce @IsNotEmpty on providerId (empty string accepted)', async () => {
            // Pinned: only @IsString runs. The DTO accepts `''` — the controller is
            // responsible for surfacing "Provider 'X' is not available" downstream.
            const dto = plainToInstance(ValidateTokenDto, { providerId: '' });
            expect(await validate(dto)).toHaveLength(0);
        });
    });

    describe('GetTeamsDto', () => {
        it('accepts a string providerId', async () => {
            const dto = plainToInstance(GetTeamsDto, { providerId: 'vercel' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-string providerId via @IsString', async () => {
            const dto = plainToInstance(GetTeamsDto, { providerId: 42 as unknown as string });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'providerId').isString).toBeDefined();
        });

        it('mirrors the ValidateTokenDto shape exactly (empty-string accepted, no IsNotEmpty)', async () => {
            // Pinned because the two DTOs have identical contracts; a future "tighten
            // GetTeamsDto only" change would create asymmetry that this test surfaces.
            const dto = plainToInstance(GetTeamsDto, { providerId: '' });
            expect(await validate(dto)).toHaveLength(0);
        });
    });

    describe('BatchDeployItemDto', () => {
        it('accepts a workId without teamScope', async () => {
            const dto = plainToInstance(BatchDeployItemDto, { workId: 'work-1' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts a workId + teamScope', async () => {
            const dto = plainToInstance(BatchDeployItemDto, {
                workId: 'work-1',
                teamScope: 'team-acme',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-string workId via @IsString', async () => {
            const dto = plainToInstance(BatchDeployItemDto, {
                workId: 42 as unknown as string,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'workId').isString).toBeDefined();
        });

        it('rejects non-string teamScope via @IsString', async () => {
            const dto = plainToInstance(BatchDeployItemDto, {
                workId: 'work-1',
                teamScope: 99 as unknown as string,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'teamScope').isString).toBeDefined();
        });
    });

    describe('BatchDeployDto', () => {
        it('accepts a single-item works[]', async () => {
            const dto = plainToInstance(BatchDeployDto, {
                works: [{ workId: 'work-1' }],
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts an empty works[] (no @ArrayMinSize)', async () => {
            // Pinned: a future @ArrayMinSize(1) tightening would silently reject any
            // caller that races a request with an empty selection. The controller
            // surfaces the empty case as a `successfullyStarted: 0` envelope.
            const dto = plainToInstance(BatchDeployDto, { works: [] });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts a teamScope alongside works[]', async () => {
            const dto = plainToInstance(BatchDeployDto, {
                works: [{ workId: 'w' }],
                teamScope: 'team-acme',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-array works via @IsArray', async () => {
            const dto = plainToInstance(BatchDeployDto, {
                works: 'not-an-array' as unknown as BatchDeployItemDto[],
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'works').isArray).toBeDefined();
        });

        it('runs nested @ValidateNested for each works[] entry', async () => {
            // Pinned: @ValidateNested + @Type(() => BatchDeployItemDto) means each entry
            // is validated as a BatchDeployItemDto. A future "skip nested validation"
            // refactor would let callers smuggle malformed entries through.
            const dto = plainToInstance(BatchDeployDto, {
                works: [{ workId: 42 }],
            });
            const errs = await validate(dto);
            const works = errs.find((e) => e.property === 'works');
            expect(works).toBeDefined();
            // Nested children expose the same isString constraint on the inner workId.
            const inner = works?.children?.[0]?.children?.find((c) => c.property === 'workId');
            expect(inner?.constraints?.isString).toBeDefined();
        });

        it('rejects non-string teamScope at the top level', async () => {
            const dto = plainToInstance(BatchDeployDto, {
                works: [{ workId: 'w' }],
                teamScope: 99 as unknown as string,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'teamScope').isString).toBeDefined();
        });
    });
});

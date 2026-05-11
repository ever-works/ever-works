import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { SearchDto } from './search.dto';

const constraintsFor = (
    errs: { property: string; constraints?: Record<string, string> }[],
    property: string,
) => errs.find((e) => e.property === property)?.constraints ?? {};

describe('plugins-capabilities/search SearchDto', () => {
    it('accepts a query-only payload (every other field is optional)', async () => {
        const dto = plainToInstance(SearchDto, { query: 'best project management tools' });
        expect(await validate(dto)).toHaveLength(0);
    });

    it('accepts a fully populated payload', async () => {
        const dto = plainToInstance(SearchDto, {
            query: 'agile boards',
            maxResults: 25,
            includeDomains: ['github.com', 'stackoverflow.com'],
            excludeDomains: ['pinterest.com'],
        });
        expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects non-string query via @IsString', async () => {
        const dto = plainToInstance(SearchDto, { query: 42 as unknown as string });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'query').isString).toBeDefined();
    });

    it('does NOT enforce @IsNotEmpty on query (empty string accepted)', async () => {
        // Pinned: only @IsString runs. Empty queries surface downstream as a
        // facade-level NoProviderError or empty-result envelope, not as a 400.
        const dto = plainToInstance(SearchDto, { query: '' });
        expect(await validate(dto)).toHaveLength(0);
    });

    describe('maxResults', () => {
        it('accepts maxResults at the lower boundary (1)', async () => {
            const dto = plainToInstance(SearchDto, { query: 'q', maxResults: 1 });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts maxResults at the upper boundary (50)', async () => {
            const dto = plainToInstance(SearchDto, { query: 'q', maxResults: 50 });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects maxResults below 1 via @Min(1)', async () => {
            const dto = plainToInstance(SearchDto, { query: 'q', maxResults: 0 });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'maxResults').min).toBeDefined();
        });

        it('rejects maxResults above 50 via @Max(50)', async () => {
            const dto = plainToInstance(SearchDto, { query: 'q', maxResults: 51 });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'maxResults').max).toBeDefined();
        });

        it('rejects non-numeric maxResults via @IsNumber', async () => {
            const dto = plainToInstance(SearchDto, {
                query: 'q',
                maxResults: 'ten' as unknown as number,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'maxResults').isNumber).toBeDefined();
        });
    });

    describe('includeDomains / excludeDomains', () => {
        it('accepts an empty array for either field', async () => {
            const dto = plainToInstance(SearchDto, {
                query: 'q',
                includeDomains: [],
                excludeDomains: [],
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects a non-array includeDomains via @IsArray', async () => {
            const dto = plainToInstance(SearchDto, {
                query: 'q',
                includeDomains: 'github.com' as unknown as string[],
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'includeDomains').isArray).toBeDefined();
        });

        it('rejects a non-string element in includeDomains via @IsString({each:true})', async () => {
            const dto = plainToInstance(SearchDto, {
                query: 'q',
                includeDomains: ['github.com', 42 as unknown as string],
            });
            const errs = await validate(dto);
            // The error is reported at the array property w/ children for each invalid index.
            const includeErr = errs.find((e) => e.property === 'includeDomains');
            expect(includeErr).toBeDefined();
        });

        it('rejects a non-string element in excludeDomains via @IsString({each:true})', async () => {
            const dto = plainToInstance(SearchDto, {
                query: 'q',
                excludeDomains: [99 as unknown as string],
            });
            const errs = await validate(dto);
            const excludeErr = errs.find((e) => e.property === 'excludeDomains');
            expect(excludeErr).toBeDefined();
        });
    });
});

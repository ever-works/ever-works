import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateActiveScopeDto } from './update-active-scope.dto';

describe('UpdateActiveScopeDto', () => {
    it('accepts and trims a valid Organization slug', async () => {
        const dto = plainToInstance(UpdateActiveScopeDto, { organizationSlug: '  ever  ' });

        await expect(validate(dto)).resolves.toHaveLength(0);
        expect(dto.organizationSlug).toBe('ever');
    });

    it('accepts explicit null for personal/bare-Tenant scope', async () => {
        const dto = plainToInstance(UpdateActiveScopeDto, { organizationSlug: null });

        await expect(validate(dto)).resolves.toHaveLength(0);
    });

    it('rejects an omitted selection', async () => {
        const dto = plainToInstance(UpdateActiveScopeDto, {});

        await expect(validate(dto)).resolves.not.toHaveLength(0);
    });

    it.each(['', 'Ever', '-ever', 'ever-', 'ever works'])(
        'rejects invalid slug %j',
        async (slug) => {
            const dto = plainToInstance(UpdateActiveScopeDto, { organizationSlug: slug });

            await expect(validate(dto)).resolves.not.toHaveLength(0);
        },
    );
});

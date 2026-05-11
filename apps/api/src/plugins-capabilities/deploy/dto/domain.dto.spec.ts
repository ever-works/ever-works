import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AddDomainDto } from './domain.dto';

const constraintsFor = (
    errs: { property: string; constraints?: Record<string, string> }[],
    property: string,
) => errs.find((e) => e.property === property)?.constraints ?? {};

describe('plugins-capabilities/deploy AddDomainDto validation', () => {
    it('accepts a simple two-label domain', async () => {
        const dto = plainToInstance(AddDomainDto, { domain: 'example.com' });
        expect(await validate(dto)).toHaveLength(0);
    });

    it.each(['sub.example.com', 'a.b.c.example.com', 'foo-bar.example.io', 'example.museum'])(
        'accepts valid domain %s',
        async (domain) => {
            const dto = plainToInstance(AddDomainDto, { domain });
            expect(await validate(dto)).toHaveLength(0);
        },
    );

    it('rejects missing domain via @IsNotEmpty', async () => {
        const dto = plainToInstance(AddDomainDto, {});
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'domain').isNotEmpty).toBeDefined();
    });

    it('rejects empty-string domain via @IsNotEmpty', async () => {
        const dto = plainToInstance(AddDomainDto, { domain: '' });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'domain').isNotEmpty).toBeDefined();
    });

    it('rejects non-string domain via @IsString', async () => {
        const dto = plainToInstance(AddDomainDto, { domain: 42 as unknown as string });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'domain').isString).toBeDefined();
    });

    it.each([
        '-leading-dash.example.com',
        'trailing-dash-.example.com',
        'no-tld',
        '.startswithdot.com',
        'spaces in.com',
        'has_underscore.com',
        'http://example.com',
        'example.c',
    ])('rejects invalid domain format %s via @Matches', async (domain) => {
        const dto = plainToInstance(AddDomainDto, { domain });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'domain').matches).toBe(
            'Invalid domain format. Example: example.com',
        );
    });

    it('rejects single-label domain (no TLD) via @Matches', async () => {
        const dto = plainToInstance(AddDomainDto, { domain: 'localhost' });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'domain').matches).toBeDefined();
    });

    it('rejects double-dot in middle via @Matches', async () => {
        const dto = plainToInstance(AddDomainDto, { domain: 'foo..bar.com' });
        const errs = await validate(dto);
        expect(constraintsFor(errs, 'domain').matches).toBeDefined();
    });
});

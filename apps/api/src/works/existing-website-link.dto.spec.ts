import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ExistingWebsiteLinkDto, parseExistingWebsiteUrl } from './existing-website-link.dto';

describe('existing website URL contract', () => {
    it.each([
        ['https://ever.works', { url: 'https://ever.works', domain: 'ever.works' }],
        ['https://EVER.WORKS/', { url: 'https://ever.works', domain: 'ever.works' }],
    ])('accepts and canonicalizes a public root HTTPS URL: %s', (input, expected) => {
        expect(parseExistingWebsiteUrl(input)).toEqual(expected);
    });

    it.each([
        'http://ever.works',
        'https://user:secret@ever.works',
        'https://ever.works/docs',
        'https://ever.works/.',
        'https://ever.works//',
        'https://ever.works?',
        'https://ever.works#',
        'https://ever.works?preview=true',
        'https://ever.works#about',
        'https://ever.works:443',
        'https://ever.works:8443',
        'https://127.0.0.1',
        'https://[::1]',
        'https://2130706433',
        'https://localhost',
        'https://app.localhost',
        'https://service.internal',
        'https://printer.local',
        'https://single-label',
        'https://under_score.example',
        `https://${'a'.repeat(64)}.example`,
    ])('rejects a non-public or non-root URL: %s', (input) => {
        expect(() => parseExistingWebsiteUrl(input)).toThrow(BadRequestException);
    });

    it('participates in the API global validation contract', async () => {
        const pipe = new ValidationPipe({
            whitelist: true,
            transform: true,
            forbidNonWhitelisted: true,
        });

        await expect(
            pipe.transform(
                { url: 'http://ever.works' },
                { type: 'body', metatype: ExistingWebsiteLinkDto },
            ),
        ).rejects.toBeInstanceOf(BadRequestException);

        const dto = plainToInstance(ExistingWebsiteLinkDto, {
            url: 'https://EVER.WORKS/',
        });
        await expect(validate(dto)).resolves.toHaveLength(0);
        expect(dto.url).toBe('https://EVER.WORKS/');
    });
});

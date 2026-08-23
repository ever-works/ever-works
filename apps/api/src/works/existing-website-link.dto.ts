import { isIP } from 'node:net';
import { BadRequestException } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, ValidateBy } from 'class-validator';

export interface ParsedExistingWebsiteUrl {
    url: string;
    domain: string;
}

const MAX_URL_LENGTH = 2_048;
const MAX_HOST_LENGTH = 253;
const BLOCKED_HOST_SUFFIXES = [
    'localhost',
    'local',
    'internal',
    'lan',
    'home',
    'home.arpa',
    'test',
    'invalid',
    'example',
] as const;

function invalidExistingWebsiteUrl(): never {
    throw new BadRequestException({
        status: 'error',
        message:
            'url must be a public root HTTPS URL without credentials, a port, path, query, or fragment',
    });
}

/**
 * Parse the passive website-link contract without doing DNS or network I/O.
 * The endpoint stores this URL; it never fetches or deploys it.
 */
export function parseExistingWebsiteUrl(value: unknown): ParsedExistingWebsiteUrl {
    if (typeof value !== 'string') {
        return invalidExistingWebsiteUrl();
    }

    const input = value.trim();
    if (!input || input.length > MAX_URL_LENGTH || !/^https:\/\//i.test(input)) {
        return invalidExistingWebsiteUrl();
    }
    // URL canonicalization erases an explicit default `:443`, so inspect
    // the raw authority to enforce the contract's no-port rule.
    const remainder = input.slice('https://'.length);
    const suffixStart = remainder.search(/[/?#\\]/);
    const authority = suffixStart === -1 ? remainder : remainder.slice(0, suffixStart);
    const suffix = suffixStart === -1 ? '' : remainder.slice(suffixStart);
    if (!authority || authority.includes(':') || (suffix !== '' && suffix !== '/')) {
        return invalidExistingWebsiteUrl();
    }

    let parsed: URL;
    try {
        parsed = new URL(input);
    } catch {
        return invalidExistingWebsiteUrl();
    }

    if (
        parsed.protocol !== 'https:' ||
        parsed.username !== '' ||
        parsed.password !== '' ||
        parsed.port !== '' ||
        parsed.pathname !== '/' ||
        parsed.search !== '' ||
        parsed.hash !== ''
    ) {
        return invalidExistingWebsiteUrl();
    }

    const domain = parsed.hostname.toLowerCase();
    const ipCandidate =
        domain.startsWith('[') && domain.endsWith(']') ? domain.slice(1, -1) : domain;
    if (
        !domain ||
        domain.length > MAX_HOST_LENGTH ||
        domain.endsWith('.') ||
        isIP(ipCandidate) !== 0
    ) {
        return invalidExistingWebsiteUrl();
    }

    const labels = domain.split('.');
    const topLevelDomain = labels.at(-1) ?? '';
    if (
        labels.length < 2 ||
        labels.some(
            (label) =>
                label.length === 0 ||
                label.length > 63 ||
                !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
        ) ||
        !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(topLevelDomain) ||
        BLOCKED_HOST_SUFFIXES.some((suffix) => domain === suffix || domain.endsWith(`.${suffix}`))
    ) {
        return invalidExistingWebsiteUrl();
    }

    return {
        url: `https://${domain}`,
        domain,
    };
}

const IsPublicRootHttpsUrl = () =>
    ValidateBy({
        name: 'isPublicRootHttpsUrl',
        validator: {
            validate: (value: unknown): boolean => {
                try {
                    parseExistingWebsiteUrl(value);
                    return true;
                } catch {
                    return false;
                }
            },
            defaultMessage: () =>
                'url must be a public root HTTPS URL without credentials, a port, path, query, or fragment',
        },
    });

export class ExistingWebsiteLinkDto {
    @ApiProperty({
        example: 'https://ever.works',
        format: 'uri',
        description: 'Existing public root HTTPS website URL to link without deployment.',
    })
    @IsString()
    @MaxLength(MAX_URL_LENGTH)
    @IsPublicRootHttpsUrl()
    url: string;
}

export class ExistingWebsiteLinkResponseDto {
    @ApiProperty({ format: 'uuid' })
    workId: string;

    @ApiProperty({ example: 'https://ever.works' })
    url: string;

    @ApiProperty({ example: 'ever.works' })
    domain: string;

    @ApiProperty({ description: 'Whether this request created the domain relation.' })
    created: boolean;

    @ApiProperty({ description: 'Existing verification state; this API performs no verification.' })
    verified: boolean;
}

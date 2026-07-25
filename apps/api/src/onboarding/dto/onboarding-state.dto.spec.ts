import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';

import { OnboardingStatePatchBodyDto } from './onboarding-state.dto';

/**
 * Wave 11 — DTO validation for the "What do you do" profile answers on
 * `PATCH /api/onboarding/state`. Mirrors the global ValidationPipe
 * posture (whitelist + forbidNonWhitelisted) so the unknown-field
 * rejection matches what the API actually returns.
 */

const VALIDATOR_OPTIONS = { whitelist: true, forbidNonWhitelisted: true } as const;

function toDto(body: unknown): OnboardingStatePatchBodyDto {
    return plainToInstance(OnboardingStatePatchBodyDto, body);
}

/** Flatten nested ValidationErrors into constraint-message strings. */
function flattenMessages(errors: ValidationError[]): string[] {
    const out: string[] = [];
    for (const error of errors) {
        if (error.constraints) out.push(...Object.values(error.constraints));
        if (error.children?.length) out.push(...flattenMessages(error.children));
    }
    return out;
}

describe('OnboardingStatePatchBodyDto — Wave 11 profile', () => {
    it('accepts a valid profile with roles + teamSize', async () => {
        const dto = toDto({
            state: { profile: { roles: ['marketing', 'founder-ceo'], teamSize: 'solo' } },
        });
        expect(await validate(dto, VALIDATOR_OPTIONS)).toHaveLength(0);
    });

    it('accepts a roles-only profile, a teamSize-only profile, and every catalog role at once', async () => {
        expect(
            await validate(
                toDto({ state: { profile: { roles: ['engineering'] } } }),
                VALIDATOR_OPTIONS,
            ),
        ).toHaveLength(0);
        expect(
            await validate(
                toDto({ state: { profile: { teamSize: 'enterprise-200-plus' } } }),
                VALIDATOR_OPTIONS,
            ),
        ).toHaveLength(0);
        const allRoles = [
            'founder-ceo',
            'engineering',
            'product',
            'marketing',
            'sales',
            'consultant',
            'research',
            'operations',
            'support',
            'finance',
            'hr',
            'legal',
            'education',
            'other',
        ];
        expect(
            await validate(toDto({ state: { profile: { roles: allRoles } } }), VALIDATOR_OPTIONS),
        ).toHaveLength(0);
    });

    it('rejects unrecognised role ids (drop-if-unrecognised is a read rule; writes 400)', async () => {
        const errors = await validate(
            toDto({ state: { profile: { roles: ['marketing', 'astronaut'] } } }),
            VALIDATOR_OPTIONS,
        );
        expect(flattenMessages(errors).join('\n')).toContain('must be one of the following values');
    });

    it('rejects an unrecognised teamSize id', async () => {
        const errors = await validate(
            toDto({ state: { profile: { teamSize: 'galactic' } } }),
            VALIDATOR_OPTIONS,
        );
        expect(flattenMessages(errors).join('\n')).toContain('must be one of the following values');
    });

    it('rejects non-whitelisted keys inside profile', async () => {
        const errors = await validate(
            toDto({ state: { profile: { roles: ['sales'], bogusField: true } } }),
            VALIDATOR_OPTIONS,
        );
        expect(flattenMessages(errors).join('\n')).toContain('should not exist');
    });

    it('still accepts a patch without profile (additive change)', async () => {
        const dto = toDto({ state: { lastStep: 3, ai: { choice: 'openrouter' } } });
        expect(await validate(dto, VALIDATOR_OPTIONS)).toHaveLength(0);
    });
});

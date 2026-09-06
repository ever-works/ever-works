import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ClaimSentryBindingDto } from './sentry-binding.dto';

const UUID = '5f6e4d3c-2b1a-4c9d-8e7f-0a1b2c3d4e5f';

const build = (input: Record<string, unknown>) => plainToInstance(ClaimSentryBindingDto, input);

describe('ClaimSentryBindingDto', () => {
    it('accepts a uuid with an optional label', async () => {
        expect(await validate(build({ installationUuid: UUID, label: 'ever-co' }))).toHaveLength(0);
        expect(await validate(build({ installationUuid: UUID }))).toHaveLength(0);
    });

    it('rejects a missing or malformed installation uuid', async () => {
        const missing = await validate(build({}));
        expect(missing.map((e) => e.property)).toEqual(['installationUuid']);
        const malformed = await validate(build({ installationUuid: 'installation:evil' }));
        expect(malformed.map((e) => e.property)).toEqual(['installationUuid']);
        expect(malformed[0].constraints).toHaveProperty('isUuid');
    });

    it('rejects a label over 200 characters or of the wrong type', async () => {
        const long = await validate(build({ installationUuid: UUID, label: 'x'.repeat(201) }));
        expect(long.map((e) => e.property)).toEqual(['label']);
        expect(long[0].constraints).toHaveProperty('maxLength');
        const wrongType = await validate(build({ installationUuid: UUID, label: 42 }));
        expect(wrongType.map((e) => e.property)).toEqual(['label']);
    });
});

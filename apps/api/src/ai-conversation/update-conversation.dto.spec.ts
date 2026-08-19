jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/facades', () => ({}));

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateConversationDto } from './conversation.controller';

/**
 * `PATCH /api/conversations/:id` — null must not pass for a string field.
 *
 * The defect this pins: `@IsOptional()` skips every other validator when the
 * value is `null` as well as when it is `undefined` (class-validator's
 * condition is `value !== null && value !== undefined`). So
 * `PATCH {"title": null}` passed validation, then satisfied the handler's
 * `body.title !== undefined` guard — because `null !== undefined` — and
 * WROTE NULL over the user's title.
 *
 * It was a hard 400 before the field became optional in #2103, and the DTO's
 * own docblock still asserted that "the field is typed `string` so the
 * whitelist keeps rejecting non-string payloads". It did not.
 *
 * Nothing in the E2E suite covered it either, because those specs probe the
 * empty body `{}` rather than an explicit null.
 */
const errorsFor = (payload: Record<string, unknown>) =>
    validateSync(plainToInstance(UpdateConversationDto, payload), {
        whitelist: true,
        forbidNonWhitelisted: true,
    });

const failedProps = (payload: Record<string, unknown>) => errorsFor(payload).map((e) => e.property);

describe('UpdateConversationDto', () => {
    describe('control — the shapes that must stay valid', () => {
        it('accepts an empty body (both fields optional; the handler no-ops)', () => {
            // If this failed, every rejection below would be meaningless: a DTO
            // that rejects everything trivially "fixes" the null case too.
            expect(errorsFor({})).toHaveLength(0);
        });

        it('accepts a title-only update', () => {
            expect(errorsFor({ title: 'Renamed' })).toHaveLength(0);
        });

        it('accepts a model-only update, and the clear-the-pin empty string', () => {
            expect(errorsFor({ model: 'gpt-4' })).toHaveLength(0);
            // '' is the documented signal for "resolve the provider default".
            expect(errorsFor({ model: '' })).toHaveLength(0);
        });

        it('accepts both together', () => {
            expect(errorsFor({ title: 'Renamed', model: 'gpt-4' })).toHaveLength(0);
        });
    });

    describe('🛑 null is not absent', () => {
        it('REJECTS { title: null } instead of nulling the title', () => {
            expect(failedProps({ title: null })).toContain('title');
        });

        it('REJECTS { model: null }', () => {
            // Harmless in the handler today — null coincides with the
            // clear-the-pin branch — but the documented contract says
            // non-string payloads are rejected, so they are.
            expect(failedProps({ model: null })).toContain('model');
        });

        it('rejects null even when the other field is a valid string', () => {
            // The realistic shape: a client sends the whole form back with one
            // field blanked to null.
            expect(failedProps({ title: null, model: 'gpt-4' })).toContain('title');
        });
    });

    describe('the type and length gates still hold', () => {
        it('rejects a non-string title', () => {
            expect(failedProps({ title: 12345 })).toContain('title');
        });

        it('rejects a title over 200 characters', () => {
            expect(failedProps({ title: 'Z'.repeat(201) })).toContain('title');
        });

        it('rejects a model over 100 characters', () => {
            expect(failedProps({ model: 'z'.repeat(101) })).toContain('model');
        });

        it('still rejects providerId — the thread identity is immutable', () => {
            // Not on the whitelist, and forbidNonWhitelisted makes that a 400
            // rather than a silent drop.
            expect(failedProps({ providerId: 'openai' })).toContain('providerId');
        });
    });
});

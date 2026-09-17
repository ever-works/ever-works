import { describe, expect, it } from 'vitest';

import { prefillFromSearchParams } from './register-prefill';

/**
 * The query ever.co/checkout/complete hands the register page.
 *
 * The form locks the email field whenever a prefilled email is present, so the
 * cases that matter are the ones that would lock it with nothing usable in it.
 */
describe('register prefill from the checkout query', () => {
    it('passes a name and email through', () => {
        expect(prefillFromSearchParams({ email: 'buyer@example.com', name: 'Jane Buyer' })).toEqual(
            { email: 'buyer@example.com', name: 'Jane Buyer' },
        );
    });

    it('control: an absent query yields no prefill at all', () => {
        expect(prefillFromSearchParams({})).toEqual({ email: undefined, name: undefined });
    });

    it('trims surrounding whitespace', () => {
        expect(prefillFromSearchParams({ email: '  buyer@example.com ', name: ' Jane ' })).toEqual({
            email: 'buyer@example.com',
            name: 'Jane',
        });
    });

    it('treats an empty or blank value as absent, so the email is not locked blank', () => {
        expect(prefillFromSearchParams({ email: '', name: '   ' })).toEqual({
            email: undefined,
            name: undefined,
        });
    });

    it('ignores a repeated parameter rather than guessing which one was meant', () => {
        expect(
            prefillFromSearchParams({
                email: ['a@example.com', 'b@example.com'],
                name: ['A', 'B'],
            }),
        ).toEqual({ email: undefined, name: undefined });
    });
});

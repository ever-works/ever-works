import { getErrorMessage, getErrorStack } from '../error.util';

describe('getErrorMessage', () => {
    it('returns Error.message verbatim for an Error instance', () => {
        expect(getErrorMessage(new Error('boom'))).toBe('boom');
    });

    it('returns the message of subclassed Errors (TypeError, RangeError, etc.)', () => {
        expect(getErrorMessage(new TypeError('bad type'))).toBe('bad type');
        expect(getErrorMessage(new RangeError('out of range'))).toBe('out of range');
    });

    it('returns empty string for an Error with no message', () => {
        // new Error() defaults message to ''
        expect(getErrorMessage(new Error())).toBe('');
    });

    it('coerces strings via String() (already a string but exercise the branch)', () => {
        expect(getErrorMessage('plain string')).toBe('plain string');
    });

    it('coerces numbers, booleans, null, undefined via String()', () => {
        expect(getErrorMessage(42)).toBe('42');
        expect(getErrorMessage(true)).toBe('true');
        expect(getErrorMessage(false)).toBe('false');
        expect(getErrorMessage(null)).toBe('null');
        expect(getErrorMessage(undefined)).toBe('undefined');
    });

    it('coerces plain objects via String() to "[object Object]"', () => {
        // Pinned: this is the documented behaviour of String(plainObject).
        // Callers that need structured logging should JSON.stringify themselves.
        expect(getErrorMessage({ code: 'E_FOO' })).toBe('[object Object]');
    });

    it('honors objects with a custom toString()', () => {
        const obj = { toString: () => 'custom message' };
        expect(getErrorMessage(obj)).toBe('custom message');
    });

    it('subclasses with a custom message are still treated as Error (instanceof check)', () => {
        class CustomError extends Error {}
        expect(getErrorMessage(new CustomError('custom'))).toBe('custom');
    });

    it('coerces arrays via String() (joined comma-separated)', () => {
        expect(getErrorMessage(['a', 'b'])).toBe('a,b');
    });
});

describe('getErrorStack', () => {
    it('returns Error.stack for an Error instance', () => {
        const err = new Error('boom');
        const stack = getErrorStack(err);
        expect(stack).toBeDefined();
        // Stack typically starts with 'Error: boom' on V8.
        expect(typeof stack).toBe('string');
        expect(stack).toContain('Error: boom');
    });

    it('returns undefined for non-Error inputs (no String() coercion fallback)', () => {
        expect(getErrorStack('string')).toBeUndefined();
        expect(getErrorStack(42)).toBeUndefined();
        expect(getErrorStack(null)).toBeUndefined();
        expect(getErrorStack(undefined)).toBeUndefined();
        expect(getErrorStack({ stack: 'fake-stack' })).toBeUndefined();
        expect(getErrorStack([])).toBeUndefined();
    });

    it('returns undefined for an Error explicitly stripped of stack', () => {
        // Some test harnesses or sandboxes produce Errors without a .stack property.
        // Pinned so the function does not throw on the access.
        const err = new Error('no stack');
        Object.defineProperty(err, 'stack', { value: undefined });
        expect(getErrorStack(err)).toBeUndefined();
    });

    it('returns the Error.stack of subclassed Errors', () => {
        class CustomError extends Error {}
        const err = new CustomError('custom');
        const stack = getErrorStack(err);
        expect(typeof stack).toBe('string');
        expect(stack).toContain('custom');
    });
});

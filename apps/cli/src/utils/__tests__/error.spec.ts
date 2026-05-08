import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleCliError } from '../error';

describe('handleCliError', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        errorSpy.mockRestore();
        logSpy.mockRestore();
    });

    it('handles null/undefined error with a generic prefix and emits no follow-up hint', () => {
        handleCliError(null);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls[0][0]).toContain('An error occurred');
        // no second-line hint because we have no status code to dispatch on
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('handles a plain string error by passing it through as the second console.error arg', () => {
        handleCliError('boom');
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls[0][1]).toBe('boom');
    });

    it('prefers response.data.message over error.message when both exist', () => {
        const err = {
            response: { status: 500, data: { message: 'server boom' } },
            message: 'fallback',
        };
        handleCliError(err);
        expect(errorSpy.mock.calls[0][1]).toBe('server boom');
    });

    it('falls back to error.message when response.data.message is missing', () => {
        const err = { response: { status: 500 }, message: 'fallback only' };
        handleCliError(err);
        expect(errorSpy.mock.calls[0][1]).toBe('fallback only');
    });

    it('falls back to String(error) when neither message field is present', () => {
        // a non-Error error object with no message and no response.data.message
        const err = { response: { status: 500 } };
        handleCliError(err);
        // String([object Object]) is what we expect — the helper does `error.message || error`
        // and then String()-coerces it
        expect(errorSpy.mock.calls[0][1]).toBe(String(err));
    });

    it('emits the auth-failed login hint on HTTP 401', () => {
        handleCliError({ response: { status: 401 }, message: 'unauthorized' });
        expect(logSpy).toHaveBeenCalledTimes(2);
        expect(logSpy.mock.calls[0][0]).toContain('Authentication failed');
        expect(logSpy.mock.calls[1][0]).toContain('ever-works auth login');
    });

    it('emits the work-not-found hint on 404 when message contains "work"', () => {
        handleCliError({
            response: { status: 404, data: { message: 'Work not found' } },
        });
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy.mock.calls[0][0]).toContain('Work not found');
    });

    it('case-insensitively matches "work" in the message', () => {
        handleCliError({
            response: { status: 404, data: { message: 'WORK does not exist' } },
        });
        expect(logSpy.mock.calls[0][0]).toContain('Work not found');
    });

    it('emits the generic resource-not-found hint on 404 when message lacks "work"', () => {
        handleCliError({
            response: { status: 404, data: { message: 'Plugin not found' } },
        });
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy.mock.calls[0][0]).toContain('Resource not found');
    });

    it('emits no hint for non-401/404 statuses', () => {
        handleCliError({ response: { status: 500 }, message: 'oops' });
        expect(logSpy).not.toHaveBeenCalled();
    });
});

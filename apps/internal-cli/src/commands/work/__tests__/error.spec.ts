import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleCliError } from '../error';

describe('handleCliError', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;
    let logSpy: ReturnType<typeof vi.spyOn>;
    const originalDebug = process.env.DEBUG_CLI;

    beforeEach(() => {
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        errorSpy.mockRestore();
        logSpy.mockRestore();
        if (originalDebug === undefined) delete process.env.DEBUG_CLI;
        else process.env.DEBUG_CLI = originalDebug;
    });

    it('prints only the header when error is null/undefined/false', () => {
        handleCliError(null);
        handleCliError(undefined);
        handleCliError(false);
        expect(errorSpy).toHaveBeenCalledTimes(3);
        for (const call of errorSpy.mock.calls) {
            // The header is rendered via chalk.red — strip ANSI for the assertion.
            // eslint-disable-next-line no-control-regex
            const stripped = String(call[0]).replace(/\x1b\[[0-9;]*m/g, '');
            expect(stripped).toContain('An error occurred');
        }
    });

    it('honors a custom messageHeader argument', () => {
        handleCliError(null, 'Custom header');
        // eslint-disable-next-line no-control-regex
        const stripped = String(errorSpy.mock.calls[0][0]).replace(/\x1b\[[0-9;]*m/g, '');
        expect(stripped).toContain('Custom header');
    });

    it('prints "header: <string>" when error is a string', () => {
        handleCliError('boom', 'Failed');
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const callArgs = errorSpy.mock.calls[0];
        // eslint-disable-next-line no-control-regex
        const header = String(callArgs[0]).replace(/\x1b\[[0-9;]*m/g, '');
        expect(header).toContain('Failed');
        expect(callArgs[1]).toBe('boom');
    });

    it('extracts message from response.data.message when available', () => {
        const error = {
            response: { status: 500, data: { message: 'Internal server error' } },
        };
        handleCliError(error);
        // The second argument of the second console.error call carries the message.
        const messageArg = errorSpy.mock.calls[0][1];
        expect(messageArg).toBe('Internal server error');
    });

    it('falls back to error.message when response.data.message is missing', () => {
        const error = { message: 'Custom error', response: { status: 500 } };
        handleCliError(error);
        expect(errorSpy.mock.calls[0][1]).toBe('Custom error');
    });

    it('logs the full error object when DEBUG_CLI=true', () => {
        process.env.DEBUG_CLI = 'true';
        const error = new Error('debug-this');
        handleCliError(error);
        // The first console.error call should be the raw error object
        expect(errorSpy.mock.calls[0][0]).toBe(error);
    });

    it('does NOT log the raw error when DEBUG_CLI is not "true"', () => {
        process.env.DEBUG_CLI = 'false';
        const error = new Error('hidden');
        handleCliError(error);
        // Only one error call: the formatted message line
        expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('shows git-provider tip when message includes "Owner is required"', () => {
        const error = new Error('Owner is required for this op');
        handleCliError(error);
        expect(logSpy).toHaveBeenCalled();
        const logged = logSpy.mock.calls
            .map((c) => String(c[0]))
            // eslint-disable-next-line no-control-regex
            .map((s) => s.replace(/\x1b\[[0-9;]*m/g, ''))
            .join('\n');
        expect(logged).toContain('Make sure your git provider configuration is set up correctly');
    });

    it('shows work-not-found tip when status===404 and message mentions work', () => {
        const error = {
            message: 'Work xyz not found',
            response: { status: 404 },
        };
        handleCliError(error);
        const logged = logSpy.mock.calls
            .map((c) => String(c[0]))
            // eslint-disable-next-line no-control-regex
            .map((s) => s.replace(/\x1b\[[0-9;]*m/g, ''))
            .join('\n');
        expect(logged).toContain('Work not found');
    });

    it('shows resource-not-found tip when status===404 and message does NOT mention work', () => {
        const error = {
            message: 'Item xyz not found',
            response: { status: 404 },
        };
        handleCliError(error);
        const logged = logSpy.mock.calls
            .map((c) => String(c[0]))
            // eslint-disable-next-line no-control-regex
            .map((s) => s.replace(/\x1b\[[0-9;]*m/g, ''))
            .join('\n');
        expect(logged).toContain('Resource not found');
    });

    it('prints message via String() when error is a primitive (e.g. number)', () => {
        handleCliError(42 as unknown as Error);
        // 42 is truthy, so we go through the data/message extraction branch and print '42'.
        expect(errorSpy.mock.calls[0][1]).toBe('42');
    });
});

// Mock the agent facades barrel so importing the filter doesn't pull the
// real facade runtime (TypeORM / plugin registry / NestJS wiring). The
// filter only references `FacadeError` for its `@Catch()` decorator and
// reads duck-typed fields off the thrown error, so a bare stand-in class
// is enough. Mirrors work-repo-resolver.service.spec.ts.
jest.mock('@ever-works/agent/facades', () => ({
    FacadeError: class FacadeError extends Error {},
}));

import { HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { FacadeExceptionFilter } from './facade-exception.filter';

/** A minimal FacadeError-shaped object — the filter only reads these fields. */
function facadeError(name: string, message = `${name} happened`) {
    return Object.assign(new Error(message), {
        name,
        operation: 'getPlugin',
        provider: 'github',
    });
}

describe('FacadeExceptionFilter', () => {
    let filter: FacadeExceptionFilter;
    let reply: jest.Mock;
    let host: ArgumentsHost;

    beforeEach(() => {
        reply = jest.fn();
        const httpAdapterHost = {
            httpAdapter: {
                reply,
                getRequestMethod: () => 'POST',
                getRequestUrl: () => '/api/templates/fork',
            },
        } as unknown as HttpAdapterHost;
        filter = new FacadeExceptionFilter(httpAdapterHost);

        host = {
            switchToHttp: () => ({
                getRequest: () => ({}),
                getResponse: () => ({ res: true }),
            }),
        } as unknown as ArgumentsHost;

        // Silence the error-level log the 500 path emits.
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => jest.restoreAllMocks());

    const lastBody = () => reply.mock.calls[0][1];
    const lastStatus = () => reply.mock.calls[0][2];

    it.each([
        ['NoGitProviderError', HttpStatus.CONFLICT],
        ['NoProviderError', HttpStatus.CONFLICT],
        ['NoDeployProviderError', HttpStatus.CONFLICT],
        ['NoOAuthProviderError', HttpStatus.CONFLICT],
        ['NoContentExtractorProviderError', HttpStatus.CONFLICT],
        ['NoGitCredentialsError', HttpStatus.CONFLICT],
        ['NoDeployCredentialsError', HttpStatus.CONFLICT],
        ['ProviderNotFoundError', HttpStatus.NOT_FOUND],
        ['GitProviderNotFoundError', HttpStatus.NOT_FOUND],
        ['DeployProviderNotFoundError', HttpStatus.NOT_FOUND],
        ['OAuthProviderNotFoundError', HttpStatus.NOT_FOUND],
        ['ContentExtractorProviderNotFoundError', HttpStatus.NOT_FOUND],
        ['OAuthNotSupportedError', HttpStatus.BAD_REQUEST],
    ])('maps %s → %d and surfaces the (safe) facade message', (name, status) => {
        filter.catch(facadeError(name) as never, host);
        expect(lastStatus()).toBe(status);
        expect(lastBody()).toEqual({
            statusCode: status,
            message: `${name} happened`,
            error: name,
        });
    });

    it('falls through to 500 for a generic facade wrapper AND hides the internal message', () => {
        filter.catch(
            facadeError('AiFacadeError', 'upstream model 503 with secret detail') as never,
            host,
        );
        expect(lastStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
        // Critical: the original message must NOT leak — Nest's default
        // filter would have hidden it, and we preserve that.
        expect(lastBody()).toEqual({
            statusCode: 500,
            message: 'Internal server error',
            error: 'Internal Server Error',
        });
    });

    it('logs unmapped (500) facade errors with operation/provider context', () => {
        const spy = jest.spyOn(Logger.prototype, 'error');
        filter.catch(facadeError('SearchFacadeError', 'boom') as never, host);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(String(spy.mock.calls[0][0])).toContain('SearchFacadeError');
        expect(String(spy.mock.calls[0][0])).toContain('op=getPlugin');
    });

    it('does NOT log the mapped 4xx cases (they are expected, caller-actionable)', () => {
        const spy = jest.spyOn(Logger.prototype, 'error');
        filter.catch(facadeError('NoGitProviderError') as never, host);
        expect(spy).not.toHaveBeenCalled();
    });

    it('treats an unknown FacadeError name as a 500 (conservative default)', () => {
        filter.catch(facadeError('SomeBrandNewFacadeError', 'leak me') as never, host);
        expect(lastStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
        expect(lastBody().message).toBe('Internal server error');
    });
});

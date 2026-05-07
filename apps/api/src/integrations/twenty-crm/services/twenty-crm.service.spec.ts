import { HttpException, HttpStatus } from '@nestjs/common';
import type { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { TwentyCrmService } from './twenty-crm.service';
import type { CrmConfigService } from '../config/crm-config.service';

const buildConfig = (overrides: Partial<{
    apiUrl: string;
    apiKey: string;
    workspaceId: string;
    timeout: number;
}> = {}) => ({
    twentyCrmConfig: {
        apiUrl: 'https://crm.example.com',
        apiKey: 'secret',
        workspaceId: 'ws-1',
        timeout: 30000,
        retryAttempts: 3,
        retryDelay: 1000,
        ...overrides,
    },
});

describe('TwentyCrmService.makeRequest', () => {
    let httpService: { request: jest.Mock };
    let configService: CrmConfigService;
    let service: TwentyCrmService;

    beforeEach(() => {
        httpService = { request: jest.fn() };
        configService = buildConfig() as unknown as CrmConfigService;
        service = new TwentyCrmService(
            httpService as unknown as HttpService,
            configService,
        );
        jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    });

    it('issues the HTTP call against `${apiUrl}/rest<endpoint>` with bearer auth + workspace header + timeout', async () => {
        httpService.request.mockReturnValue(of({ data: { ok: 1 } }));

        const result = await service.makeRequest('GET', '/companies', undefined, { foo: 1 });

        expect(httpService.request).toHaveBeenCalledTimes(1);
        const callArgs = httpService.request.mock.calls[0][0];
        expect(callArgs).toEqual({
            method: 'GET',
            url: 'https://crm.example.com/rest/companies',
            headers: {
                Authorization: 'Bearer secret',
                'Content-Type': 'application/json',
                'X-Workspace-Id': 'ws-1',
            },
            data: undefined,
            params: { foo: 1 },
            timeout: 30000,
        });
        expect(result).toEqual({ ok: 1 });
    });

    it('routes to `${apiUrl}/rest/metadata<endpoint>` when schema=true', async () => {
        httpService.request.mockReturnValue(of({ data: { schema: true } }));

        await service.makeRequest('GET', '/objects', undefined, undefined, true);

        expect(httpService.request).toHaveBeenCalledWith(
            expect.objectContaining({
                url: 'https://crm.example.com/rest/metadata/objects',
            }),
        );
    });

    it('falls back to "default" workspace id when none is configured', async () => {
        configService = buildConfig({ workspaceId: undefined as any }) as unknown as CrmConfigService;
        service = new TwentyCrmService(
            httpService as unknown as HttpService,
            configService,
        );
        jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
        httpService.request.mockReturnValue(of({ data: 'ok' }));

        await service.makeRequest('GET', '/companies');

        const callArgs = httpService.request.mock.calls[0][0];
        expect(callArgs.headers['X-Workspace-Id']).toBe('default');
    });

    it('forwards POST/PUT bodies via `data`', async () => {
        httpService.request.mockReturnValue(of({ data: { id: '1' } }));

        await service.makeRequest('POST', '/companies', { name: 'Acme' });

        expect(httpService.request).toHaveBeenCalledWith(
            expect.objectContaining({
                method: 'POST',
                data: { name: 'Acme' },
            }),
        );
    });

    it('rethrows upstream API errors as HttpException carrying the upstream message + status + details', async () => {
        const upstream = {
            response: {
                status: 422,
                data: {
                    message: 'Validation failed',
                    statusCode: 422,
                    details: [{ field: 'email', code: 'invalid' }],
                },
            },
            message: 'Request failed with status 422',
        };
        httpService.request.mockReturnValue(throwError(() => upstream));

        await expect(service.makeRequest('POST', '/contacts', {})).rejects.toMatchObject({
            status: 422,
            response: {
                message: 'Validation failed',
                details: [{ field: 'email', code: 'invalid' }],
            },
        });
    });

    it('falls back to a "Twenty CRM API error" message when upstream omits one', async () => {
        const upstream = {
            response: {
                status: 400,
                data: { statusCode: 400, details: { foo: 'bar' } },
            },
            message: 'bad request',
        };
        httpService.request.mockReturnValue(throwError(() => upstream));

        await expect(service.makeRequest('POST', '/x', {})).rejects.toMatchObject({
            status: 400,
            response: {
                message: 'Twenty CRM API error',
                details: { foo: 'bar' },
            },
        });
    });

    it('uses INTERNAL_SERVER_ERROR when upstream provides body but no status', async () => {
        const upstream = {
            response: {
                data: { message: 'oops' },
            },
            message: 'oops',
        };
        httpService.request.mockReturnValue(throwError(() => upstream));

        await expect(service.makeRequest('GET', '/x')).rejects.toMatchObject({
            status: HttpStatus.INTERNAL_SERVER_ERROR,
        });
    });

    it('throws SERVICE_UNAVAILABLE when the error has no `response.data` (network error path)', async () => {
        const networkErr = { message: 'ECONNREFUSED' };
        httpService.request.mockReturnValue(throwError(() => networkErr));

        await expect(service.makeRequest('GET', '/companies')).rejects.toBeInstanceOf(
            HttpException,
        );
        await expect(service.makeRequest('GET', '/companies')).rejects.toMatchObject({
            status: HttpStatus.SERVICE_UNAVAILABLE,
        });
    });
});

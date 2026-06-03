import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { CrmConfigService } from '../config/crm-config.service';

export interface TwentyApiResponse<T = any> {
    data: T;
    meta?: {
        totalCount?: number;
        hasNextPage?: boolean;
        hasPreviousPage?: boolean;
    };
}

interface TwentyErrorResponse {
    message: string;
    statusCode: number;
    error?: string;
    details?: any;
}

@Injectable()
export class TwentyCrmService {
    private readonly logger = new Logger(TwentyCrmService.name);

    constructor(
        private readonly httpService: HttpService,
        private readonly configService: CrmConfigService,
    ) {}

    async makeRequest<T>(
        method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        endpoint: string,
        data?: any,
        params?: any,
        schema: boolean = false,
        // Security (cross-tenant IDOR fix): the request-scoped caller tenant id.
        // We resolve that tenant's OWN Twenty workspace credentials (option 1:
        // one workspace + API key per tenant) and authenticate the call with
        // them. Twenty scopes an API key to a single workspace, so a caller can
        // only ever read/write rows in their own workspace — without (and this
        // is the fix) relying on a `/tenants/{id}` URL prefix, which Twenty's
        // REST API does not support (`/rest/<object>` only) and would 404.
        // `undefined` keeps the default credentials for internal/system callers
        // (metadata/schema and sync paths that are NOT per-caller). The
        // companies/people controllers ALWAYS pass a non-empty tenant id.
        tenantId?: string,
    ): Promise<T> {
        // Resolve credentials OUTSIDE the try: a fail-closed refusal must not be
        // swallowed/re-wrapped by the catch block below.
        const config = this.configService.configForTenant(tenantId);
        if (!config) {
            // Fail closed: no per-tenant Twenty credentials for this caller. Do
            // NOT fall back to shared credentials (that would re-open the
            // cross-tenant IDOR). Surface as 404 to match the controllers'
            // no-leak missing-Tenant contract.
            this.logger.warn(
                `Refusing tenant-scoped Twenty CRM request: no credentials configured for tenant ${tenantId}`,
            );
            throw new HttpException('Twenty CRM records not found', HttpStatus.NOT_FOUND);
        }

        try {
            const apiRoot = `${config.apiUrl}/rest`;
            const url = schema ? `${apiRoot}/metadata${endpoint}` : `${apiRoot}${endpoint}`;

            this.logger.debug(`Making ${method} request to ${url}`);

            const response = await firstValueFrom(
                this.httpService.request({
                    method,
                    url,
                    headers: {
                        Authorization: `Bearer ${config.apiKey}`,
                        'Content-Type': 'application/json',
                        'X-Workspace-Id': config.workspaceId || 'default',
                    },
                    data,
                    params,
                    timeout: config.timeout,
                }),
            );

            return response.data;
        } catch (error) {
            this.logger.error(`Twenty CRM API error: ${error.message}`, {
                endpoint,
                method,
                status: error.response?.status,
                data: error.response?.data,
            });

            if (error.response?.data) {
                const errorData: TwentyErrorResponse = error.response.data;
                throw new HttpException(
                    {
                        message: errorData.message || 'Twenty CRM API error',
                        details: errorData.details,
                    },
                    error.response.status || HttpStatus.INTERNAL_SERVER_ERROR,
                );
            }

            throw new HttpException(
                'Failed to communicate with Twenty CRM',
                HttpStatus.SERVICE_UNAVAILABLE,
            );
        }
    }
}

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

    private get baseUrl() {
        const config = this.configService.twentyCrmConfig;
        return `${config.apiUrl}/rest`;
    }
    private get metadataUrl() {
        const config = this.configService.twentyCrmConfig;
        return `${config.apiUrl}/rest/metadata`;
    }

    private get headers() {
        const config = this.configService.twentyCrmConfig;
        return {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            'X-Workspace-Id': config.workspaceId || 'default',
        };
    }

    async makeRequest<T>(
        method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        endpoint: string,
        data?: any,
        params?: any,
        schema: boolean = false,
        // Security (cross-tenant IDOR fix): the request-scoped, per-caller
        // tenant endpoint prefix (`/tenants/{tenantId}`). When provided it is
        // prepended to the data-plane endpoint so a caller can only ever
        // address rows inside their own tenant partition. `undefined` keeps
        // the legacy un-prefixed behaviour for internal/system callers (e.g.
        // metadata/schema calls and sync paths that are NOT per-caller). The
        // companies/people controllers ALWAYS pass a non-empty prefix.
        tenantPrefix?: string,
    ): Promise<T> {
        try {
            const config = this.configService.twentyCrmConfig;
            // Schema/metadata calls are workspace-global admin operations and are
            // never tenant-scoped; only the data plane gets the tenant prefix.
            const scopedEndpoint =
                !schema && tenantPrefix ? `${tenantPrefix}${endpoint}` : endpoint;
            const url = schema
                ? `${this.metadataUrl}${scopedEndpoint}`
                : `${this.baseUrl}${scopedEndpoint}`;

            this.logger.debug(`Making ${method} request to ${url}`);

            const response = await firstValueFrom(
                this.httpService.request({
                    method,
                    url,
                    headers: this.headers,
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

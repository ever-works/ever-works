import { Module, Global } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { CrmConfigService } from './config/crm-config.service';
import { TwentyCrmService } from './services/twenty-crm.service';
import { CrmTenantService } from './services/crm-tenant.service';
import { ClientService } from './services/client.service';
import { CompaniesController } from './controllers/companies.service';
import { AuthModule } from '@src/auth';

/**
 * Twenty CRM integration module
 */
@Global()
@Module({})
export class TwentyCrmModule {
    static forRoot(config?: Partial<CrmConfigService>) {
        return {
            module: TwentyCrmModule,
            global: true,
            imports: [
                HttpModule.register({
                    timeout: config?.twentyCrmConfig.timeout || 30000,
                    maxRedirects: 5,
                }),
                ConfigModule,
                AuthModule,
            ],
            providers: [
                CrmConfigService,
                TwentyCrmService,
                ClientService,
                CrmTenantService,
                {
                    provide: 'TWENTY_CRM_CONFIG',
                    useValue: config,
                },
            ],
            controllers: [CompaniesController],
            exports: [TwentyCrmService, ClientService, CrmTenantService, CrmConfigService],
        };
    }

    static forRootAsync(options: {
        useFactory: (...args: any[]) => Promise<CrmConfigService> | CrmConfigService;
        inject?: any[];
    }) {
        return {
            module: TwentyCrmModule,
            global: true,
            imports: [
                HttpModule.register({
                    timeout: 30000,
                    maxRedirects: 5,
                }),
                ConfigModule,
                AuthModule,
            ],
            providers: [
                CrmConfigService,
                TwentyCrmService,
                ClientService,
                CrmTenantService,
                {
                    provide: 'TWENTY_CRM_CONFIG',
                    useFactory: options.useFactory,
                    inject: options.inject || [],
                },
            ],
            controllers: [CompaniesController],
            exports: [TwentyCrmService, ClientService, CrmTenantService, CrmConfigService],
        };
    }
}

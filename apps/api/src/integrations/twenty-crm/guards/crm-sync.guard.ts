import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';
import { CrmConfigService } from '../config/crm-config.service';
@Injectable()
export class CrmSyncGuard implements CanActivate {
    private readonly logger = new Logger(CrmSyncGuard.name);

    constructor(private readonly configService: CrmConfigService) {}

    canActivate(context: ExecutionContext): boolean {
        if (!this.configService.isEnabled) {
            this.logger.warn('CRM integration is disabled - request blocked');
            return false;
        }

        try {
            this.configService.validateConfig();
            return true;
        } catch (error) {
            this.logger.error('CRM configuration validation failed:', error);
            return false;
        }
    }
}

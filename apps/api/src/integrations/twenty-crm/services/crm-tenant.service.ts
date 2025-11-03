import { Injectable, Logger } from '@nestjs/common';
import { CrmTenantContext } from '../types/twenty-crm.types';

/**
 * Service for managing CRM tenant context
 */
@Injectable()
export class CrmTenantService {
    private readonly logger = new Logger(CrmTenantService.name);

    /**
     * Resolve tenant context from request headers or directory
     */
    resolveTenantContext(
        directoryId?: string,
        userId?: string,
        globalTenantId?: string,
    ): CrmTenantContext {
        const tenantId = directoryId
            ? `directory_${directoryId}`
            : globalTenantId || 'global_everworks';
        const context: CrmTenantContext = {
            tenantId,
            directoryId,
            userId,
        };

        this.logger.debug(`Resolved tenant context: ${JSON.stringify(context)}`);

        return context;
    }

    /**
     * Get tenant-specific API endpoint prefix
     */
    getTenantEndpointPrefix(tenantContext: CrmTenantContext): string {
        return `/tenants/${tenantContext.tenantId}`;
    }

    /**
     * Validate tenant context
     */
    validateTenantContext(context: CrmTenantContext): boolean {
        if (!context.tenantId) {
            this.logger.error('Tenant ID is required');
            return false;
        }

        return true;
    }

    /**
     * Get tenant-specific configuration
     */
    getTenantConfig(tenantContext: CrmTenantContext): Record<string, any> {
        return {
            tenantId: tenantContext.tenantId,
            directoryId: tenantContext.directoryId,
            userId: tenantContext.userId,
        };
    }
}

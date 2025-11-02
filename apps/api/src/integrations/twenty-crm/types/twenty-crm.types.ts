/**
 * Configuration interface for Twenty CRM integration
 */
export interface TwentyCrmConfig {
    /** Base URL of the Twenty CRM API */
    baseUrl: string;
    /** API key for authentication */
    apiKey: string;
    /** Global tenant ID for multi-tenant support */
    globalTenantId?: string;
    /** Retry configuration */
    retry?: {
        maxAttempts: number;
        delayMs: number;
        backoffMultiplier: number;
    };
    /** Request timeout in milliseconds */
    timeoutMs?: number;
    /** Enable/disable logging */
    enableLogging?: boolean;
}

/**
 * Response from Twenty CRM API
 */
export interface TwentyCrmResponse<T = any> {
    data: T;
    message?: string;
    status: number;
}

/**
 * Contact data structure for Twenty CRM
 */
export interface TwentyContact {
    id?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    companyId?: string;
    position?: string;
    avatarUrl?: string;
    createdAt?: string;
    updatedAt?: string;
}

/**
 * Organization data structure for Twenty CRM
 */
export interface TwentyOrganization {
    id?: string;
    name: string;
    domainName?: string;
    address?: string;
    employees?: number;
    linkedinUrl?: string;
    xUrl?: string;
    annualRecurringRevenue?: number;
    idealCustomerProfile?: boolean;
    createdAt?: string;
    updatedAt?: string;
}

/**
 * Product/Deal data structure for Twenty CRM
 */
export interface TwentyProduct {
    id?: string;
    name: string;
    description?: string;
    price?: number;
    currency?: string;
    category?: string;
    createdAt?: string;
    updatedAt?: string;
}

/**
 * Deal data structure for Twenty CRM
 */
export interface TwentyDeal {
    id?: string;
    title: string;
    amount?: number;
    currency?: string;
    stage?: string;
    probability?: number;
    companyId?: string;
    personId?: string;
    createdAt?: string;
    updatedAt?: string;
}

/**
 * Error response from Twenty CRM API
 */
export interface TwentyCrmError {
    message: string;
    statusCode: number;
    error?: string;
    details?: any;
}

/**
 * Sync operation result
 */
export interface CrmSyncResult {
    success: boolean;
    entityId?: string;
    entityType: 'contact' | 'organization' | 'product' | 'deal';
    crmId?: string;
    error?: string;
    retryCount?: number;
    duration?: number;
}

/**
 * Multi-tenant context
 */
export interface CrmTenantContext {
    tenantId: string;
    directoryId?: string;
    userId?: string;
}

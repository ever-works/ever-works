/**
 * Mapping types for Ever Works entities to Twenty CRM entities
 */

/**
 * Ever Works Client/Customer data structure
 */
export interface EverWorksClient {
    id: string;
    name: string;
    email: string;
    phone?: string;
    companyId?: string;
    position?: string;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Ever Works Company data structure
 */
export interface EverWorksCompany {
    id: string;
    name: string;
    website?: string;
    description?: string;
    industry?: string;
    size?: number;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Ever Works Item data structure
 */
export interface EverWorksItem {
    id: string;
    name: string;
    description: string;
    price?: number;
    currency?: string;
    category?: string;
    companyId?: string;
    clientId?: string;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Mapping configuration for field transformations
 */
export interface FieldMapping {
    sourceField: string;
    targetField: string;
    transform?: (value: any) => any;
    required?: boolean;
}

/**
 * Entity mapping configuration
 */
export interface EntityMapping {
    sourceEntity: string;
    targetEntity: string;
    fieldMappings: FieldMapping[];
    customTransform?: (source: any) => any;
}

/**
 * Mapping result with transformation details
 */
export interface MappingResult<T = any> {
    success: boolean;
    data?: T;
    errors?: string[];
    warnings?: string[];
    transformations?: Array<{
        field: string;
        originalValue: any;
        transformedValue: any;
    }>;
}

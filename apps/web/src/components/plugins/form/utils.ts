import { JsonSchemaType } from '@ever-works/plugin';

export function isType(schemaType: unknown, target: JsonSchemaType): boolean {
    if (!schemaType) return false;
    if (Array.isArray(schemaType)) {
        return schemaType.includes(target);
    }
    return schemaType === target;
}

export function getPrimaryType(schemaType: unknown): JsonSchemaType | null {
    if (!schemaType) return 'string'; // default fallback
    if (Array.isArray(schemaType)) {
        // Return first non-null type for unions, or null if only null
        const nonNull = schemaType.find((t) => t !== 'null');
        return nonNull || 'null';
    }
    return schemaType as JsonSchemaType;
}

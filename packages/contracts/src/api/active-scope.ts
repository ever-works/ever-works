type NullableStringSchemaProperty = {
	type: 'string';
	format?: 'uuid';
	nullable: true;
};

const ACTIVE_SCOPE_RESPONSE_PROPERTIES = {
	tenantId: { type: 'string', format: 'uuid', nullable: true },
	organizationId: { type: 'string', format: 'uuid', nullable: true },
	organizationSlug: { type: 'string', nullable: true }
} satisfies Record<string, NullableStringSchemaProperty>;

type ActiveScopeResponseKey = keyof typeof ACTIVE_SCOPE_RESPONSE_PROPERTIES;

/** Runtime OpenAPI schema and source of truth for the active-scope response keys. */
export const ACTIVE_SCOPE_RESPONSE_SCHEMA = {
	type: 'object' as const,
	properties: ACTIVE_SCOPE_RESPONSE_PROPERTIES,
	required: Object.keys(ACTIVE_SCOPE_RESPONSE_PROPERTIES) as ActiveScopeResponseKey[]
};

/** Wire response shared by the API and every active-scope consumer. */
export type ActiveScopeResponse = {
	[Key in ActiveScopeResponseKey]: string | null;
};

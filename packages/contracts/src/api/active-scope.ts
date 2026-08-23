type NullableStringSchemaProperty = {
	type: 'string';
	format?: 'uuid';
	nullable: true;
};

/** Reserved transport contract; Organization slugs can never collide with this value. */
export const ACTIVE_SCOPE_PERSONAL_SENTINEL = '@personal' as const;
export const ACTIVE_SCOPE_API_HEADER = 'x-scope-slug' as const;
export const ACTIVE_SCOPE_BROWSER_HEADER = 'x-ever-workspace' as const;

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

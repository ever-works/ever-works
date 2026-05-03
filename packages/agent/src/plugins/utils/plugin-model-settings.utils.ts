import type { JsonSchema, ProviderModelSummary, ResolvedSettings } from '@ever-works/plugin';

const MODEL_FIELD_ORDER = ['defaultModel', 'simpleModel', 'mediumModel', 'complexModel', 'model'];

function isModelField(schema: JsonSchema | undefined): boolean {
    return schema?.['x-widget'] === 'model-select';
}

function getModelFieldEntries(schema: JsonSchema | undefined): Array<[string, JsonSchema]> {
    if (!schema?.properties) return [];

    const entries = Object.entries(schema.properties).filter(([, propSchema]) =>
        isModelField(propSchema as JsonSchema),
    ) as Array<[string, JsonSchema]>;

    return entries.sort(([left], [right]) => {
        const leftIndex = MODEL_FIELD_ORDER.indexOf(left);
        const rightIndex = MODEL_FIELD_ORDER.indexOf(right);

        if (leftIndex === -1 && rightIndex === -1) return 0;
        if (leftIndex === -1) return 1;
        if (rightIndex === -1) return -1;
        return leftIndex - rightIndex;
    });
}

export function buildProviderModelSummaries(
    schema: JsonSchema | undefined,
    resolved: ResolvedSettings | undefined,
): ProviderModelSummary[] | undefined {
    const modelFields = getModelFieldEntries(schema);
    if (modelFields.length === 0) return undefined;

    const summaries: ProviderModelSummary[] = [];
    const seen = new Set<string>();

    for (const [key, propSchema] of modelFields) {
        const setting = resolved?.[key];
        const value = typeof setting?.value === 'string' ? setting.value.trim() : '';
        if (!value || seen.has(value)) continue;

        seen.add(value);
        summaries.push({
            key,
            label: propSchema.title || key,
            value,
            source: setting?.source,
            isWorkOverride: setting?.source === 'work',
        });
    }

    return summaries.length > 0 ? summaries : undefined;
}

'use client';

import { useMemo } from 'react';
import { PluginSettingsSchemaProperty } from '@/lib/api/plugins';
import { Select } from '@/components/ui/select';
import { PluginSettingsField } from './PluginSettingsField';

interface PluginSettingsObjectFieldProps {
    name: string;
    schema: PluginSettingsSchemaProperty;
    value: Record<string, unknown>;
    onChange: (value: Record<string, unknown>) => void;
    pluginId?: string;
    validationDetails?: Record<string, unknown> | null;
}

/** Inspect a oneOf-branch list to detect which property name acts as the
 *  discriminator — the property whose schema has a `const` value in every
 *  branch. Returns `null` if the branches aren't a discriminated union. */
function findDiscriminator(
    branches: readonly PluginSettingsSchemaProperty[],
): { field: string; constByBranch: Map<PluginSettingsSchemaProperty, unknown> } | null {
    if (branches.length === 0) return null;
    const firstProps = branches[0].properties ?? {};
    for (const [field, propSchema] of Object.entries(firstProps)) {
        if (propSchema.const === undefined) continue;
        // Every other branch must also have a const value at this same field.
        const map = new Map<PluginSettingsSchemaProperty, unknown>();
        let consistent = true;
        for (const branch of branches) {
            const branchProp = branch.properties?.[field];
            if (!branchProp || branchProp.const === undefined) {
                consistent = false;
                break;
            }
            map.set(branch, branchProp.const);
        }
        if (consistent) return { field, constByBranch: map };
    }
    return null;
}

export function PluginSettingsObjectField({
    name,
    schema,
    value,
    onChange,
    pluginId,
    validationDetails,
}: PluginSettingsObjectFieldProps) {
    const requiredFields = schema.required || [];
    const currentValue = value || {};

    const handlePropertyChange = (propName: string, propValue: unknown) => {
        onChange({
            ...currentValue,
            [propName]: propValue,
        });
    };

    const oneOf = schema.oneOf;
    const discriminator = useMemo(() => (oneOf ? findDiscriminator(oneOf) : null), [oneOf]);

    if (oneOf && oneOf.length > 0 && discriminator) {
        const defaultValue = (schema.default as Record<string, unknown> | undefined) ?? {};
        const currentKind =
            currentValue[discriminator.field] ?? defaultValue[discriminator.field] ?? '';
        const selectedBranch =
            oneOf.find((b) => discriminator.constByBranch.get(b) === currentKind) ?? oneOf[0];

        const handleBranchChange = (newKind: string) => {
            // Reset to {kind: newKind} when switching branches so stale fields
            // from the previous branch don't pollute the saved payload.
            onChange({ [discriminator.field]: newKind });
        };

        // Properties to render for the selected branch — exclude the
        // discriminator itself (rendered as the branch selector above).
        const branchProps = Object.entries(selectedBranch.properties ?? {}).filter(
            ([propName]) => propName !== discriminator.field,
        );
        const branchRequired = (selectedBranch.required ?? []).filter(
            (r) => r !== discriminator.field,
        );

        return (
            <div className="space-y-4 p-3 rounded-lg border border-border dark:border-border-dark">
                <Select value={String(currentKind)} onValueChange={handleBranchChange}>
                    {oneOf.map((branch) => {
                        const kindValue = String(discriminator.constByBranch.get(branch) ?? '');
                        return (
                            <option key={kindValue} value={kindValue}>
                                {branch.title ?? kindValue}
                            </option>
                        );
                    })}
                </Select>
                {branchProps.map(([propName, propSchema]) => (
                    <PluginSettingsField
                        key={`${name}.${String(currentKind)}.${propName}`}
                        name={propName}
                        schema={propSchema}
                        value={currentValue[propName] ?? propSchema.default}
                        required={branchRequired.includes(propName)}
                        onChange={(val) => handlePropertyChange(propName, val)}
                        pluginId={pluginId}
                        validationDetails={validationDetails}
                    />
                ))}
            </div>
        );
    }

    const properties = schema.properties || {};
    return (
        <div className="space-y-4 p-3 rounded-lg border border-border dark:border-border-dark">
            {Object.entries(properties).map(([propName, propSchema]) => (
                <PluginSettingsField
                    key={`${name}.${propName}`}
                    name={propName}
                    schema={propSchema}
                    value={currentValue[propName]}
                    required={requiredFields.includes(propName)}
                    onChange={(val) => handlePropertyChange(propName, val)}
                    pluginId={pluginId}
                    validationDetails={validationDetails}
                />
            ))}
        </div>
    );
}

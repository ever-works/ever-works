'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type {
    PluginSettingsSchema,
    PluginSettingsSchemaProperty,
    SettingScopeApi,
} from '@/lib/api/plugins';
import { validateSettingsConstraints } from '@ever-works/plugin/api';

interface UsePluginSettingsOptions {
    schema: PluginSettingsSchema | undefined;
    initialSettings: Record<string, unknown>;
    scopes: SettingScopeApi[];
    onSave: (data: {
        settings?: Record<string, unknown>;
        secretSettings?: Record<string, unknown>;
    }) => Promise<void>;
    /** Display-only fallback values shown when a field has no value in initialSettings.
     *  These are NOT saved — only used by getFieldValue for display purposes. */
    fallbackSettings?: Record<string, unknown>;
    /** Identifies validation context: 'user' scope requires all required fields,
     *  'directory' scope allows inheritance from fallbackSettings */
    scope: 'user' | 'directory';
}

/** Stable empty object to avoid re-renders when initialSettings is undefined */
const EMPTY_SETTINGS: Record<string, unknown> = {};

interface UsePluginSettingsReturn {
    settings: Record<string, unknown>;
    secretSettings: Record<string, unknown>;
    hasChanges: boolean;
    isSaving: boolean;
    saveSuccess: boolean;
    validationError: string | null;
    visibleProperties: Record<string, PluginSettingsSchemaProperty>;
    hasSettings: boolean;
    handleFieldChange: (key: string, value: unknown, isSecret: boolean) => void;
    handleSave: () => Promise<void>;
    getFieldValue: (key: string, propSchema: PluginSettingsSchemaProperty) => unknown;
}

export function usePluginSettings({
    schema,
    initialSettings,
    scopes,
    onSave,
    fallbackSettings,
    scope,
}: UsePluginSettingsOptions): UsePluginSettingsReturn {
    const t = useTranslations('dashboard.plugins');
    const router = useRouter();

    // Helper to split settings into regular and secret based on schema,
    // and populate schema defaults for visible fields that have no saved value.
    // This ensures defaults are included in the save payload so the backend
    // receives them and validation passes at both frontend and backend.
    const splitSettingsBySecret = useCallback(
        (allSettings: Record<string, unknown>) => {
            const regular: Record<string, unknown> = {};
            const secret: Record<string, unknown> = {};

            for (const [key, value] of Object.entries(allSettings)) {
                const propSchema = schema?.properties?.[key] as
                    | PluginSettingsSchemaProperty
                    | undefined;
                if (propSchema?.secret) {
                    secret[key] = value;
                } else {
                    regular[key] = value;
                }
            }

            if (schema?.properties) {
                for (const [key, propSchema] of Object.entries(schema.properties)) {
                    const prop = propSchema as PluginSettingsSchemaProperty;
                    if (prop.hidden || prop.default === undefined) continue;
                    const propScope = (prop.scope || 'global') as SettingScopeApi;
                    if (!scopes.includes(propScope)) continue;

                    const target = prop.secret ? secret : regular;
                    if (!(key in target)) {
                        target[key] = prop.default;
                    }
                }
            }

            return { regular, secret };
        },
        [schema, scopes],
    );

    // Use stable empty object when initialSettings has no keys, so ref comparison works
    const stableInitial =
        initialSettings && Object.keys(initialSettings).length > 0
            ? initialSettings
            : EMPTY_SETTINGS;

    // Split initial settings into regular and secret
    const { regular: initialRegular, secret: initialSecret } = useMemo(
        () => splitSettingsBySecret(stableInitial),
        [stableInitial, splitSettingsBySecret],
    );

    const [settings, setSettings] = useState<Record<string, unknown>>(initialRegular);
    const [secretSettings, setSecretSettings] = useState<Record<string, unknown>>(initialSecret);
    const [modifiedFields, setModifiedFields] = useState<Set<string>>(new Set());
    const [hasChanges, setHasChanges] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);
    const [validationError, setValidationError] = useState<string | null>(null);
    const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const prevInitialRef = useRef(stableInitial);

    // Sync settings state when server data changes (e.g. after router.refresh())
    useEffect(() => {
        if (stableInitial !== prevInitialRef.current) {
            prevInitialRef.current = stableInitial;
            const { regular, secret } = splitSettingsBySecret(stableInitial);
            setSettings(regular);
            setSecretSettings(secret);
            setModifiedFields(new Set());
            setHasChanges(false);
        }
    }, [stableInitial, splitSettingsBySecret]);

    // Cleanup success timer on unmount
    useEffect(() => {
        return () => {
            if (successTimerRef.current) {
                clearTimeout(successTimerRef.current);
            }
        };
    }, []);

    // Filter properties by scope and exclude hidden fields
    const visibleProperties = useMemo(() => {
        if (!schema?.properties) return {};
        return Object.fromEntries(
            Object.entries(schema.properties).filter(([_, propSchema]) => {
                const prop = propSchema as PluginSettingsSchemaProperty;
                if (prop.hidden) return false;
                const scope = prop.scope || 'global';
                return scopes.includes(scope as SettingScopeApi);
            }),
        );
    }, [schema, scopes]);

    const hasSettings = Object.keys(visibleProperties).length > 0;

    // Get required fields for the given scopes
    const requiredFields = useMemo(() => {
        if (!schema?.required || !schema.properties) return [];
        return schema.required.filter((field) => {
            const propSchema = schema.properties?.[field] as
                | PluginSettingsSchemaProperty
                | undefined;
            if (!propSchema) return false;
            const scope = propSchema.scope || 'global';
            return scopes.includes(scope as SettingScopeApi);
        });
    }, [schema, scopes]);

    const requiredGroups = useMemo(() => {
        if (!schema?.requiredGroups || !schema.properties) return [];
        return schema.requiredGroups
            .map((group) => ({
                ...group,
                fields: group.fields.filter((field) => {
                    const propSchema = schema.properties?.[field] as
                        | PluginSettingsSchemaProperty
                        | undefined;
                    if (!propSchema) return false;
                    const scope = propSchema.scope || 'global';
                    return scopes.includes(scope as SettingScopeApi);
                }),
            }))
            .filter((group) => group.fields.length > 0);
    }, [schema, scopes]);

    const validateRequiredFields = useCallback((): string[] => {
        const errors: string[] = [];

        for (const field of requiredFields) {
            const value = settings[field] ?? secretSettings[field];

            // Check if field is empty
            const isEmpty = value === undefined || value === null || value === '';

            if (isEmpty) {
                // At directory scope, check if inherited value exists
                if (scope === 'directory' && fallbackSettings) {
                    const inheritedValue = fallbackSettings[field];
                    const hasInheritance =
                        inheritedValue !== undefined &&
                        inheritedValue !== null &&
                        inheritedValue !== '';

                    if (hasInheritance) {
                        // Field will inherit - validation passes
                        continue;
                    }
                }

                // No local value and no inheritance - field is required
                const propSchema = schema?.properties?.[field] as
                    | PluginSettingsSchemaProperty
                    | undefined;
                errors.push(propSchema?.title || field);
            }
        }

        for (const group of requiredGroups) {
            // Check local settings
            const hasAnyLocal = group.fields.some((field) => {
                const value = settings[field] ?? secretSettings[field];
                return value !== undefined && value !== null && value !== '';
            });

            // At directory scope, also check inherited values
            let hasAnyInherited = false;
            if (scope === 'directory' && fallbackSettings) {
                hasAnyInherited = group.fields.some((field) => {
                    const value = fallbackSettings[field];
                    return value !== undefined && value !== null && value !== '';
                });
            }

            // Group satisfied if ANY field has value (local or inherited)
            if (!hasAnyLocal && !hasAnyInherited) {
                const labels = group.fields.map((f) => {
                    const ps = schema?.properties?.[f] as PluginSettingsSchemaProperty | undefined;
                    return ps?.title || f;
                });
                errors.push(group.message || `At least one of: ${labels.join(', ')}`);
            }
        }

        return errors;
    }, [requiredFields, requiredGroups, settings, secretSettings, schema, scope, fallbackSettings]);

    const handleFieldChange = useCallback((key: string, value: unknown, isSecret: boolean) => {
        if (isSecret) {
            setSecretSettings((prev) => ({ ...prev, [key]: value }));
        } else {
            setSettings((prev) => ({ ...prev, [key]: value }));
        }
        setModifiedFields((prev) => new Set(prev).add(key));
        setHasChanges(true);
        setSaveSuccess(false);
        setValidationError(null);
    }, []);

    const validateConstraints = useCallback((): string[] => {
        const allValues = { ...settings, ...secretSettings };
        return validateSettingsConstraints(allValues, visibleProperties).map((e) => e.message);
    }, [settings, secretSettings, visibleProperties]);

    const handleSave = useCallback(async () => {
        const missingFields = validateRequiredFields();
        if (missingFields.length > 0) {
            setValidationError(t('missingRequiredFields', { fields: missingFields.join(', ') }));
            return;
        }

        const constraintErrors = validateConstraints();
        if (constraintErrors.length > 0) {
            setValidationError(constraintErrors.join('. '));
            return;
        }

        // Sanitize: convert undefined values to null so they survive JSON serialization
        const sanitize = (obj: Record<string, unknown>): Record<string, unknown> => {
            const result: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(obj)) {
                if (value === undefined) {
                    result[key] = null;
                } else if (scope === 'directory' && value === '') {
                    // At directory scope, empty string means "clear override, use inherited"
                    result[key] = null;
                } else {
                    result[key] = value;
                }
            }
            return result;
        };

        setIsSaving(true);
        setValidationError(null);
        try {
            const sanitizedSettings =
                Object.keys(settings).length > 0 ? sanitize(settings) : undefined;
            const sanitizedSecretSettings =
                Object.keys(secretSettings).length > 0 ? sanitize(secretSettings) : undefined;

            await onSave({
                settings: sanitizedSettings,
                secretSettings: sanitizedSecretSettings,
            });

            // Update local state to reflect what was saved
            // Remove fields that were cleared (set to null)
            if (sanitizedSettings) {
                setSettings((prev) => {
                    const updated = { ...prev };
                    for (const [key, value] of Object.entries(sanitizedSettings)) {
                        if (value === null) {
                            delete updated[key];
                        } else {
                            updated[key] = value;
                        }
                    }
                    return updated;
                });
            }
            if (sanitizedSecretSettings) {
                // Update secretSettings state
                setSecretSettings((prev) => {
                    const updated = { ...prev };
                    for (const [key, value] of Object.entries(sanitizedSecretSettings)) {
                        if (value === null) {
                            delete updated[key];
                        } else {
                            updated[key] = value;
                        }
                    }
                    return updated;
                });
                // ALSO delete from settings state in case initial value was placed there
                setSettings((prev) => {
                    const updated = { ...prev };
                    for (const [key, value] of Object.entries(sanitizedSecretSettings)) {
                        if (value === null) {
                            delete updated[key];
                        }
                    }
                    return updated;
                });
            }

            // Clear modifiedFields so getFieldValue will use inherited values
            setModifiedFields(new Set());
            setHasChanges(false);
            setSaveSuccess(true);
            router.refresh();
            successTimerRef.current = setTimeout(() => setSaveSuccess(false), 3000);
        } catch (error) {
            console.error('Failed to save settings:', error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : typeof error === 'object' && error !== null && 'message' in error
                      ? String((error as { message: unknown }).message)
                      : t('saveError');
            setValidationError(errorMessage);
        } finally {
            setIsSaving(false);
        }
    }, [validateRequiredFields, validateConstraints, settings, secretSettings, onSave, router, t]);

    const getFieldValue = useCallback(
        (key: string, propSchema: PluginSettingsSchemaProperty): unknown => {
            let value: unknown;
            if (propSchema.secret) {
                value = key in secretSettings ? secretSettings[key] : settings[key];
            } else {
                value = settings[key];
            }
            // Fall back to inherited value for display when no local value is set
            // BUT: if the user has explicitly modified this field, respect their input (even if empty)
            const hasBeenModified = modifiedFields.has(key);
            if (
                !hasBeenModified &&
                (value === undefined || value === null || value === '') &&
                fallbackSettings
            ) {
                return fallbackSettings[key];
            }
            return value;
        },
        [settings, secretSettings, fallbackSettings, modifiedFields],
    );

    return {
        settings,
        secretSettings,
        hasChanges,
        isSaving,
        saveSuccess,
        validationError,
        visibleProperties,
        hasSettings,
        handleFieldChange,
        handleSave,
        getFieldValue,
    };
}

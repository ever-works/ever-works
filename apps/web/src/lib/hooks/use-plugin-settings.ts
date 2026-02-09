'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type {
    PluginSettingsSchema,
    PluginSettingsSchemaProperty,
    SettingScopeApi,
} from '@/lib/api/plugins';

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
}: UsePluginSettingsOptions): UsePluginSettingsReturn {
    const t = useTranslations('dashboard.plugins');
    const router = useRouter();
    // Use stable empty object when initialSettings has no keys, so ref comparison works
    const stableInitial =
        initialSettings && Object.keys(initialSettings).length > 0
            ? initialSettings
            : EMPTY_SETTINGS;
    const [settings, setSettings] = useState<Record<string, unknown>>(stableInitial);
    const [secretSettings, setSecretSettings] = useState<Record<string, unknown>>({});
    const [hasChanges, setHasChanges] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);
    const [validationError, setValidationError] = useState<string | null>(null);
    const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const prevInitialRef = useRef(stableInitial);

    // Sync settings state when server data changes (e.g. after router.refresh())
    if (stableInitial !== prevInitialRef.current) {
        prevInitialRef.current = stableInitial;
        setSettings(stableInitial);
        setSecretSettings({});
        setHasChanges(false);
    }

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
            if (value === undefined || value === null || value === '') {
                const propSchema = schema?.properties?.[field] as
                    | PluginSettingsSchemaProperty
                    | undefined;
                errors.push(propSchema?.title || field);
            }
        }

        for (const group of requiredGroups) {
            const hasAny = group.fields.some((field) => {
                const value = settings[field] ?? secretSettings[field];
                return value !== undefined && value !== null && value !== '';
            });
            if (!hasAny) {
                const labels = group.fields.map((f) => {
                    const ps = schema?.properties?.[f] as PluginSettingsSchemaProperty | undefined;
                    return ps?.title || f;
                });
                errors.push(group.message || `At least one of: ${labels.join(', ')}`);
            }
        }

        return errors;
    }, [requiredFields, requiredGroups, settings, secretSettings, schema]);

    const handleFieldChange = useCallback((key: string, value: unknown, isSecret: boolean) => {
        if (isSecret) {
            setSecretSettings((prev) => ({ ...prev, [key]: value }));
        } else {
            setSettings((prev) => ({ ...prev, [key]: value }));
        }
        setHasChanges(true);
        setSaveSuccess(false);
        setValidationError(null);
    }, []);

    const validateConstraints = useCallback((): string[] => {
        const errors: string[] = [];
        const allValues = { ...settings, ...secretSettings };
        for (const [key, propSchema] of Object.entries(visibleProperties)) {
            const prop = propSchema as PluginSettingsSchemaProperty;
            const val = allValues[key];
            if (val === undefined || val === null || val === '') continue;

            if (prop.type === 'number' && typeof val === 'number') {
                const label = prop.title || key;
                if (prop.minimum !== undefined && val < prop.minimum) {
                    errors.push(`${label} must be at least ${prop.minimum}`);
                }
                if (prop.maximum !== undefined && val > prop.maximum) {
                    errors.push(`${label} must be at most ${prop.maximum}`);
                }
            }
            if (prop.type === 'string' && typeof val === 'string') {
                const label = prop.title || key;
                if (prop.minLength !== undefined && val.length < prop.minLength) {
                    errors.push(`${label} must be at least ${prop.minLength} characters`);
                }
                if (prop.maxLength !== undefined && val.length > prop.maxLength) {
                    errors.push(`${label} must be at most ${prop.maxLength} characters`);
                }
                if (prop.pattern) {
                    try {
                        if (!new RegExp(prop.pattern).test(val)) {
                            errors.push(`${label} has an invalid format`);
                        }
                    } catch {
                        // ignore invalid regex from schema
                    }
                }
            }
            if (prop.enum && prop.enum.length > 0) {
                if (!prop.enum.includes(val)) {
                    const label = prop.title || key;
                    errors.push(`${label} must be one of: ${prop.enum.join(', ')}`);
                }
            }
        }
        return errors;
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
                result[key] = value === undefined ? null : value;
            }
            return result;
        };

        setIsSaving(true);
        setValidationError(null);
        try {
            await onSave({
                settings: Object.keys(settings).length > 0 ? sanitize(settings) : undefined,
                secretSettings:
                    Object.keys(secretSettings).length > 0 ? sanitize(secretSettings) : undefined,
            });
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
            if ((value === undefined || value === null || value === '') && fallbackSettings) {
                return fallbackSettings[key];
            }
            return value;
        },
        [settings, secretSettings, fallbackSettings],
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

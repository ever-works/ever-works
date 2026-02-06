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

    const validateRequiredFields = useCallback((): string[] => {
        const missingFields: string[] = [];
        for (const field of requiredFields) {
            const value = settings[field] ?? secretSettings[field];
            if (value === undefined || value === null || value === '') {
                const propSchema = schema?.properties?.[field] as
                    | PluginSettingsSchemaProperty
                    | undefined;
                const label = propSchema?.title || field;
                missingFields.push(label);
            }
        }
        return missingFields;
    }, [requiredFields, settings, secretSettings, schema]);

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

    const handleSave = useCallback(async () => {
        const missingFields = validateRequiredFields();
        if (missingFields.length > 0) {
            setValidationError(t('missingRequiredFields', { fields: missingFields.join(', ') }));
            return;
        }

        setIsSaving(true);
        setValidationError(null);
        try {
            await onSave({
                settings: Object.keys(settings).length > 0 ? settings : undefined,
                secretSettings: Object.keys(secretSettings).length > 0 ? secretSettings : undefined,
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
    }, [validateRequiredFields, settings, secretSettings, onSave, router, t]);

    const getFieldValue = useCallback(
        (key: string, propSchema: PluginSettingsSchemaProperty): unknown => {
            if (propSchema.secret) {
                return key in secretSettings ? secretSettings[key] : settings[key];
            }
            return settings[key];
        },
        [settings, secretSettings],
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

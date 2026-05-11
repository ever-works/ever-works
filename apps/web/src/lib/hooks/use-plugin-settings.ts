'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type {
    PluginSettingsSchema,
    PluginSettingsSchemaProperty,
    SettingScopeApi,
} from '@/lib/api/plugins';
import {
    validateSettingsConstraints,
    splitSettingsBySecret as splitBySecret,
    getVisibleProperties as getVisible,
    validateRequiredSettings,
    sanitizeSettingsForSave,
} from '@ever-works/plugin/api';

interface UsePluginSettingsOptions {
    schema: PluginSettingsSchema | undefined;
    initialSettings: Record<string, unknown>;
    scopes: SettingScopeApi[];
    onSave: (data: {
        settings?: Record<string, unknown>;
        secretSettings?: Record<string, unknown>;
    }) => Promise<
        | void
        | {
              validationError?: string;
              validationSuccess?: string;
              validationDetails?: Record<string, unknown>;
          }
    >;
    /** Display-only fallback values shown when a field has no value in initialSettings.
     *  These are NOT saved — only used by getFieldValue for display purposes. */
    fallbackSettings?: Record<string, unknown>;
    /** Identifies validation context: 'user' scope requires all required fields,
     *  'work' scope allows inheritance from fallbackSettings */
    scope: 'user' | 'work';
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
    saveMessage: string | null;
    /** Plugin-specific details returned by the most recent validation, e.g.
     *  k8s returns cluster name + version + detected IngressClass list. The UI
     *  can use these to populate dynamic widgets (ingress-class select) and
     *  show a success summary after Save & verify. Null until first validation. */
    validationDetails: Record<string, unknown> | null;
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

    const splitSettingsBySecret = useCallback(
        (allSettings: Record<string, unknown>) => splitBySecret(allSettings, schema, scopes),
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
    const [saveMessage, setSaveMessage] = useState<string | null>(null);
    const [validationDetails, setValidationDetails] = useState<Record<string, unknown> | null>(
        null,
    );
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

    const visibleProperties = useMemo(() => getVisible(schema, scopes), [schema, scopes]);

    const hasSettings = Object.keys(visibleProperties).length > 0;

    const validateRequiredFields = useCallback(
        (): string[] =>
            validateRequiredSettings(
                settings,
                secretSettings,
                schema,
                scopes,
                scope,
                fallbackSettings,
            ),
        [settings, secretSettings, schema, scopes, scope, fallbackSettings],
    );

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
        setSaveMessage(null);
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

        setIsSaving(true);
        setValidationError(null);
        try {
            const modifiedRegularSettings = Object.fromEntries(
                Object.entries(settings).filter(([key]) => modifiedFields.has(key)),
            );
            const modifiedSecretSettings = Object.fromEntries(
                Object.entries(secretSettings).filter(([key]) => modifiedFields.has(key)),
            );
            const sanitizedSettings =
                Object.keys(modifiedRegularSettings).length > 0
                    ? sanitizeSettingsForSave(modifiedRegularSettings, scope)
                    : undefined;
            const sanitizedSecretSettings =
                Object.keys(modifiedSecretSettings).length > 0
                    ? sanitizeSettingsForSave(modifiedSecretSettings, scope)
                    : undefined;

            const result = await onSave({
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
                // Replace saved secret values with a masked placeholder immediately
                // so the full value is never visible in state after save.
                // The actual masked value from the API will replace this on router.refresh().
                setSecretSettings((prev) => {
                    const updated = { ...prev };
                    for (const [key, value] of Object.entries(sanitizedSecretSettings)) {
                        if (value === null) {
                            delete updated[key];
                        } else {
                            updated[key] = '••••••••';
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
            setSaveSuccess(!result?.validationError);
            setSaveMessage(result?.validationSuccess || null);
            if (result?.validationError) {
                setValidationError(result.validationError);
            }
            // Capture validation details (cluster info, detected IngressClass list, ...)
            // so dynamic widgets and the success banner can use them.
            // Always update — including clearing on validation error — so stale
            // details from a previous successful save don't survive a re-save
            // that points at a different cluster.
            setValidationDetails(result?.validationDetails ?? null);
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
    }, [
        validateRequiredFields,
        validateConstraints,
        settings,
        secretSettings,
        modifiedFields,
        onSave,
        router,
        t,
        scope,
    ]);

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
            const isEmpty = value === undefined || value === null || value === '';
            if (!hasBeenModified && isEmpty && fallbackSettings) {
                const fallback = fallbackSettings[key];
                if (fallback !== undefined) {
                    return fallback;
                }
            }
            // Final fallback: schema's declared default. Without this, object
            // fields with a top-level default (e.g. k8s registry's
            // `default: { kind: 'github' }`) render empty because their
            // discriminated-union branch can't be picked from a missing value.
            if (!hasBeenModified && isEmpty && propSchema.default !== undefined) {
                return propSchema.default;
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
        saveMessage,
        validationDetails,
        handleFieldChange,
        handleSave,
        getFieldValue,
    };
}

'use client';

import { useState, useTransition, useEffect, useCallback, useRef } from 'react';
import {
    Directory,
    CreateItemsGeneratorDto,
    DirectoryConfig,
    UpdateItemsGeneratorDto,
    GeneratorFormSchema,
} from '@/lib/api/types-only';
import { RequiredFields } from './RequiredFields';
import { UpdateItemsFields } from './UpdateItemsFields';
import { DynamicPluginFields } from './DynamicPluginFields';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { generateItems, updateItems } from '@/app/actions/dashboard/generator';
import { useTranslations } from 'next-intl';
import {
    GenerateStatusType,
    GenerationMethod,
    WebsiteRepositoryCreationMethod,
} from '@/lib/api/enums';
import { getFormSchema } from '@/app/actions/dashboard/generator-form';
import { useProviderSelection } from '@/lib/hooks/use-provider-selection';
import { ProviderSelectionSection } from '@/components/directories/shared/ProviderSelectionSection';
import { GenerationProgress } from './GenerationProgress';

interface GeneratorFormProps {
    directoryId: string;
    directory: Directory;
    config?: DirectoryConfig;
}

export function GeneratorForm({ directoryId, directory, config }: GeneratorFormProps) {
    const router = useRouter();
    const t = useTranslations('dashboard.directoryDetail.generator');
    const [isPending, startTransition] = useTransition();
    const [optimisticGenerating, setOptimisticGenerating] = useState(false);
    const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
    const [confirmRecreate, setConfirmRecreate] = useState(false);
    const [formSchema, setFormSchema] = useState<GeneratorFormSchema | null>(null);
    const [isLoadingSchema, setIsLoadingSchema] = useState(false);
    const fetchVersionRef = useRef(0);
    const lastFetchedPipelineRef = useRef<string | undefined>(undefined);

    // Check if directory has been generated before
    const isGenerated = !!config?.metadata;
    const lastRequestData = config?.metadata?.last_request_data;
    const initialPrompt = lastRequestData?.prompt || config?.metadata?.initial_prompt || '';

    // Core form data (always present)
    const [coreData, setCoreData] = useState<{
        name: string;
        prompt: string;
        generation_method?: GenerationMethod;
        update_with_pull_request?: boolean;
        website_repository_creation_method?: WebsiteRepositoryCreationMethod;
    }>({
        name: directory.name,
        prompt: initialPrompt,
        generation_method: GenerationMethod.CREATE_UPDATE,
        update_with_pull_request: false,
        website_repository_creation_method:
            lastRequestData?.website_repository_creation_method ||
            WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE,
    });

    // Plugin-specific configuration (dynamic fields from pipeline plugin)
    const [pluginConfig, setPluginConfig] = useState<Record<string, unknown>>({});

    // Provider selection (seeded from config.yaml)
    const {
        providers,
        handleProviderChange,
        buildSelectedProviders,
        getUnconfiguredProviders,
        syncResolvedPipeline,
    } = useProviderSelection(lastRequestData?.providers);

    // Only apply enforce override once on initial load
    const enforceAppliedRef = useRef(false);
    const lastPluginConfigRef = useRef(lastRequestData?.pluginConfig);

    // Load form schema when directory changes or pipeline provider changes
    useEffect(() => {
        const pipelineId = providers.pipeline || undefined;
        if (pipelineId === lastFetchedPipelineRef.current && formSchema) return;

        const version = ++fetchVersionRef.current;

        async function loadFormSchema() {
            setIsLoadingSchema(true);
            try {
                const result = await getFormSchema(directoryId, pipelineId);

                // Discard stale response if pipeline changed while fetching
                if (version !== fetchVersionRef.current) return;

                if (result.success && result.data) {
                    lastFetchedPipelineRef.current = result.data.resolvedPipelineId || pipelineId;
                    setFormSchema(result.data);
                    const defaults: Record<string, unknown> = {};
                    if (result.data.defaultValues) {
                        Object.assign(defaults, result.data.defaultValues);
                    }

                    const lastPipelineId = lastRequestData?.providers?.pipeline || null;
                    const currentPipelineId = providers.pipeline;
                    const isSamePipeline =
                        (currentPipelineId || 'default') === (lastPipelineId || 'default');

                    if (isSamePipeline && lastPluginConfigRef.current) {
                        Object.assign(defaults, lastPluginConfigRef.current);
                    }
                    setPluginConfig(defaults);

                    // Enforce override: switch to enforced pipeline on initial load
                    const enforced = result.data.enforcedPipelineId;
                    if (enforced && !enforceAppliedRef.current && enforced !== pipelineId) {
                        enforceAppliedRef.current = true;
                        handleProviderChange('pipeline', enforced);
                        return;
                    }
                    enforceAppliedRef.current = true;

                    // Sync pipeline when none was set
                    syncResolvedPipeline(result.data);
                }
            } catch (error) {
                if (version !== fetchVersionRef.current) return;
                console.error('Failed to load form schema:', error);
                toast.error(t('failedToLoadFormSchema'));
            } finally {
                if (version === fetchVersionRef.current) {
                    setIsLoadingSchema(false);
                }
            }
        }
        loadFormSchema();
    }, [
        directoryId,
        formSchema,
        handleProviderChange,
        lastRequestData?.providers?.pipeline,
        providers.pipeline,
        syncResolvedPipeline,
        t,
    ]);

    const handleCoreDataChange = useCallback((updates: Partial<typeof coreData>) => {
        setCoreData((prev) => ({ ...prev, ...updates }));
    }, []);

    const handlePluginConfigChange = useCallback((values: Record<string, unknown>) => {
        setPluginConfig(values);
    }, []);

    const optimisticDirectory: Directory = {
        ...directory,
        generateStatus:
            directory.generateStatus?.status === GenerateStatusType.GENERATING
                ? directory.generateStatus
                : {
                      status: GenerateStatusType.GENERATING,
                      progress: 0,
                      recentLogs: [],
                  },
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (
            coreData.generation_method === GenerationMethod.RECREATE &&
            config &&
            Object.keys(config || {}).length > 0 &&
            isGenerated
        ) {
            setConfirmRecreate(true);
            return;
        }

        await submitGeneration();
    };

    const submitGeneration = async () => {
        startTransition(async () => {
            let result;
            const selectedProviders = buildSelectedProviders(formSchema);
            const promptChanged = coreData.prompt.trim() !== initialPrompt.trim();
            const requiresFullGeneration =
                !isGenerated ||
                showAdvancedOptions ||
                coreData.generation_method === GenerationMethod.RECREATE ||
                promptChanged;

            const unconfigured = getUnconfiguredProviders(formSchema);
            if (unconfigured.length > 0) {
                toast.error(t('unconfiguredProviders', { providers: unconfigured.join(', ') }));
                return;
            }

            if (isGenerated && !requiresFullGeneration) {
                // Simple update - only send update-specific fields
                const updateData: UpdateItemsGeneratorDto = {
                    generation_method: coreData.generation_method,
                    update_with_pull_request: coreData.update_with_pull_request,
                    providers: selectedProviders,
                };
                result = await updateItems(directoryId, updateData);
            } else {
                // Full generation - send core data + plugin config
                if (!coreData.prompt.trim()) {
                    toast.error(t('promptRequired'));
                    return;
                }

                const generateData: CreateItemsGeneratorDto = {
                    name: coreData.name,
                    prompt: coreData.prompt,
                    generation_method: coreData.generation_method,
                    update_with_pull_request: coreData.update_with_pull_request,
                    website_repository_creation_method: coreData.website_repository_creation_method,
                    providers: selectedProviders,
                    pluginConfig: Object.keys(pluginConfig).length > 0 ? pluginConfig : undefined,
                };

                result = await generateItems(directoryId, generateData);
            }

            if (result.success) {
                setOptimisticGenerating(true);
                toast.success(result.message || t('operationStartedSuccessfully'));
                router.refresh();
            } else {
                toast.error(result.error || t('failedToStartOperation'));
            }
        });
    };

    // Determine button text based on context
    const getButtonText = () => {
        if (!isGenerated) {
            return t('startGeneration');
        }
        if (coreData.generation_method === GenerationMethod.RECREATE) {
            return t('recreateDirectory');
        }
        return t('updateItems');
    };

    if (optimisticGenerating) {
        return <GenerationProgress directory={optimisticDirectory} />;
    }

    return (
        <form onSubmit={handleSubmit} className="space-y-6 max-w-4xl">
            <RequiredFields formData={coreData} onChange={handleCoreDataChange} />

            {/* Update-specific controls for existing directories */}
            {isGenerated && (
                <UpdateItemsFields
                    generationMethod={coreData.generation_method}
                    updateWithPullRequest={coreData.update_with_pull_request}
                    onChange={handleCoreDataChange}
                />
            )}

            {/* Pipeline & Provider Selection — always visible */}
            {formSchema && (
                <ProviderSelectionSection
                    formSchema={formSchema}
                    providers={providers}
                    onProviderChange={handleProviderChange}
                />
            )}

            {/* Advanced Options Toggle for existing directories */}
            {isGenerated && (
                <div className="flex justify-end">
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setShowAdvancedOptions(!showAdvancedOptions)}
                        className="text-sm"
                    >
                        {showAdvancedOptions ? t('hideAdvancedOptions') : t('showAdvancedOptions')}
                    </Button>
                </div>
            )}

            {/* Dynamic Plugin Fields — shown for new directories or when advanced options toggled */}
            {(!isGenerated || showAdvancedOptions) && (
                <>
                    {isLoadingSchema ? (
                        <LoadingState />
                    ) : (
                        formSchema &&
                        formSchema.pluginFields.length > 0 && (
                            <DynamicPluginFields
                                fields={formSchema.pluginFields}
                                groups={formSchema.pluginGroups}
                                values={pluginConfig}
                                onChange={handlePluginConfigChange}
                            />
                        )
                    )}
                </>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-6">
                <Button
                    type="submit"
                    disabled={isPending}
                    loading={isPending}
                    variant="primary"
                    size="sm"
                >
                    {getButtonText()}
                </Button>
                <Button
                    type="button"
                    onClick={() => router.back()}
                    disabled={isPending}
                    variant="secondary"
                    size="sm"
                >
                    {t('cancel')}
                </Button>
            </div>

            <Dialog open={confirmRecreate} onOpenChange={setConfirmRecreate}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            {t('recreateConfirmTitle', {
                                defaultValue: 'Recreate directory data?',
                            })}
                        </DialogTitle>
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('recreateConfirmDescription', {
                                defaultValue:
                                    'Recreate will delete existing items and regenerate them from scratch. This action cannot be undone.',
                            })}
                        </p>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => setConfirmRecreate(false)}
                            disabled={isPending}
                        >
                            {t('cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="danger"
                            onClick={() => {
                                setConfirmRecreate(false);
                                void submitGeneration();
                            }}
                            disabled={isPending}
                        >
                            {t('confirmRecreate', { defaultValue: 'Yes, recreate' })}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </form>
    );
}

function LoadingState() {
    const t = useTranslations('dashboard.directoryDetail.generator');
    return (
        <div className="flex items-center justify-center py-12">
            <div className="flex items-center gap-3">
                <svg className="animate-spin h-5 w-5 text-primary" fill="none" viewBox="0 0 24 24">
                    <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                    />
                    <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                </svg>
                <span className="text-text-secondary dark:text-text-secondary-dark">
                    {t('loadingFormSchema')}
                </span>
            </div>
        </div>
    );
}

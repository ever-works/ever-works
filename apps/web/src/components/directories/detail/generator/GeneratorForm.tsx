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
import { CompanyFields } from './CompanyFields';
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
import { GenerationMethod, WebsiteRepositoryCreationMethod } from '@/lib/api/enums';
import { getFormSchema } from '@/app/actions/dashboard/generator-form';
import { CollapsibleSection } from '../shared';
import { useProviderSelection } from '@/lib/hooks/use-provider-selection';
import { ProviderSelectionSection } from '@/components/directories/shared/ProviderSelectionSection';

interface GeneratorFormProps {
    directoryId: string;
    directory: Directory;
    config?: DirectoryConfig;
}

export function GeneratorForm({ directoryId, directory, config }: GeneratorFormProps) {
    const router = useRouter();
    const t = useTranslations('dashboard.directoryDetail.generator');
    const [isPending, startTransition] = useTransition();
    const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
    const [confirmRecreate, setConfirmRecreate] = useState(false);
    const [formSchema, setFormSchema] = useState<GeneratorFormSchema | null>(null);
    const [isLoadingSchema, setIsLoadingSchema] = useState(true);

    // Check if directory has been generated before
    const isGenerated = !!config?.metadata;
    const initialPrompt = config?.metadata?.initial_prompt || '';
    const lastRequestData = config?.metadata?.last_request_data;

    // Core form data (always present)
    const [coreData, setCoreData] = useState<{
        name: string;
        prompt: string;
        company?: { name: string; website: string };
        repository_description?: string;
        generation_method?: GenerationMethod;
        update_with_pull_request?: boolean;
        website_repository_creation_method?: WebsiteRepositoryCreationMethod;
    }>({
        name: directory.name,
        prompt: initialPrompt,
        company: lastRequestData?.company || undefined,
        repository_description: lastRequestData?.repository_description || '',
        generation_method: GenerationMethod.CREATE_UPDATE,
        update_with_pull_request: false,
        website_repository_creation_method:
            lastRequestData?.website_repository_creation_method ||
            WebsiteRepositoryCreationMethod.CREATE_USING_TEMPLATE,
    });

    // Plugin-specific configuration (dynamic fields from pipeline plugin)
    const [pluginConfig, setPluginConfig] = useState<Record<string, unknown>>({});

    // Provider selection (null = use directory/system default)
    const { providers, handleProviderChange, isFullPipeline, buildSelectedProviders } =
        useProviderSelection(lastRequestData?.providers);

    // Seed data from the previous generation — used once during schema init,
    // should not trigger re-fetches when the parent re-renders with a new config reference.
    const lastPluginConfigRef = useRef(lastRequestData?.pluginConfig);

    // Load form schema when directory changes
    useEffect(() => {
        async function loadFormSchema() {
            setIsLoadingSchema(true);
            try {
                const result = await getFormSchema(directoryId);
                if (result.success && result.data) {
                    setFormSchema(result.data);
                    // Initialize plugin config with default values
                    const defaults: Record<string, unknown> = {};
                    if (result.data.defaultValues) {
                        Object.assign(defaults, result.data.defaultValues);
                    }
                    // Merge with last request data's plugin config if available
                    if (lastPluginConfigRef.current) {
                        Object.assign(defaults, lastPluginConfigRef.current);
                    }
                    setPluginConfig(defaults);
                }
            } catch (error) {
                console.error('Failed to load form schema:', error);
                toast.error(t('failedToLoadFormSchema'));
            } finally {
                setIsLoadingSchema(false);
            }
        }
        loadFormSchema();
    }, [directoryId, t]);

    const handleCoreDataChange = useCallback((updates: Partial<typeof coreData>) => {
        setCoreData((prev) => ({ ...prev, ...updates }));
    }, []);

    const handlePluginConfigChange = useCallback((values: Record<string, unknown>) => {
        setPluginConfig(values);
    }, []);

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

            if (
                isGenerated &&
                !showAdvancedOptions &&
                coreData.generation_method !== GenerationMethod.RECREATE
            ) {
                // Simple update - only send update-specific fields
                const updateData: UpdateItemsGeneratorDto = {
                    generation_method: coreData.generation_method,
                    update_with_pull_request: coreData.update_with_pull_request,
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
                    company: coreData.company,
                    repository_description: coreData.repository_description,
                    generation_method: coreData.generation_method,
                    update_with_pull_request: coreData.update_with_pull_request,
                    website_repository_creation_method: coreData.website_repository_creation_method,
                    providers: buildSelectedProviders(),
                    pluginConfig: Object.keys(pluginConfig).length > 0 ? pluginConfig : undefined,
                };

                result = await generateItems(directoryId, generateData);
            }

            if (result.success) {
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

    if (isLoadingSchema) {
        return (
            <div className="flex items-center justify-center py-12">
                <div className="flex items-center gap-3">
                    <svg
                        className="animate-spin h-5 w-5 text-primary"
                        fill="none"
                        viewBox="0 0 24 24"
                    >
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

    return (
        <form onSubmit={handleSubmit} className="space-y-6 max-w-4xl">
            {/* Show update fields for existing directories, full fields for new/expanded */}
            {isGenerated && !showAdvancedOptions ? (
                <UpdateItemsFields
                    generationMethod={coreData.generation_method}
                    updateWithPullRequest={coreData.update_with_pull_request}
                    onChange={handleCoreDataChange}
                />
            ) : (
                <RequiredFields formData={coreData} onChange={handleCoreDataChange} />
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

            {/* Show additional advanced options for new directories or when toggled */}
            {(!isGenerated || showAdvancedOptions) && (
                <>
                    {formSchema && (
                        <ProviderSelectionSection
                            formSchema={formSchema}
                            providers={providers}
                            onProviderChange={handleProviderChange}
                            isFullPipeline={isFullPipeline}
                        />
                    )}

                    {/* Company Information */}
                    <CollapsibleSection
                        title={t('companyInformation')}
                        description={t('companyInfoDescription')}
                        defaultExpanded={false}
                    >
                        <CompanyFields
                            company={coreData.company}
                            onChange={(company) => handleCoreDataChange({ company })}
                        />
                    </CollapsibleSection>

                    {/* Dynamic Plugin Fields */}
                    {formSchema && formSchema.pluginFields.length > 0 && (
                        <DynamicPluginFields
                            fields={formSchema.pluginFields}
                            groups={formSchema.pluginGroups}
                            values={pluginConfig}
                            onChange={handlePluginConfigChange}
                        />
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
                    size="lg"
                >
                    {getButtonText()}
                </Button>
                <Button
                    type="button"
                    onClick={() => router.back()}
                    disabled={isPending}
                    variant="secondary"
                    size="lg"
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

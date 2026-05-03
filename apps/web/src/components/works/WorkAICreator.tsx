'use client';

import { useState, useTransition, useEffect, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import { createWorkWithAI } from '@/app/actions/dashboard';
import { getGlobalFormSchema } from '@/app/actions/dashboard/generator-form';
import { ROUTES } from '@/lib/constants';
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { RepositoryOwnerCard } from './RepositoryOwnerCard';
import { DynamicPluginFields } from './detail/generator/DynamicPluginFields';
import { ProviderSelectionSection } from './shared/ProviderSelectionSection';
import { WebsiteTemplateSelector } from './shared/WebsiteTemplateSelector';
import { CollapsibleSection } from './detail/shared';
import { Lightbulb, Check } from 'lucide-react';
import { useProviderSelection } from '@/lib/hooks/use-provider-selection';
import type { GeneratorFormSchema } from '@/lib/api/types-only';
import type { WebsiteTemplateOption } from '@/lib/api/work';

interface WorkAICreatorProps {
    gitProvider?: string;
    gitConnected?: boolean;
    deployProvider?: string;
    websiteTemplates: WebsiteTemplateOption[];
}

export function WorkAICreator({
    gitProvider,
    gitConnected,
    deployProvider,
    websiteTemplates,
}: WorkAICreatorProps) {
    const [prompt, setPrompt] = useState('');
    const [workName, setWorkName] = useState('');
    const [organization, setOrganization] = useState(false);
    const [owner, setOwner] = useState('');
    const [websiteTemplateId, setWebsiteTemplateId] = useState(
        websiteTemplates.find((template) => template.isDefault)?.id ||
            websiteTemplates[0]?.id ||
            '',
    );
    const [isPending, startTransition] = useTransition();
    const router = useRouter();
    const t = useTranslations('dashboard.workCreation.ai');

    // Provider/pipeline selection state
    const [formSchema, setFormSchema] = useState<GeneratorFormSchema | null>(null);
    const {
        providers,
        handleProviderChange,
        buildSelectedProviders,
        getUnconfiguredProviders,
        syncResolvedPipeline,
    } = useProviderSelection();
    const [pluginConfig, setPluginConfig] = useState<Record<string, unknown>>({});
    const fetchVersionRef = useRef(0);
    const lastFetchedPipelineRef = useRef<string | undefined>(undefined);
    const enforceAppliedRef = useRef(false);

    // Load form schema when pipeline provider changes
    useEffect(() => {
        const pipelineId = providers.pipeline || undefined;
        if (pipelineId === lastFetchedPipelineRef.current && formSchema) return;

        const version = ++fetchVersionRef.current;

        async function loadSchema() {
            try {
                const result = await getGlobalFormSchema(pipelineId);
                if (version !== fetchVersionRef.current) return;
                if (result.success && result.data) {
                    lastFetchedPipelineRef.current = result.data.resolvedPipelineId || pipelineId;
                    setFormSchema(result.data);
                    if (result.data.defaultValues) {
                        setPluginConfig({ ...result.data.defaultValues });
                    }

                    // Enforce override on initial load
                    const enforced = result.data.enforcedPipelineId;
                    if (enforced && !enforceAppliedRef.current && enforced !== pipelineId) {
                        enforceAppliedRef.current = true;
                        handleProviderChange('pipeline', enforced);
                        return;
                    }
                    enforceAppliedRef.current = true;

                    // Sync pipeline selection to server-resolved ID
                    syncResolvedPipeline(result.data);
                }
            } catch (error) {
                if (version !== fetchVersionRef.current) return;
                console.error('Failed to load form schema:', error);
            }
        }
        loadSchema();
    }, [formSchema, providers.pipeline, syncResolvedPipeline, handleProviderChange]);

    const handlePluginConfigChange = useCallback((values: Record<string, unknown>) => {
        setPluginConfig(values);
    }, []);

    const handleGenerate = async () => {
        if (!workName.trim()) {
            toast.error(t('errors.nameRequired'));
            return;
        }

        if (!prompt.trim()) {
            toast.error(t('errors.promptRequired'));
            return;
        }

        const unconfigured = getUnconfiguredProviders(formSchema);
        if (unconfigured.length > 0) {
            toast.error(t('errors.unconfiguredProviders', { providers: unconfigured.join(', ') }));
            return;
        }

        startTransition(async () => {
            const result = await createWorkWithAI({
                name: workName,
                prompt,
                organization,
                owner: organization ? owner : undefined,
                gitProvider,
                deployProvider,
                providers: buildSelectedProviders(formSchema),
                pluginConfig: Object.keys(pluginConfig).length > 0 ? pluginConfig : undefined,
                websiteTemplateId: websiteTemplateId || undefined,
            });

            if (result.success) {
                toast.success(result.message || t('success.started'));
                if (result.isGenerating) {
                    toast.info(t('success.generating'));
                }

                if (result.work) {
                    router.push(ROUTES.DASHBOARD_WORK(result.work.id));
                } else {
                    router.push(ROUTES.DASHBOARD_WORKS);
                }
            } else if (result.requiresGitProvider) {
                toast.error(result.error || t('errors.githubRequired'));
                router.push(ROUTES.DASHBOARD_WORKS_NEW);
            } else {
                toast.error(result.error || t('errors.createFailed'));
            }
        });
    };

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-3xl font-bold text-text dark:text-text-dark mb-2">
                    {t('formTitle')}
                </h1>
                <p className="text-text-secondary dark:text-text-secondary-dark">
                    {t('formSubtitle')}
                </p>
            </div>

            <div
                className={cn(
                    'p-6 rounded-lg',
                    'bg-card dark:bg-transparent',
                    'border border-card-border dark:border-border-secondary-dark',
                )}
            >
                <div className="space-y-6">
                    {/* Work Name */}
                    <Input
                        label={`${t('workNameLabel')} *`}
                        type="text"
                        value={workName}
                        onChange={(e) => setWorkName(e.target.value)}
                        placeholder={t('workNamePlaceholder')}
                        variant="form"
                    />

                    {/* AI Prompt */}
                    <Textarea
                        label={`${t('promptLabel')} *`}
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder={t('promptPlaceholder')}
                        rows={6}
                        variant="form"
                    />

                    {/* Example Prompts */}
                    <ExamplePrompts
                        selectedName={workName}
                        onSelect={(selectedPrompt, selectedName) => {
                            setPrompt(selectedPrompt);
                            setWorkName(selectedName);

                            document
                                .getElementById('main-content')
                                ?.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                    />

                    {/* AI Features Info */}
                    <div className="p-4 rounded-lg">
                        <h4 className="text-sm font-medium text-text dark:text-text-dark mb-2">
                            {t('featuresTitle')}
                        </h4>
                        <ul className="space-y-1 text-sm text-text-secondary dark:text-text-secondary-dark border-l border-primary/20 pl-4">
                            <li className="flex items-start gap-2">
                                <Check className="w-4 h-4 bg-black dark:bg-white p-1 rounded-full text-white dark:text-black mt-0.5 shrink-0" />
                                <span>{t('features.0')}</span>
                            </li>
                            <li className="flex items-start gap-2">
                                <Check className="w-4 h-4 bg-black dark:bg-white p-1 rounded-full text-white dark:text-black mt-0.5 shrink-0" />
                                <span>{t('features.1')}</span>
                            </li>
                            <li className="flex items-start gap-2">
                                <Check className="w-4 h-4 bg-black dark:bg-white p-1 rounded-full text-white dark:text-black mt-0.5 shrink-0" />
                                <span>{t('features.2')}</span>
                            </li>
                            <li className="flex items-start gap-2">
                                <Check className="w-4 h-4 bg-black dark:bg-white p-1 rounded-full text-white dark:text-black mt-0.5 shrink-0" />
                                <span>{t('features.3')}</span>
                            </li>
                        </ul>
                    </div>
                </div>
            </div>

            <RepositoryOwnerCard
                gitProvider={gitProvider}
                gitConnected={gitConnected}
                owner={owner}
                onChange={(value, isOrganization) => {
                    setOwner(value);
                    setOrganization(isOrganization);
                }}
                disabled={isPending}
            />

            <WebsiteTemplateSelector
                templates={websiteTemplates}
                value={websiteTemplateId}
                onChange={setWebsiteTemplateId}
                disabled={isPending}
                helperText={t('websiteTemplateHelperText')}
            />

            {formSchema && (
                <CollapsibleSection
                    title={t('advancedSettings')}
                    description={t('advancedSubtitle')}
                    defaultExpanded={true}
                >
                    <div className="space-y-4">
                        <ProviderSelectionSection
                            formSchema={formSchema}
                            providers={providers}
                            onProviderChange={handleProviderChange}
                        />
                        {formSchema.pluginFields.length > 0 && (
                            <DynamicPluginFields
                                fields={formSchema.pluginFields}
                                groups={formSchema.pluginGroups}
                                values={pluginConfig}
                                onChange={handlePluginConfigChange}
                            />
                        )}
                    </div>
                </CollapsibleSection>
            )}

            {/* Action Buttons */}
            <div className="flex gap-3">
                <Button
                    onClick={handleGenerate}
                    disabled={isPending || !prompt.trim()}
                    loading={isPending}
                    variant="primary"
                    size="lg"
                    fullWidth
                >
                    {isPending ? (
                        t('generatingButton')
                    ) : (
                        <>
                            <Lightbulb className="w-5 h-5" />
                            {t('generateButton')}
                        </>
                    )}
                </Button>
                <Button
                    onClick={() => router.back()}
                    disabled={isPending}
                    variant="secondary"
                    size="lg"
                    className="px-6"
                >
                    {t('cancelButton')}
                </Button>
            </div>

            <div
                className={cn(
                    'p-4 rounded-lg',
                    'bg-surface dark:bg-surface-dark',
                    'border border-border dark:border-border-dark',
                )}
            >
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    <strong>{t('noteTitle')}</strong> {t('noteText')}
                </p>
            </div>
        </div>
    );
}

function ExamplePrompts({
    onSelect,
    selectedName,
}: {
    onSelect: (prompt: string, name: string) => void;
    selectedName: string;
}) {
    const t = useTranslations('dashboard.workCreation.ai');

    const examplePrompts = [
        {
            name: t('examplePrompts.0.name'),
            prompt: t('examplePrompts.0.prompt'),
        },
        {
            name: t('examplePrompts.1.name'),
            prompt: t('examplePrompts.1.prompt'),
        },
        {
            name: t('examplePrompts.2.name'),
            prompt: t('examplePrompts.2.prompt'),
        },
        {
            name: t('examplePrompts.3.name'),
            prompt: t('examplePrompts.3.prompt'),
        },
    ];

    return (
        <div>
            <p className="text-sm text-text-secondary dark:text-text-secondary-dark mb-3">
                {t('inspirationText')}
            </p>
            <div className="flex flex-wrap gap-2">
                {examplePrompts.map((example, index) => (
                    <Button
                        key={index}
                        onClick={() => onSelect(example.prompt, example.name)}
                        variant="ghost"
                        size="sm"
                        className={cn(
                            'rounded-full py-1 cursor-pointer font-medium',
                            'bg-surface dark:bg-card-secondary-dark/80',
                            'border border-border dark:border-border-dark',
                            'text-text-secondary dark:text-text-dark',
                            'hover:bg-button-primary hover:border-button-primary hover:text-button-primary-foreground',
                            'dark:hover:bg-button-primary-dark dark:hover:border-button-primary-dark dark:hover:text-button-primary-foreground-dark',
                            selectedName === example.name &&
                                'bg-button-primary border-button-primary text-button-primary-foreground dark:bg-button-primary-dark dark:border-button-primary-dark dark:text-button-primary-foreground-dark',
                        )}
                    >
                        {example.name}
                    </Button>
                ))}
            </div>
        </div>
    );
}

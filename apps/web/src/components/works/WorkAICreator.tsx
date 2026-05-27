'use client';

import { useState, useTransition, useEffect, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import { createWorkWithAI } from '@/app/actions/dashboard';

/**
 * Browser-side slug helper. Mirrors `slugify` from `@ever-works/plugin`
 * but lives here so this client component doesn't pull in the
 * server-only plugin package. Lowercase letters + digits, hyphen-
 * joined, leading/trailing hyphens stripped.
 */
function slugifyForWork(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
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
import type { WorkProposal } from '@/lib/api/work-proposals';

type InitialWorkKind = 'website' | 'landing-page' | 'blog' | 'directory' | 'awesome-repo';

interface WorkAICreatorProps {
    gitProvider?: string;
    gitConnected?: boolean;
    deployProvider?: string;
    websiteTemplates: WebsiteTemplateOption[];
    proposal?: WorkProposal;
    initialPrompt?: string;
    initialKind?: InitialWorkKind;
}

export function WorkAICreator({
    gitProvider,
    gitConnected,
    deployProvider,
    websiteTemplates,
    proposal,
    initialPrompt,
    initialKind,
}: WorkAICreatorProps) {
    const [prompt, setPrompt] = useState(proposal?.generatedPrompt ?? initialPrompt ?? '');
    const [workName, setWorkName] = useState(proposal?.title ?? '');
    // Slug is auto-generated from the name (mirrors WorkManualForm's
    // generateSlug) but stays user-editable so the combined Create
    // form lets users override the repo / URL identifier without
    // having to re-name the Work. We track whether the slug has been
    // manually edited so name changes don't overwrite a custom slug.
    const [slug, setSlug] = useState(
        proposal?.slugSuggestion ?? slugifyForWork(proposal?.title ?? ''),
    );
    const [slugDirty, setSlugDirty] = useState(Boolean(proposal?.slugSuggestion));
    const [organization, setOrganization] = useState(false);
    const [owner, setOwner] = useState('');
    const [websiteTemplateId, setWebsiteTemplateId] = useState('');
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
                slug: slug.trim() || undefined,
                prompt,
                organization,
                owner: organization ? owner : undefined,
                gitProvider,
                deployProvider,
                providers: buildSelectedProviders(formSchema),
                pluginConfig: Object.keys(pluginConfig).length > 0 ? pluginConfig : undefined,
                websiteTemplateId: websiteTemplateId || undefined,
                proposalId: proposal?.id,
                workKind: initialKind,
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
                        onChange={(e) => {
                            const nextName = e.target.value;
                            setWorkName(nextName);
                            // Sync slug to the new name only when the user
                            // hasn't manually edited it — mirrors the
                            // legacy WorkManualForm behaviour so a quick
                            // rename keeps the slug aligned for free.
                            if (!slugDirty) {
                                setSlug(slugifyForWork(nextName));
                            }
                        }}
                        placeholder={t('workNamePlaceholder')}
                        variant="form"
                    />

                    {/* Slug — auto-generated from name, user-editable.
                        Carried over from the legacy WorkManualForm so the
                        combined Create form covers everything the manual
                        form did. */}
                    <Input
                        label={t('slugLabel')}
                        type="text"
                        value={slug}
                        onChange={(e) => {
                            setSlug(e.target.value);
                            setSlugDirty(true);
                        }}
                        placeholder={t('slugPlaceholder')}
                        pattern="[a-z0-9-]+"
                        helperText={t('slugHelp')}
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

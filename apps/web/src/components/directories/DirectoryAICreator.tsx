'use client';

import { useState, useTransition, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import { createDirectoryWithAI } from '@/app/actions/dashboard';
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
import { CollapsibleSection } from './detail/shared';
import { Lightbulb, Check } from 'lucide-react';
import { useProviderSelection } from '@/lib/hooks/use-provider-selection';
import type { GeneratorFormSchema } from '@/lib/api/types-only';

interface DirectoryAICreatorProps {
    gitProvider?: string;
    gitConnected?: boolean;
    deployProvider?: string;
}

export function DirectoryAICreator({
    gitProvider,
    gitConnected,
    deployProvider,
}: DirectoryAICreatorProps) {
    const [prompt, setPrompt] = useState('');
    const [directoryName, setDirectoryName] = useState('');
    const [organization, setOrganization] = useState(false);
    const [owner, setOwner] = useState('');
    const [isPending, startTransition] = useTransition();
    const router = useRouter();
    const t = useTranslations('dashboard.directoryCreation.ai');

    // Provider/pipeline selection state
    const [formSchema, setFormSchema] = useState<GeneratorFormSchema | null>(null);
    const {
        providers,
        handleProviderChange,
        isFullPipeline,
        buildSelectedProviders,
        getUnconfiguredProviders,
    } = useProviderSelection();
    const [pluginConfig, setPluginConfig] = useState<Record<string, unknown>>({});

    // Load form schema on mount
    useEffect(() => {
        async function loadSchema() {
            try {
                const result = await getGlobalFormSchema();
                if (result.success && result.data) {
                    setFormSchema(result.data);
                    if (result.data.defaultValues) {
                        setPluginConfig({ ...result.data.defaultValues });
                    }
                }
            } catch (error) {
                console.error('Failed to load form schema:', error);
            }
        }
        loadSchema();
    }, []);

    const handlePluginConfigChange = useCallback((values: Record<string, unknown>) => {
        setPluginConfig(values);
    }, []);

    const handleGenerate = async () => {
        if (!directoryName.trim()) {
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
            const result = await createDirectoryWithAI({
                name: directoryName,
                prompt,
                organization,
                owner: organization ? owner : undefined,
                gitProvider,
                deployProvider,
                providers: buildSelectedProviders(formSchema),
                pluginConfig: Object.keys(pluginConfig).length > 0 ? pluginConfig : undefined,
            });

            if (result.success) {
                toast.success(result.message || t('success.started'));
                if (result.isGenerating) {
                    toast.info(t('success.generating'));
                }

                if (result.directory) {
                    router.push(ROUTES.DASHBOARD_DIRECTORY(result.directory.id));
                } else {
                    router.push(ROUTES.DASHBOARD_DIRECTORIES);
                }
            } else if (result.requiresGitProvider) {
                toast.error(result.error || 'Git provider connection required');
                router.push(ROUTES.DASHBOARD_DIRECTORIES_NEW);
            } else {
                toast.error(result.error || 'Failed to create directory');
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
                    'bg-card dark:bg-card-dark',
                    'border border-card-border dark:border-card-border-dark',
                )}
            >
                <div className="space-y-6">
                    {/* Directory Name */}
                    <Input
                        label={`${t('directoryNameLabel')} *`}
                        type="text"
                        value={directoryName}
                        onChange={(e) => setDirectoryName(e.target.value)}
                        placeholder={t('directoryNamePlaceholder')}
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
                        onSelect={(selectedPrompt, selectedName) => {
                            setPrompt(selectedPrompt);
                            setDirectoryName(selectedName);

                            document
                                .getElementById('main-content')
                                ?.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                    />

                    {/* AI Features Info */}
                    <div className={cn('p-4 rounded-lg', 'bg-primary/5 border border-primary/20')}>
                        <h4 className="text-sm font-medium text-text dark:text-text-dark mb-2">
                            {t('featuresTitle')}
                        </h4>
                        <ul className="space-y-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                            <li className="flex items-start gap-2">
                                <Check className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                                <span>{t('features.0')}</span>
                            </li>
                            <li className="flex items-start gap-2">
                                <Check className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                                <span>{t('features.1')}</span>
                            </li>
                            <li className="flex items-start gap-2">
                                <Check className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                                <span>{t('features.2')}</span>
                            </li>
                            <li className="flex items-start gap-2">
                                <Check className="w-4 h-4 text-primary mt-0.5 shrink-0" />
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

            {formSchema && (
                <CollapsibleSection
                    title={t('advancedSettings')}
                    description={t('advancedSubtitle')}
                    defaultExpanded={false}
                >
                    <div className="space-y-4">
                        <ProviderSelectionSection
                            formSchema={formSchema}
                            providers={providers}
                            onProviderChange={handleProviderChange}
                            isFullPipeline={isFullPipeline}
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

function ExamplePrompts({ onSelect }: { onSelect: (prompt: string, name: string) => void }) {
    const t = useTranslations('dashboard.directoryCreation.ai');

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
                            'rounded-full',
                            'bg-surface dark:bg-surface-dark',
                            'border border-border dark:border-border-dark',
                            'text-text-secondary dark:text-text-secondary-dark',
                            'hover:border-primary hover:text-primary',
                        )}
                    >
                        {example.name}
                    </Button>
                ))}
            </div>
        </div>
    );
}

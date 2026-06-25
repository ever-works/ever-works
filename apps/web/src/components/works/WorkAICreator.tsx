'use client';

import { useState, useTransition, useEffect, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import { createWorkWithAI, checkWorkSlug } from '@/app/actions/dashboard';

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

/** Debounce window for the live slug-availability check (ms). */
const SLUG_CHECK_DEBOUNCE_MS = 400;

/**
 * Live slug-availability state, mirroring the GitHub "create a new
 * repository" name check. `available`/`taken` carry the server-normalized
 * slug so the hint reflects exactly what would be created.
 */
type SlugStatus =
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'available'; slug: string }
    | { kind: 'taken'; slug: string; suggestion?: string }
    | { kind: 'error'; slug: string };

/**
 * Resolved (server-answered) slug states only — `idle`/`checking` are derived
 * during render from whether this result still matches the current slug, so we
 * never call setState synchronously inside the check effect.
 */
type SlugCheckResult = Exclude<SlugStatus, { kind: 'idle' } | { kind: 'checking' }>;
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
import { Lightbulb, Check, X, Loader2 } from 'lucide-react';
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
    const [slugResult, setSlugResult] = useState<SlugCheckResult | null>(null);
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

    // Live, debounced slug-availability check (GitHub "create a new
    // repository" style). Each keystroke resets the timer; the request only
    // fires once typing pauses. We store ONLY the resolved server answer
    // (keyed by the slug it was computed for) and derive idle/checking during
    // render — so the effect never calls setState synchronously in its body.
    // A monotonically-increasing version guards against out-of-order responses
    // overwriting a newer check.
    const slugCandidate = slugifyForWork(slug);
    const slugCheckVersionRef = useRef(0);
    useEffect(() => {
        if (!slugCandidate) return;
        const version = ++slugCheckVersionRef.current;
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const result = await checkWorkSlug(slugCandidate);
                    if (version !== slugCheckVersionRef.current) return;
                    if ('error' in result) {
                        setSlugResult({ kind: 'error', slug: slugCandidate });
                    } else if (result.available) {
                        setSlugResult({ kind: 'available', slug: result.slug });
                    } else {
                        setSlugResult({
                            kind: 'taken',
                            slug: result.slug,
                            suggestion: result.suggestion,
                        });
                    }
                } catch {
                    if (version !== slugCheckVersionRef.current) return;
                    setSlugResult({ kind: 'error', slug: slugCandidate });
                }
            })();
        }, SLUG_CHECK_DEBOUNCE_MS);

        return () => clearTimeout(timer);
    }, [slugCandidate]);

    // Derived display status — `checking` whenever the latest resolved answer
    // doesn't (yet) match the current slug; `idle` when there's nothing to
    // check. No state/effect round-trip.
    const slugStatus: SlugStatus = !slugCandidate
        ? { kind: 'idle' }
        : slugResult && slugResult.slug === slugCandidate
          ? slugResult
          : { kind: 'checking' };

    // Single entry point for setting the slug. When the new value normalizes
    // to an empty candidate, drop any cached availability answer so a later
    // re-type of the same slug triggers a fresh check instead of briefly
    // flashing the stale 'taken'/'available' result during the debounce window
    // (a re-typed 'taken' would otherwise disable Generate for 400ms with no
    // live check behind it). Clearing here (an event-driven setState) keeps the
    // availability effect free of synchronous setState.
    const setSlugValue = useCallback((next: string) => {
        setSlug(next);
        if (!slugifyForWork(next)) {
            setSlugResult(null);
        }
    }, []);

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

        // Block on a known-taken slug before hitting the API — the create
        // call would 409 anyway ("Work already exists"). Mirrors GitHub
        // disabling "Create repository" when the name is taken.
        if (slugStatus.kind === 'taken') {
            toast.error(t('errors.slugTaken'));
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
                // Submit the same normalized candidate the live check
                // validated (e.g. "My Work 2" -> "my-work-2"), not the raw
                // field text — otherwise the server's slug regex rejects it
                // and the user sees a format error despite the green
                // "available" badge.
                slug: slugCandidate || undefined,
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
                        name="name"
                        value={workName}
                        onChange={(e) => {
                            const nextName = e.target.value;
                            setWorkName(nextName);
                            // Sync slug to the new name only when the user
                            // hasn't manually edited it — mirrors the
                            // legacy WorkManualForm behaviour so a quick
                            // rename keeps the slug aligned for free.
                            if (!slugDirty) {
                                setSlugValue(slugifyForWork(nextName));
                            }
                        }}
                        placeholder={t('workNamePlaceholder')}
                        variant="form"
                    />

                    {/* Slug — auto-generated from name, user-editable.
                        Carried over from the legacy WorkManualForm so the
                        combined Create form covers everything the manual
                        form did. A live, debounced availability check
                        mirrors GitHub's "create a new repository" name
                        check (see SlugAvailabilityHint below). */}
                    <div className="space-y-1.5">
                        <Input
                            label={t('slugLabel')}
                            type="text"
                            name="slug"
                            value={slug}
                            onChange={(e) => {
                                setSlugValue(e.target.value);
                                setSlugDirty(true);
                            }}
                            placeholder={t('slugPlaceholder')}
                            pattern="[a-z0-9-]+"
                            helperText={t('slugHelp')}
                            variant="form"
                            aria-invalid={slugStatus.kind === 'taken'}
                            aria-describedby="work-slug-status"
                        />
                        <SlugAvailabilityHint
                            status={slugStatus}
                            onUseSuggestion={(suggestion) => {
                                setSlugValue(suggestion);
                                setSlugDirty(true);
                                // Keep the Work Name aligned with the
                                // de-duplicated slug so they don't drift and
                                // the name isn't a duplicate either: append the
                                // slug's disambiguating suffix (e.g. "-2") to
                                // the name as " 2". Only when the suggestion is
                                // the taken base slug plus a suffix and a name
                                // is present.
                                if (slugStatus.kind === 'taken') {
                                    const base = slugStatus.slug;
                                    if (
                                        suggestion.startsWith(`${base}-`) &&
                                        workName.trim()
                                    ) {
                                        const suffix = suggestion.slice(base.length + 1);
                                        setWorkName((prev) => `${prev.trim()} ${suffix}`);
                                    }
                                }
                            }}
                        />
                    </div>

                    {/* AI Prompt */}
                    <Textarea
                        label={`${t('promptLabel')} *`}
                        name="prompt"
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
                            // Picking an example is an explicit "use this idea"
                            // replacement, so it re-derives the slug from the
                            // example name even if the slug was previously
                            // edited or filled from a "-2" suggestion — keeping
                            // name and slug in sync. Clearing the dirty flag
                            // lets later name edits keep updating the slug.
                            setSlugValue(slugifyForWork(selectedName));
                            setSlugDirty(false);

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
                    disabled={isPending || !prompt.trim() || slugStatus.kind === 'taken'}
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

/**
 * GitHub-style slug-availability hint rendered under the Work Slug input.
 * Shows a spinner while checking, a green check + "available" when free, and
 * an amber warning + one-click suggestion when the slug is already taken on
 * the user's account.
 */
function SlugAvailabilityHint({
    status,
    onUseSuggestion,
}: {
    status: SlugStatus;
    onUseSuggestion: (suggestion: string) => void;
}) {
    const t = useTranslations('dashboard.workCreation.ai');

    if (status.kind === 'idle') {
        return null;
    }

    return (
        <div
            id="work-slug-status"
            aria-live="polite"
            className="flex items-center gap-1.5 text-xs"
        >
            {status.kind === 'checking' && (
                <span className="flex items-center gap-1.5 text-text-muted dark:text-text-muted-dark">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {t('slugChecking')}
                </span>
            )}
            {status.kind === 'available' && (
                <span className="flex items-center gap-1.5 text-success">
                    <Check className="w-3.5 h-3.5" />
                    {t('slugAvailable', { slug: status.slug })}
                </span>
            )}
            {status.kind === 'taken' &&
                (() => {
                    const { suggestion } = status;
                    return (
                        <span className="flex flex-wrap items-center gap-1.5 text-warning">
                            <X className="w-3.5 h-3.5 shrink-0" />
                            <span>{t('slugTakenName', { slug: status.slug })}</span>
                            {suggestion && (
                                <button
                                    type="button"
                                    onClick={() => onUseSuggestion(suggestion)}
                                    className="font-medium underline underline-offset-2 hover:no-underline cursor-pointer"
                                >
                                    {t('slugUseSuggestion', { suggestion })}
                                </button>
                            )}
                        </span>
                    );
                })()}
            {status.kind === 'error' && (
                <span className="text-text-muted dark:text-text-muted-dark">
                    {t('slugCheckError')}
                </span>
            )}
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

    // Data-driven so the chip list adapts to however many examples a locale
    // defines (en ships 8; locales with fewer simply render fewer — no missing
    // -key crashes). Numeric-string keys ("0".."7") iterate in ascending order.
    const examplePrompts = Object.values(
        (t.raw as (key: string) => Record<string, { name: string; prompt: string }>)(
            'examplePrompts',
        ),
    );

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

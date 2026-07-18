'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
    BookOpen,
    Building2,
    FolderOpen,
    Globe,
    LayoutTemplate,
    Files,
    Minimize2,
    Search,
    Star,
    Store,
    type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { WebsiteTemplateOption } from '@/lib/api/work';
import type { WorkBlueprintEntry } from '@/lib/api/work-templates';

/**
 * Create-Work template picker (Works Templates spec, ADR-014 §4.2–4.5).
 *
 * Additive control that layers a `chipType` filter + a search/autocomplete
 * selector (built for hundreds of blueprints) on top of the existing
 * website-template selection. It does NOT replace `WebsiteTemplateSelector`
 * (kept intact for the legacy manual form) — it is a new surface used by the
 * unified Create-Work flow (`WorkAICreator`).
 *
 * Sources, merged in precedence order for the selected chip:
 *   1. the user's own custom `Template` rows ("Your templates") — FIRST;
 *   2. the manifest blueprints for that chipType ("Blueprints").
 * Placeholder blueprints (no repo yet) are excluded from the pickable list.
 * The selector line renders only when the selected chip resolves to ≥1
 * pickable template. The manifest `default: true` blueprint (or the user's
 * default custom row) is highlighted when no explicit value is set — an empty
 * value keeps the existing "use my default template" semantics on submit.
 */

/** Stable display order + the known `chipType` facet values. */
const CHIP_TYPE_ORDER = [
    'website',
    'landing',
    'blog',
    'directory',
    'store',
    'company',
    'awesome',
] as const;
type ChipTypeName = (typeof CHIP_TYPE_ORDER)[number];

/** Maps a Work-kind chip value to the manifest `chipType` facet. */
const KIND_TO_CHIP_TYPE: Record<string, ChipTypeName> = {
    website: 'website',
    'landing-page': 'landing',
    blog: 'blog',
    directory: 'directory',
    'awesome-repo': 'awesome',
    store: 'store',
    company: 'company',
};

/** Curated lucide icons for chip types + blueprint `iconName` fields.
 *  Imported explicitly (not a dynamic barrel) to keep the bundle lean. */
const CHIP_TYPE_ICON: Record<string, LucideIcon> = {
    website: Globe,
    landing: Files,
    blog: BookOpen,
    directory: FolderOpen,
    store: Store,
    company: Building2,
    awesome: Star,
};

const ICON_BY_NAME: Record<string, LucideIcon> = {
    Globe,
    Files,
    BookOpen,
    FolderOpen,
    Store,
    Building2,
    Star,
    LayoutTemplate,
    Minimize2,
};

function resolveOptionIcon(iconName?: string, chipType?: string): LucideIcon {
    return (
        (iconName && ICON_BY_NAME[iconName]) ||
        (chipType && CHIP_TYPE_ICON[chipType]) ||
        LayoutTemplate
    );
}

interface PickerOption {
    /** websiteTemplateId — custom row id or blueprint slug. */
    value: string;
    name: string;
    description: string;
    group: 'yours' | 'blueprints';
    iconName?: string;
    chipType?: string;
    featured: boolean;
    isDefault: boolean;
    tags?: string[];
    category?: string;
}

export interface WorkTemplatePickerProps {
    /** The user's custom + built-in DB template rows (from the website catalog). */
    customTemplates: WebsiteTemplateOption[];
    /** Manifest blueprints (already fetched server-side, may be empty). */
    blueprints: WorkBlueprintEntry[];
    /** The Work kind currently selected in the Create-Work flow. */
    workKind?: string;
    value?: string | null;
    onChange: (value: string) => void;
    disabled?: boolean;
    helperText?: string;
    className?: string;
}

export function WorkTemplatePicker({
    customTemplates,
    blueprints,
    workKind,
    value,
    onChange,
    disabled = false,
    helperText,
    className,
}: WorkTemplatePickerProps) {
    const t = useTranslations('dashboard.templateSelector');

    const currentChipType: ChipTypeName =
        (workKind ? KIND_TO_CHIP_TYPE[workKind] : undefined) ?? 'website';

    // Chip row = the current kind's chipType FIRST, then every other chipType
    // that has ≥1 pickable (non-placeholder) blueprint.
    const chipTypes = useMemo<ChipTypeName[]>(() => {
        const withBlueprints = new Set<string>();
        for (const b of blueprints) {
            if (b.status !== 'placeholder') withBlueprints.add(b.chipType);
        }
        withBlueprints.add(currentChipType);
        return CHIP_TYPE_ORDER.filter((ct) => withBlueprints.has(ct)).sort((a, b) => {
            if (a === currentChipType) return -1;
            if (b === currentChipType) return 1;
            return CHIP_TYPE_ORDER.indexOf(a) - CHIP_TYPE_ORDER.indexOf(b);
        });
    }, [blueprints, currentChipType]);

    const [selectedChip, setSelectedChip] = useState(currentChipType);
    const [query, setQuery] = useState('');

    // Custom rows always lead ("Your templates"), on every chip.
    const customOptions = useMemo<PickerOption[]>(
        () =>
            customTemplates.map((tpl) => ({
                value: tpl.id,
                name: tpl.name,
                description: tpl.description,
                group: 'yours',
                featured: false,
                isDefault: tpl.isDefault,
                chipType: currentChipType,
            })),
        [customTemplates, currentChipType],
    );

    const customValueSet = useMemo(
        () => new Set(customOptions.map((o) => o.value)),
        [customOptions],
    );

    // Blueprint options for the selected chip, placeholders excluded, deduped
    // against custom rows (a custom/DB row wins — it's already resolvable).
    const blueprintOptions = useMemo<PickerOption[]>(() => {
        const rows = blueprints
            .filter(
                (b) =>
                    b.chipType === selectedChip &&
                    b.status !== 'placeholder' &&
                    !customValueSet.has(b.slug),
            )
            .map<PickerOption>((b) => ({
                value: b.slug,
                name: b.name,
                description: b.description,
                group: 'blueprints',
                iconName: b.iconName,
                chipType: b.chipType,
                featured: b.featured,
                isDefault: b.isDefault,
                tags: b.tags,
                category: b.category,
            }));
        // Featured pinned to the top within the blueprint group.
        return rows.sort((a, b) => Number(b.featured) - Number(a.featured));
    }, [blueprints, selectedChip, customValueSet]);

    const allOptions = useMemo<PickerOption[]>(
        () => [...customOptions, ...blueprintOptions],
        [customOptions, blueprintOptions],
    );

    // Preselected default (highlighted when no explicit value) — blueprint
    // default:true → user default custom row → first option.
    const defaultOption =
        blueprintOptions.find((o) => o.isDefault) ||
        customOptions.find((o) => o.isDefault) ||
        allOptions[0] ||
        null;

    const effectiveValue = value || defaultOption?.value || '';

    const normalizedQuery = query.trim().toLowerCase();
    const visibleOptions = useMemo(() => {
        if (!normalizedQuery) return allOptions;
        return allOptions.filter((o) => {
            const haystack = [o.name, o.description, o.category, ...(o.tags ?? [])]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            return haystack.includes(normalizedQuery);
        });
    }, [allOptions, normalizedQuery]);

    // Selector visibility rule — only render when the chip resolves to ≥1
    // pickable template.
    if (allOptions.length === 0) {
        return null;
    }

    const yoursVisible = visibleOptions.filter((o) => o.group === 'yours');
    const blueprintsVisible = visibleOptions.filter((o) => o.group === 'blueprints');

    return (
        <div className={cn('space-y-3', className)}>
            <div className="space-y-1">
                <label className="text-sm font-medium text-text dark:text-text-dark">
                    {t('label')}
                </label>
                {helperText ? (
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {helperText}
                    </p>
                ) : null}
            </div>

            {/* Type chips — filter the blueprint list by chipType. */}
            {chipTypes.length > 1 ? (
                <div
                    role="tablist"
                    aria-label={t('typeLabel')}
                    className="flex flex-wrap gap-2"
                    data-testid="work-template-chips"
                >
                    {chipTypes.map((ct) => {
                        const Icon = CHIP_TYPE_ICON[ct] ?? LayoutTemplate;
                        const selected = ct === selectedChip;
                        return (
                            <button
                                key={ct}
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                disabled={disabled}
                                onClick={() => {
                                    setSelectedChip(ct);
                                    setQuery('');
                                }}
                                data-testid={`work-template-chip-${ct}`}
                                className={cn(
                                    'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors',
                                    selected
                                        ? 'border-primary/60 bg-primary/10 text-primary shadow-sm'
                                        : 'border-border/60 dark:border-white/10 bg-transparent text-text-secondary dark:text-text-secondary-dark hover:border-primary/40',
                                )}
                            >
                                <Icon className="size-3.5" aria-hidden="true" />
                                {t(`chipType.${ct}`)}
                            </button>
                        );
                    })}
                </div>
            ) : null}

            {/* Search + scrollable option list — built for hundreds. */}
            <div className="relative">
                <Search
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted dark:text-text-muted-dark"
                    aria-hidden="true"
                />
                <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    disabled={disabled}
                    placeholder={t('searchPlaceholder')}
                    aria-label={t('searchAriaLabel')}
                    data-testid="work-template-search"
                    className={cn(
                        'w-full rounded-lg border py-2 pl-9 pr-3 text-sm',
                        'border-border bg-surface text-text placeholder:text-text-muted',
                        'dark:border-border-dark dark:bg-white/4 dark:text-text-dark',
                        'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
                    )}
                />
            </div>

            <div
                role="listbox"
                aria-label={t('label')}
                className="max-h-72 space-y-3 overflow-y-auto rounded-lg border border-border bg-surface/40 p-2 dark:border-border-dark dark:bg-white/4"
            >
                {visibleOptions.length === 0 ? (
                    <p className="px-2 py-6 text-center text-sm text-text-muted dark:text-text-muted-dark">
                        {t('empty')}
                    </p>
                ) : (
                    <>
                        {yoursVisible.length > 0 ? (
                            <OptionGroup
                                title={t('groupYourTemplates')}
                                options={yoursVisible}
                                effectiveValue={effectiveValue}
                                onPick={onChange}
                                disabled={disabled}
                                defaultBadgeLabel={t('defaultBadge')}
                                featuredBadgeLabel={t('featuredBadge')}
                            />
                        ) : null}
                        {blueprintsVisible.length > 0 ? (
                            <OptionGroup
                                title={t('groupBlueprints')}
                                options={blueprintsVisible}
                                effectiveValue={effectiveValue}
                                onPick={onChange}
                                disabled={disabled}
                                defaultBadgeLabel={t('defaultBadge')}
                                featuredBadgeLabel={t('featuredBadge')}
                            />
                        ) : null}
                    </>
                )}
            </div>

            <p className="px-1 text-xs text-text-muted dark:text-text-muted-dark">
                {t('resultCount', { count: visibleOptions.length })}
            </p>
        </div>
    );
}

interface OptionGroupProps {
    title: string;
    options: PickerOption[];
    effectiveValue: string;
    onPick: (value: string) => void;
    disabled: boolean;
    defaultBadgeLabel: string;
    featuredBadgeLabel: string;
}

function OptionGroup({
    title,
    options,
    effectiveValue,
    onPick,
    disabled,
    defaultBadgeLabel,
    featuredBadgeLabel,
}: OptionGroupProps) {
    return (
        <section>
            <h4 className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                {title}
            </h4>
            <div className="space-y-1.5">
                {options.map((option) => {
                    const Icon = resolveOptionIcon(option.iconName, option.chipType);
                    const selected = effectiveValue === option.value;
                    return (
                        <button
                            key={`${option.group}:${option.value}`}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            disabled={disabled}
                            onClick={() => onPick(option.value)}
                            data-testid={`work-template-option-${option.value}`}
                            className={cn(
                                'flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                                selected
                                    ? 'border-primary/60 bg-primary/10'
                                    : 'border-transparent hover:border-border hover:bg-surface dark:hover:border-border-dark dark:hover:bg-white/6',
                            )}
                        >
                            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                                <Icon className="size-4" aria-hidden="true" />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-1.5">
                                    <span className="text-sm font-medium text-text dark:text-text-dark">
                                        {option.name}
                                    </span>
                                    {option.isDefault ? (
                                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                                            {defaultBadgeLabel}
                                        </span>
                                    ) : null}
                                    {option.featured ? (
                                        <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[10px] font-medium text-text-muted dark:bg-white/10 dark:text-text-muted-dark">
                                            {featuredBadgeLabel}
                                        </span>
                                    ) : null}
                                </span>
                                {option.description ? (
                                    <span className="mt-0.5 line-clamp-2 block text-xs text-text-muted dark:text-text-muted-dark">
                                        {option.description}
                                    </span>
                                ) : null}
                            </span>
                        </button>
                    );
                })}
            </div>
        </section>
    );
}

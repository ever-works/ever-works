'use client';

import { useCallback, useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Globe, LayoutGrid, PanelTop, PanelBottom, PlusIcon, TrashIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { getWebsiteSettings } from '@/app/actions/dashboard/directories';

// ============================================================================
// Types
// ============================================================================

export interface CustomMenuItem {
    label: string;
    path: string;
    target?: '_self' | '_blank';
    icon?: string;
}

export interface WebsiteSettings {
    categories_enabled?: boolean;
    collections_enabled?: boolean;
    companies_enabled?: boolean;
    tags_enabled?: boolean;
    surveys_enabled?: boolean;
    header?: {
        submit_enabled?: boolean;
        pricing_enabled?: boolean;
        layout_enabled?: boolean;
        language_enabled?: boolean;
        theme_enabled?: boolean;
        layout_default?: string;
        pagination_default?: string;
        theme_default?: string;
    };
    homepage?: {
        hero_enabled?: boolean;
        search_enabled?: boolean;
        default_view?: string;
        default_sort?: string;
    };
    footer?: {
        subscribe_enabled?: boolean;
        version_enabled?: boolean;
        theme_selector_enabled?: boolean;
    };
}

export interface WebsiteSettingsFormData {
    company_name: string;
    company_website: string;
    settings: WebsiteSettings;
    custom_menu: {
        header: CustomMenuItem[];
        footer: CustomMenuItem[];
    };
}

// ============================================================================
// Defaults
// ============================================================================

export const DEFAULT_SETTINGS: WebsiteSettings = {
    categories_enabled: true,
    collections_enabled: true,
    companies_enabled: true,
    tags_enabled: true,
    surveys_enabled: true,
    header: {
        submit_enabled: true,
        pricing_enabled: true,
        layout_enabled: true,
        language_enabled: true,
        theme_enabled: true,
        layout_default: 'home1',
        pagination_default: 'standard',
        theme_default: 'light',
    },
    homepage: {
        hero_enabled: true,
        search_enabled: true,
        default_view: 'classic',
        default_sort: 'popularity',
    },
    footer: {
        subscribe_enabled: true,
        version_enabled: true,
        theme_selector_enabled: true,
    },
};

export const DEFAULT_FORM_DATA: WebsiteSettingsFormData = {
    company_name: 'Acme',
    company_website: '',
    settings: DEFAULT_SETTINGS,
    custom_menu: {
        header: [],
        footer: [],
    },
};

// ============================================================================
// Hook
// ============================================================================

export function useWebsiteSettingsForm(directoryId: string, loadErrorMessage: string) {
    const [isLoading, setIsLoading] = useState(false);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [formData, setFormData] = useState<WebsiteSettingsFormData>(DEFAULT_FORM_DATA);

    const loadSettings = useCallback(async () => {
        setIsLoading(true);
        try {
            const result = await getWebsiteSettings(directoryId);
            if (result.success && result.data) {
                const { company_name, company_website, settings, custom_menu } = result.data;
                setFormData({
                    company_name: company_name || 'Acme',
                    company_website: company_website || '',
                    settings: {
                        ...DEFAULT_SETTINGS,
                        ...settings,
                        header: { ...DEFAULT_SETTINGS.header, ...settings?.header },
                        homepage: { ...DEFAULT_SETTINGS.homepage, ...settings?.homepage },
                        footer: { ...DEFAULT_SETTINGS.footer, ...settings?.footer },
                    },
                    custom_menu: {
                        header: custom_menu?.header || [],
                        footer: custom_menu?.footer || [],
                    },
                });
                setHasLoaded(true);
            }
        } catch (error) {
            console.error('Failed to load website settings:', error);
            toast.error(loadErrorMessage);
        } finally {
            setIsLoading(false);
        }
    }, [directoryId, loadErrorMessage]);

    const updateSettings = <K extends keyof WebsiteSettings>(key: K, value: WebsiteSettings[K]) => {
        setFormData((prev) => ({
            ...prev,
            settings: { ...prev.settings, [key]: value },
        }));
    };

    const updateHeaderSettings = (key: string, value: unknown) => {
        setFormData((prev) => ({
            ...prev,
            settings: {
                ...prev.settings,
                header: { ...prev.settings.header, [key]: value },
            },
        }));
    };

    const updateHomepageSettings = (key: string, value: unknown) => {
        setFormData((prev) => ({
            ...prev,
            settings: {
                ...prev.settings,
                homepage: { ...prev.settings.homepage, [key]: value },
            },
        }));
    };

    const updateFooterSettings = (key: string, value: unknown) => {
        setFormData((prev) => ({
            ...prev,
            settings: {
                ...prev.settings,
                footer: { ...prev.settings.footer, [key]: value },
            },
        }));
    };

    const addMenuItem = (location: 'header' | 'footer') => {
        setFormData((prev) => ({
            ...prev,
            custom_menu: {
                ...prev.custom_menu,
                [location]: [
                    ...prev.custom_menu[location],
                    { label: '', path: '', target: '_self' as const },
                ],
            },
        }));
    };

    const updateMenuItem = (
        location: 'header' | 'footer',
        index: number,
        field: keyof CustomMenuItem,
        value: string,
    ) => {
        setFormData((prev) => ({
            ...prev,
            custom_menu: {
                ...prev.custom_menu,
                [location]: prev.custom_menu[location].map((item, i) =>
                    i === index ? { ...item, [field]: value } : item,
                ),
            },
        }));
    };

    const removeMenuItem = (location: 'header' | 'footer', index: number) => {
        setFormData((prev) => ({
            ...prev,
            custom_menu: {
                ...prev.custom_menu,
                [location]: prev.custom_menu[location].filter((_, i) => i !== index),
            },
        }));
    };

    return {
        isLoading,
        hasLoaded,
        formData,
        setFormData,
        loadSettings,
        updateSettings,
        updateHeaderSettings,
        updateHomepageSettings,
        updateFooterSettings,
        addMenuItem,
        updateMenuItem,
        removeMenuItem,
    };
}

// ============================================================================
// Tab definitions
// ============================================================================

type TabId = 'general' | 'header' | 'homepage' | 'footer';

const TABS: { id: TabId; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'general', icon: Globe },
    { id: 'header', icon: PanelTop },
    { id: 'homepage', icon: LayoutGrid },
    { id: 'footer', icon: PanelBottom },
];

// ============================================================================
// Shared form content component
// ============================================================================

interface WebsiteSettingsFormContentProps {
    formData: WebsiteSettingsFormData;
    setFormData: React.Dispatch<React.SetStateAction<WebsiteSettingsFormData>>;
    updateSettings: <K extends keyof WebsiteSettings>(key: K, value: WebsiteSettings[K]) => void;
    updateHeaderSettings: (key: string, value: unknown) => void;
    updateHomepageSettings: (key: string, value: unknown) => void;
    updateFooterSettings: (key: string, value: unknown) => void;
    addMenuItem?: (location: 'header' | 'footer') => void;
    updateMenuItem?: (
        location: 'header' | 'footer',
        index: number,
        field: keyof CustomMenuItem,
        value: string,
    ) => void;
    removeMenuItem?: (location: 'header' | 'footer', index: number) => void;
    tSettings: (key: string) => string;
    /** Render mode: 'compact' = tabbed (for dialog), 'full' = cards (for settings page) */
    variant?: 'compact' | 'full';
}

export function WebsiteSettingsFormContent({
    formData,
    setFormData,
    updateSettings,
    updateHeaderSettings,
    updateHomepageSettings,
    updateFooterSettings,
    addMenuItem,
    updateMenuItem,
    removeMenuItem,
    tSettings,
    variant = 'full',
}: WebsiteSettingsFormContentProps) {
    const [activeTab, setActiveTab] = useState<TabId>('general');

    if (variant === 'compact') {
        return (
            <CompactLayout
                {...{
                    formData,
                    setFormData,
                    updateSettings,
                    updateHeaderSettings,
                    updateHomepageSettings,
                    updateFooterSettings,
                    tSettings,
                    activeTab,
                    setActiveTab,
                }}
            />
        );
    }

    return (
        <FullLayout
            {...{
                formData,
                setFormData,
                updateSettings,
                updateHeaderSettings,
                updateHomepageSettings,
                updateFooterSettings,
                addMenuItem,
                updateMenuItem,
                removeMenuItem,
                tSettings,
            }}
        />
    );
}

// ============================================================================
// Compact layout (tabbed — used in DeployConfigDialog)
// ============================================================================

interface CompactLayoutProps {
    formData: WebsiteSettingsFormData;
    setFormData: React.Dispatch<React.SetStateAction<WebsiteSettingsFormData>>;
    updateSettings: <K extends keyof WebsiteSettings>(key: K, value: WebsiteSettings[K]) => void;
    updateHeaderSettings: (key: string, value: unknown) => void;
    updateHomepageSettings: (key: string, value: unknown) => void;
    updateFooterSettings: (key: string, value: unknown) => void;
    tSettings: (key: string) => string;
    activeTab: TabId;
    setActiveTab: (tab: TabId) => void;
}

function CompactLayout({
    formData,
    setFormData,
    updateSettings,
    updateHeaderSettings,
    updateHomepageSettings,
    updateFooterSettings,
    tSettings,
    activeTab,
    setActiveTab,
}: CompactLayoutProps) {
    const tabLabels: Record<TabId, string> = {
        general: tSettings('tabs.general'),
        header: tSettings('tabs.header'),
        homepage: tSettings('tabs.homepage'),
        footer: tSettings('tabs.footer'),
    };

    const renderTabContent = () => {
        switch (activeTab) {
            case 'general':
                return (
                    <GeneralFields
                        formData={formData}
                        setFormData={setFormData}
                        updateSettings={updateSettings}
                        tSettings={tSettings}
                    />
                );
            case 'header':
                return (
                    <HeaderFields
                        formData={formData}
                        updateHeaderSettings={updateHeaderSettings}
                        tSettings={tSettings}
                    />
                );
            case 'homepage':
                return (
                    <HomepageFields
                        formData={formData}
                        updateHomepageSettings={updateHomepageSettings}
                        tSettings={tSettings}
                    />
                );
            case 'footer':
                return (
                    <FooterFields
                        formData={formData}
                        updateFooterSettings={updateFooterSettings}
                        tSettings={tSettings}
                    />
                );
        }
    };

    return (
        <div className="space-y-5">
            {/* Tabs */}
            <div className="flex gap-1 p-1 bg-surface-secondary dark:bg-surface-secondary-dark rounded-lg">
                {TABS.map(({ id, icon: Icon }) => (
                    <button
                        key={id}
                        type="button"
                        onClick={() => setActiveTab(id)}
                        className={cn(
                            'flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors',
                            activeTab === id
                                ? 'bg-surface dark:bg-surface-dark text-text dark:text-text-dark shadow-sm'
                                : 'text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark',
                        )}
                    >
                        <Icon className="w-4 h-4" />
                        {tabLabels[id]}
                    </button>
                ))}
            </div>

            {/* Tab Content */}
            <div className="min-h-55">{renderTabContent()}</div>
        </div>
    );
}

// ============================================================================
// Full layout (cards — used in WebsiteConfigSettings)
// ============================================================================

interface FullLayoutProps {
    formData: WebsiteSettingsFormData;
    setFormData: React.Dispatch<React.SetStateAction<WebsiteSettingsFormData>>;
    updateSettings: <K extends keyof WebsiteSettings>(key: K, value: WebsiteSettings[K]) => void;
    updateHeaderSettings: (key: string, value: unknown) => void;
    updateHomepageSettings: (key: string, value: unknown) => void;
    updateFooterSettings: (key: string, value: unknown) => void;
    addMenuItem?: (location: 'header' | 'footer') => void;
    updateMenuItem?: (
        location: 'header' | 'footer',
        index: number,
        field: keyof CustomMenuItem,
        value: string,
    ) => void;
    removeMenuItem?: (location: 'header' | 'footer', index: number) => void;
    tSettings: (key: string) => string;
}

function FullLayout({
    formData,
    setFormData,
    updateSettings,
    updateHeaderSettings,
    updateHomepageSettings,
    updateFooterSettings,
    addMenuItem,
    updateMenuItem,
    removeMenuItem,
    tSettings,
}: FullLayoutProps) {
    return (
        <div className="space-y-4">
            {/* Site Identity Card */}
            <SettingsCard title={tSettings('sections.siteName.title')}>
                <div className="space-y-4">
                    <Input
                        label={tSettings('sections.siteName.label')}
                        value={formData.company_name}
                        onChange={(e) =>
                            setFormData((prev) => ({
                                ...prev,
                                company_name: e.target.value,
                            }))
                        }
                        placeholder={tSettings('sections.siteName.placeholder')}
                        helperText={tSettings('sections.siteName.helper')}
                        variant="form"
                    />
                    <Input
                        label={tSettings('sections.siteUrl.label')}
                        type="url"
                        value={formData.company_website}
                        onChange={(e) =>
                            setFormData((prev) => ({
                                ...prev,
                                company_website: e.target.value,
                            }))
                        }
                        placeholder={tSettings('sections.siteUrl.placeholder')}
                        helperText={tSettings('sections.siteUrl.helper')}
                        variant="form"
                    />
                </div>
            </SettingsCard>

            {/* Global Features Card */}
            <SettingsCard title={tSettings('sections.global.title')}>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <Switch
                        checked={formData.settings.categories_enabled ?? true}
                        onChange={(checked) => updateSettings('categories_enabled', checked)}
                        label={tSettings('sections.global.categories')}
                    />
                    <Switch
                        checked={formData.settings.collections_enabled ?? true}
                        onChange={(checked) => updateSettings('collections_enabled', checked)}
                        label={tSettings('sections.global.collections')}
                    />
                    <Switch
                        checked={formData.settings.tags_enabled ?? true}
                        onChange={(checked) => updateSettings('tags_enabled', checked)}
                        label={tSettings('sections.global.tags')}
                    />
                    <Switch
                        checked={formData.settings.companies_enabled ?? true}
                        onChange={(checked) => updateSettings('companies_enabled', checked)}
                        label={tSettings('sections.global.companies')}
                    />
                    <Switch
                        checked={formData.settings.surveys_enabled ?? true}
                        onChange={(checked) => updateSettings('surveys_enabled', checked)}
                        label={tSettings('sections.global.surveys')}
                    />
                </div>
            </SettingsCard>

            {/* Header Settings Card */}
            <SettingsCard title={tSettings('sections.header.title')}>
                <div className="space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                        <Switch
                            checked={formData.settings.header?.submit_enabled ?? true}
                            onChange={(checked) => updateHeaderSettings('submit_enabled', checked)}
                            label={tSettings('sections.header.submit')}
                        />
                        <Switch
                            checked={formData.settings.header?.pricing_enabled ?? true}
                            onChange={(checked) => updateHeaderSettings('pricing_enabled', checked)}
                            label={tSettings('sections.header.pricing')}
                        />
                        <Switch
                            checked={formData.settings.header?.layout_enabled ?? true}
                            onChange={(checked) => updateHeaderSettings('layout_enabled', checked)}
                            label={tSettings('sections.header.layoutSelector')}
                        />
                        <Switch
                            checked={formData.settings.header?.language_enabled ?? true}
                            onChange={(checked) =>
                                updateHeaderSettings('language_enabled', checked)
                            }
                            label={tSettings('sections.header.languageSelector')}
                        />
                        <Switch
                            checked={formData.settings.header?.theme_enabled ?? true}
                            onChange={(checked) => updateHeaderSettings('theme_enabled', checked)}
                            label={tSettings('sections.header.themeSelector')}
                        />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-3 border-t border-card-border dark:border-card-border-dark">
                        <div className="space-y-1.5">
                            <label className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                {tSettings('sections.header.defaultLayout')}
                            </label>
                            <Select
                                value={formData.settings.header?.layout_default || 'home1'}
                                onValueChange={(val) => updateHeaderSettings('layout_default', val)}
                            >
                                <SelectTrigger size="sm">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="home1">Home 1</SelectItem>
                                    <SelectItem value="home2">Home 2</SelectItem>
                                    <SelectItem value="home3">Home 3</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                {tSettings('sections.header.defaultTheme')}
                            </label>
                            <Select
                                value={formData.settings.header?.theme_default || 'light'}
                                onValueChange={(val) => updateHeaderSettings('theme_default', val)}
                            >
                                <SelectTrigger size="sm">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="light">
                                        {tSettings('sections.header.themeLight')}
                                    </SelectItem>
                                    <SelectItem value="dark">
                                        {tSettings('sections.header.themeDark')}
                                    </SelectItem>
                                    <SelectItem value="system">
                                        {tSettings('sections.header.themeSystem')}
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                {tSettings('sections.header.defaultPagination')}
                            </label>
                            <Select
                                value={formData.settings.header?.pagination_default || 'standard'}
                                onValueChange={(val) =>
                                    updateHeaderSettings('pagination_default', val)
                                }
                            >
                                <SelectTrigger size="sm">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="standard">
                                        {tSettings('sections.header.paginationStandard')}
                                    </SelectItem>
                                    <SelectItem value="infinite">
                                        {tSettings('sections.header.paginationInfinite')}
                                    </SelectItem>
                                    <SelectItem value="loadmore">
                                        {tSettings('sections.header.paginationLoadMore')}
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                </div>
            </SettingsCard>

            {/* Homepage Settings Card */}
            <SettingsCard title={tSettings('sections.homepage.title')}>
                <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <Switch
                            checked={formData.settings.homepage?.hero_enabled ?? true}
                            onChange={(checked) => updateHomepageSettings('hero_enabled', checked)}
                            label={tSettings('sections.homepage.hero')}
                        />
                        <Switch
                            checked={formData.settings.homepage?.search_enabled ?? true}
                            onChange={(checked) =>
                                updateHomepageSettings('search_enabled', checked)
                            }
                            label={tSettings('sections.homepage.search')}
                        />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 border-t border-card-border dark:border-card-border-dark">
                        <div className="space-y-1.5">
                            <label className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                {tSettings('sections.homepage.defaultView')}
                            </label>
                            <Select
                                value={formData.settings.homepage?.default_view || 'classic'}
                                onValueChange={(val) => updateHomepageSettings('default_view', val)}
                            >
                                <SelectTrigger size="sm">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="classic">
                                        {tSettings('sections.homepage.viewClassic')}
                                    </SelectItem>
                                    <SelectItem value="grid">
                                        {tSettings('sections.homepage.viewGrid')}
                                    </SelectItem>
                                    <SelectItem value="list">
                                        {tSettings('sections.homepage.viewList')}
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                {tSettings('sections.homepage.defaultSort')}
                            </label>
                            <Select
                                value={formData.settings.homepage?.default_sort || 'popularity'}
                                onValueChange={(val) => updateHomepageSettings('default_sort', val)}
                            >
                                <SelectTrigger size="sm">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="popularity">
                                        {tSettings('sections.homepage.sortPopularity')}
                                    </SelectItem>
                                    <SelectItem value="newest">
                                        {tSettings('sections.homepage.sortNewest')}
                                    </SelectItem>
                                    <SelectItem value="alphabetical">
                                        {tSettings('sections.homepage.sortAlphabetical')}
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                </div>
            </SettingsCard>

            {/* Footer Settings Card */}
            <SettingsCard title={tSettings('sections.footer.title')}>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    <Switch
                        checked={formData.settings.footer?.subscribe_enabled ?? true}
                        onChange={(checked) => updateFooterSettings('subscribe_enabled', checked)}
                        label={tSettings('sections.footer.subscribe')}
                    />
                    <Switch
                        checked={formData.settings.footer?.version_enabled ?? true}
                        onChange={(checked) => updateFooterSettings('version_enabled', checked)}
                        label={tSettings('sections.footer.version')}
                    />
                    <Switch
                        checked={formData.settings.footer?.theme_selector_enabled ?? true}
                        onChange={(checked) =>
                            updateFooterSettings('theme_selector_enabled', checked)
                        }
                        label={tSettings('sections.footer.themeSelector')}
                    />
                </div>
            </SettingsCard>

            {/* Custom Menu Links Card */}
            {addMenuItem && updateMenuItem && removeMenuItem && (
                <SettingsCard title={tSettings('sections.customMenu.title')}>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mb-4">
                        {tSettings('sections.customMenu.description')}
                    </p>
                    <CustomMenuEditor
                        formData={formData}
                        addMenuItem={addMenuItem}
                        updateMenuItem={updateMenuItem}
                        removeMenuItem={removeMenuItem}
                        tSettings={tSettings}
                    />
                </SettingsCard>
            )}
        </div>
    );
}

// ============================================================================
// Sub-components: field groups
// ============================================================================

function GeneralFields({
    formData,
    setFormData,
    updateSettings,
    tSettings,
}: {
    formData: WebsiteSettingsFormData;
    setFormData: React.Dispatch<React.SetStateAction<WebsiteSettingsFormData>>;
    updateSettings: <K extends keyof WebsiteSettings>(key: K, value: WebsiteSettings[K]) => void;
    tSettings: (key: string) => string;
}) {
    return (
        <div className="space-y-5">
            <Input
                label={tSettings('sections.siteName.label')}
                value={formData.company_name}
                onChange={(e) => setFormData((prev) => ({ ...prev, company_name: e.target.value }))}
                placeholder={tSettings('sections.siteName.placeholder')}
                helperText={tSettings('sections.siteName.helper')}
                variant="form"
            />
            <Input
                label={tSettings('sections.siteUrl.label')}
                type="url"
                value={formData.company_website}
                onChange={(e) =>
                    setFormData((prev) => ({ ...prev, company_website: e.target.value }))
                }
                placeholder={tSettings('sections.siteUrl.placeholder')}
                helperText={tSettings('sections.siteUrl.helper')}
                variant="form"
            />
            <div>
                <p className="text-xs font-medium text-text-muted dark:text-text-muted-dark mb-3">
                    {tSettings('sections.global.title')}
                </p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                    <Switch
                        checked={formData.settings.categories_enabled ?? true}
                        onChange={(checked) => updateSettings('categories_enabled', checked)}
                        label={tSettings('sections.global.categories')}
                    />
                    <Switch
                        checked={formData.settings.collections_enabled ?? true}
                        onChange={(checked) => updateSettings('collections_enabled', checked)}
                        label={tSettings('sections.global.collections')}
                    />
                    <Switch
                        checked={formData.settings.tags_enabled ?? true}
                        onChange={(checked) => updateSettings('tags_enabled', checked)}
                        label={tSettings('sections.global.tags')}
                    />
                    <Switch
                        checked={formData.settings.companies_enabled ?? true}
                        onChange={(checked) => updateSettings('companies_enabled', checked)}
                        label={tSettings('sections.global.companies')}
                    />
                    <Switch
                        checked={formData.settings.surveys_enabled ?? true}
                        onChange={(checked) => updateSettings('surveys_enabled', checked)}
                        label={tSettings('sections.global.surveys')}
                    />
                </div>
            </div>
        </div>
    );
}

function HeaderFields({
    formData,
    updateHeaderSettings,
    tSettings,
}: {
    formData: WebsiteSettingsFormData;
    updateHeaderSettings: (key: string, value: unknown) => void;
    tSettings: (key: string) => string;
}) {
    return (
        <div className="space-y-5">
            <div>
                <p className="text-xs font-medium text-text-muted dark:text-text-muted-dark mb-3">
                    {tSettings('sections.header.title')}
                </p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                    <Switch
                        checked={formData.settings.header?.submit_enabled ?? true}
                        onChange={(checked) => updateHeaderSettings('submit_enabled', checked)}
                        label={tSettings('sections.header.submit')}
                    />
                    <Switch
                        checked={formData.settings.header?.pricing_enabled ?? true}
                        onChange={(checked) => updateHeaderSettings('pricing_enabled', checked)}
                        label={tSettings('sections.header.pricing')}
                    />
                    <Switch
                        checked={formData.settings.header?.layout_enabled ?? true}
                        onChange={(checked) => updateHeaderSettings('layout_enabled', checked)}
                        label={tSettings('sections.header.layoutSelector')}
                    />
                    <Switch
                        checked={formData.settings.header?.language_enabled ?? true}
                        onChange={(checked) => updateHeaderSettings('language_enabled', checked)}
                        label={tSettings('sections.header.languageSelector')}
                    />
                    <Switch
                        checked={formData.settings.header?.theme_enabled ?? true}
                        onChange={(checked) => updateHeaderSettings('theme_enabled', checked)}
                        label={tSettings('sections.header.themeSelector')}
                    />
                </div>
            </div>
            <div>
                <p className="text-xs font-medium text-text-muted dark:text-text-muted-dark mb-3">
                    {tSettings('sections.header.defaults')}
                </p>
                <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-1.5">
                        <label className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                            {tSettings('sections.header.defaultLayout')}
                        </label>
                        <Select
                            value={formData.settings.header?.layout_default || 'home1'}
                            onValueChange={(val) => updateHeaderSettings('layout_default', val)}
                        >
                            <SelectTrigger size="sm">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="home1">Home 1</SelectItem>
                                <SelectItem value="home2">Home 2</SelectItem>
                                <SelectItem value="home3">Home 3</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1.5">
                        <label className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                            {tSettings('sections.header.defaultTheme')}
                        </label>
                        <Select
                            value={formData.settings.header?.theme_default || 'light'}
                            onValueChange={(val) => updateHeaderSettings('theme_default', val)}
                        >
                            <SelectTrigger size="sm">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="light">
                                    {tSettings('sections.header.themeLight')}
                                </SelectItem>
                                <SelectItem value="dark">
                                    {tSettings('sections.header.themeDark')}
                                </SelectItem>
                                <SelectItem value="system">
                                    {tSettings('sections.header.themeSystem')}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1.5">
                        <label className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                            {tSettings('sections.header.defaultPagination')}
                        </label>
                        <Select
                            value={formData.settings.header?.pagination_default || 'standard'}
                            onValueChange={(val) => updateHeaderSettings('pagination_default', val)}
                        >
                            <SelectTrigger size="sm">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="standard">
                                    {tSettings('sections.header.paginationStandard')}
                                </SelectItem>
                                <SelectItem value="infinite">
                                    {tSettings('sections.header.paginationInfinite')}
                                </SelectItem>
                                <SelectItem value="loadmore">
                                    {tSettings('sections.header.paginationLoadMore')}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            </div>
        </div>
    );
}

function HomepageFields({
    formData,
    updateHomepageSettings,
    tSettings,
}: {
    formData: WebsiteSettingsFormData;
    updateHomepageSettings: (key: string, value: unknown) => void;
    tSettings: (key: string) => string;
}) {
    return (
        <div className="space-y-5">
            <div>
                <p className="text-xs font-medium text-text-muted dark:text-text-muted-dark mb-3">
                    {tSettings('sections.homepage.title')}
                </p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                    <Switch
                        checked={formData.settings.homepage?.hero_enabled ?? true}
                        onChange={(checked) => updateHomepageSettings('hero_enabled', checked)}
                        label={tSettings('sections.homepage.hero')}
                    />
                    <Switch
                        checked={formData.settings.homepage?.search_enabled ?? true}
                        onChange={(checked) => updateHomepageSettings('search_enabled', checked)}
                        label={tSettings('sections.homepage.search')}
                    />
                </div>
            </div>
            <div>
                <p className="text-xs font-medium text-text-muted dark:text-text-muted-dark mb-3">
                    {tSettings('sections.homepage.defaults')}
                </p>
                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                        <label className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                            {tSettings('sections.homepage.defaultView')}
                        </label>
                        <Select
                            value={formData.settings.homepage?.default_view || 'classic'}
                            onValueChange={(val) => updateHomepageSettings('default_view', val)}
                        >
                            <SelectTrigger size="sm">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="classic">
                                    {tSettings('sections.homepage.viewClassic')}
                                </SelectItem>
                                <SelectItem value="grid">
                                    {tSettings('sections.homepage.viewGrid')}
                                </SelectItem>
                                <SelectItem value="list">
                                    {tSettings('sections.homepage.viewList')}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1.5">
                        <label className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                            {tSettings('sections.homepage.defaultSort')}
                        </label>
                        <Select
                            value={formData.settings.homepage?.default_sort || 'popularity'}
                            onValueChange={(val) => updateHomepageSettings('default_sort', val)}
                        >
                            <SelectTrigger size="sm">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="popularity">
                                    {tSettings('sections.homepage.sortPopularity')}
                                </SelectItem>
                                <SelectItem value="newest">
                                    {tSettings('sections.homepage.sortNewest')}
                                </SelectItem>
                                <SelectItem value="alphabetical">
                                    {tSettings('sections.homepage.sortAlphabetical')}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            </div>
        </div>
    );
}

function FooterFields({
    formData,
    updateFooterSettings,
    tSettings,
}: {
    formData: WebsiteSettingsFormData;
    updateFooterSettings: (key: string, value: unknown) => void;
    tSettings: (key: string) => string;
}) {
    return (
        <div>
            <p className="text-xs font-medium text-text-muted dark:text-text-muted-dark mb-3">
                {tSettings('sections.footer.title')}
            </p>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                <Switch
                    checked={formData.settings.footer?.subscribe_enabled ?? true}
                    onChange={(checked) => updateFooterSettings('subscribe_enabled', checked)}
                    label={tSettings('sections.footer.subscribe')}
                />
                <Switch
                    checked={formData.settings.footer?.version_enabled ?? true}
                    onChange={(checked) => updateFooterSettings('version_enabled', checked)}
                    label={tSettings('sections.footer.version')}
                />
                <Switch
                    checked={formData.settings.footer?.theme_selector_enabled ?? true}
                    onChange={(checked) => updateFooterSettings('theme_selector_enabled', checked)}
                    label={tSettings('sections.footer.themeSelector')}
                />
            </div>
        </div>
    );
}

// ============================================================================
// Custom menu editor (used in full layout only)
// ============================================================================

function CustomMenuEditor({
    formData,
    addMenuItem,
    updateMenuItem,
    removeMenuItem,
    tSettings,
}: {
    formData: WebsiteSettingsFormData;
    addMenuItem: (location: 'header' | 'footer') => void;
    updateMenuItem: (
        location: 'header' | 'footer',
        index: number,
        field: keyof CustomMenuItem,
        value: string,
    ) => void;
    removeMenuItem: (location: 'header' | 'footer', index: number) => void;
    tSettings: (key: string) => string;
}) {
    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Header Links */}
            <MenuLinkList
                location="header"
                items={formData.custom_menu.header}
                addMenuItem={addMenuItem}
                updateMenuItem={updateMenuItem}
                removeMenuItem={removeMenuItem}
                tSettings={tSettings}
            />
            {/* Footer Links */}
            <MenuLinkList
                location="footer"
                items={formData.custom_menu.footer}
                addMenuItem={addMenuItem}
                updateMenuItem={updateMenuItem}
                removeMenuItem={removeMenuItem}
                tSettings={tSettings}
            />
        </div>
    );
}

function MenuLinkList({
    location,
    items,
    addMenuItem,
    updateMenuItem,
    removeMenuItem,
    tSettings,
}: {
    location: 'header' | 'footer';
    items: CustomMenuItem[];
    addMenuItem: (location: 'header' | 'footer') => void;
    updateMenuItem: (
        location: 'header' | 'footer',
        index: number,
        field: keyof CustomMenuItem,
        value: string,
    ) => void;
    removeMenuItem: (location: 'header' | 'footer', index: number) => void;
    tSettings: (key: string) => string;
}) {
    const titleKey =
        location === 'header'
            ? 'sections.customMenu.headerLinks'
            : 'sections.customMenu.footerLinks';

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <h5 className="text-xs font-medium text-text dark:text-text-dark">
                    {tSettings(titleKey)}
                </h5>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => addMenuItem(location)}
                    disabled={items.length >= 10}
                >
                    <PlusIcon className="h-4 w-4" />
                </Button>
            </div>
            {items.length === 0 ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark italic py-2">
                    {tSettings('sections.customMenu.noLinks')}
                </p>
            ) : (
                <div className="space-y-2">
                    {items.map((item, index) => (
                        <div
                            key={index}
                            className="flex items-center gap-2 p-2 bg-surface-secondary dark:bg-surface-secondary-dark rounded"
                        >
                            <Input
                                placeholder={tSettings('sections.customMenu.labelPlaceholder')}
                                value={item.label}
                                onChange={(e) =>
                                    updateMenuItem(location, index, 'label', e.target.value)
                                }
                                variant="form"
                                className="flex-1"
                            />
                            <Input
                                placeholder={tSettings('sections.customMenu.pathPlaceholder')}
                                value={item.path}
                                onChange={(e) =>
                                    updateMenuItem(location, index, 'path', e.target.value)
                                }
                                variant="form"
                                className="flex-1"
                            />
                            <Select
                                value={item.target || '_self'}
                                onValueChange={(val) =>
                                    updateMenuItem(location, index, 'target', val)
                                }
                            >
                                <SelectTrigger size="sm" className="w-24">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="_self">
                                        {tSettings('sections.customMenu.targetSelf')}
                                    </SelectItem>
                                    <SelectItem value="_blank">
                                        {tSettings('sections.customMenu.targetBlank')}
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => removeMenuItem(location, index)}
                                className="text-danger hover:text-danger shrink-0"
                            >
                                <TrashIcon className="h-4 w-4" />
                            </Button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ============================================================================
// Utility components
// ============================================================================

function SettingsCard({
    title,
    children,
    className,
}: {
    title: string;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <div
            className={cn(
                'rounded-lg border overflow-hidden bg-card dark:bg-card-primary-dark/30 border-card-border dark:border-card-border-dark',
                className,
            )}
        >
            <div className="px-5 py-3.5 border-b border-card-border dark:border-card-border-dark">
                <h4 className="text-sm font-semibold text-text dark:text-text-dark">{title}</h4>
            </div>
            <div className="px-5 py-4">{children}</div>
        </div>
    );
}

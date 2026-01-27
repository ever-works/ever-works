'use client';

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { ChevronDownIcon, ChevronUpIcon, PlusIcon, TrashIcon, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
    getWebsiteSettings,
    updateWebsiteSettings,
} from '@/app/actions/dashboard/directories';

interface WebsiteConfigSettingsProps {
    directoryId: string;
}

interface CustomMenuItem {
    label: string;
    path: string;
    target?: '_self' | '_blank';
    icon?: string;
}

interface WebsiteSettings {
    categories_enabled?: boolean;
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

interface FormData {
    company_name: string;
    settings: WebsiteSettings;
    custom_menu: {
        header: CustomMenuItem[];
        footer: CustomMenuItem[];
    };
}

const DEFAULT_FORM_DATA: FormData = {
    company_name: 'Acme',
    settings: {
        categories_enabled: true,
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
    },
    custom_menu: {
        header: [],
        footer: [],
    },
};

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
                'rounded-lg border bg-card dark:bg-card-dark border-card-border dark:border-card-border-dark p-5',
                className,
            )}
        >
            <h4 className="text-sm font-semibold text-text dark:text-text-dark mb-4">{title}</h4>
            {children}
        </div>
    );
}

export function WebsiteConfigSettings({ directoryId }: WebsiteConfigSettingsProps) {
    const t = useTranslations('dashboard.directoryDetail.settings.websiteConfig');

    const [isExpanded, setIsExpanded] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [formData, setFormData] = useState<FormData>(DEFAULT_FORM_DATA);

    useEffect(() => {
        if (isExpanded && !hasLoaded) {
            loadSettings();
        }
    }, [isExpanded, hasLoaded]);

    const loadSettings = async () => {
        setIsLoading(true);
        try {
            const result = await getWebsiteSettings(directoryId);
            if (result.success && result.data) {
                const { company_name, settings, custom_menu } = result.data;
                setFormData({
                    company_name: company_name || 'Acme',
                    settings: {
                        ...DEFAULT_FORM_DATA.settings,
                        ...settings,
                        header: { ...DEFAULT_FORM_DATA.settings.header, ...settings?.header },
                        homepage: { ...DEFAULT_FORM_DATA.settings.homepage, ...settings?.homepage },
                        footer: { ...DEFAULT_FORM_DATA.settings.footer, ...settings?.footer },
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
            toast.error(t('loadFailed'));
        } finally {
            setIsLoading(false);
        }
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const result = await updateWebsiteSettings(directoryId, {
                company_name: formData.company_name,
                ...formData.settings,
                custom_menu: formData.custom_menu,
            });

            if (result.success) {
                toast.success(t('saveSuccess'));
            } else {
                toast.error(result.error || t('saveFailed'));
            }
        } catch (error) {
            console.error('Failed to save website settings:', error);
            toast.error(t('saveFailed'));
        } finally {
            setIsSaving(false);
        }
    };

    const updateSettings = <K extends keyof WebsiteSettings>(
        key: K,
        value: WebsiteSettings[K],
    ) => {
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

    return (
        <div
            className={cn(
                'rounded-lg border',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
            )}
        >
            {/* Collapsible Header */}
            <button
                type="button"
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full p-6 flex items-center justify-between text-left hover:bg-muted/50 dark:hover:bg-muted-dark/50 transition-colors rounded-lg"
            >
                <div>
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h3>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                        {t('subtitle')}
                    </p>
                </div>
                {isExpanded ? (
                    <ChevronUpIcon className="h-5 w-5 text-text-muted dark:text-text-muted-dark" />
                ) : (
                    <ChevronDownIcon className="h-5 w-5 text-text-muted dark:text-text-muted-dark" />
                )}
            </button>

            {/* Expandable Content */}
            {isExpanded && (
                <div className="px-6 pb-6">
                    {isLoading ? (
                        <div className="flex justify-center py-12">
                            <Loader2 className="animate-spin h-8 w-8 text-primary" />
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {/* Site Identity Card */}
                            <SettingsCard title={t('sections.siteName.title')}>
                                <Input
                                    label={t('sections.siteName.label')}
                                    value={formData.company_name}
                                    onChange={(e) =>
                                        setFormData((prev) => ({
                                            ...prev,
                                            company_name: e.target.value,
                                        }))
                                    }
                                    placeholder={t('sections.siteName.placeholder')}
                                    helperText={t('sections.siteName.helper')}
                                    variant="form"
                                />
                            </SettingsCard>

                            {/* Global Features Card */}
                            <SettingsCard title={t('sections.global.title')}>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                    <Switch
                                        checked={formData.settings.categories_enabled ?? true}
                                        onChange={(checked) =>
                                            updateSettings('categories_enabled', checked)
                                        }
                                        label={t('sections.global.categories')}
                                    />
                                    <Switch
                                        checked={formData.settings.tags_enabled ?? true}
                                        onChange={(checked) => updateSettings('tags_enabled', checked)}
                                        label={t('sections.global.tags')}
                                    />
                                    <Switch
                                        checked={formData.settings.companies_enabled ?? true}
                                        onChange={(checked) =>
                                            updateSettings('companies_enabled', checked)
                                        }
                                        label={t('sections.global.companies')}
                                    />
                                    <Switch
                                        checked={formData.settings.surveys_enabled ?? true}
                                        onChange={(checked) =>
                                            updateSettings('surveys_enabled', checked)
                                        }
                                        label={t('sections.global.surveys')}
                                    />
                                </div>
                            </SettingsCard>

                            {/* Header Settings Card */}
                            <SettingsCard title={t('sections.header.title')}>
                                <div className="space-y-4">
                                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                                        <Switch
                                            checked={formData.settings.header?.submit_enabled ?? true}
                                            onChange={(checked) =>
                                                updateHeaderSettings('submit_enabled', checked)
                                            }
                                            label={t('sections.header.submit')}
                                        />
                                        <Switch
                                            checked={formData.settings.header?.pricing_enabled ?? true}
                                            onChange={(checked) =>
                                                updateHeaderSettings('pricing_enabled', checked)
                                            }
                                            label={t('sections.header.pricing')}
                                        />
                                        <Switch
                                            checked={formData.settings.header?.layout_enabled ?? true}
                                            onChange={(checked) =>
                                                updateHeaderSettings('layout_enabled', checked)
                                            }
                                            label={t('sections.header.layoutSelector')}
                                        />
                                        <Switch
                                            checked={formData.settings.header?.language_enabled ?? true}
                                            onChange={(checked) =>
                                                updateHeaderSettings('language_enabled', checked)
                                            }
                                            label={t('sections.header.languageSelector')}
                                        />
                                        <Switch
                                            checked={formData.settings.header?.theme_enabled ?? true}
                                            onChange={(checked) =>
                                                updateHeaderSettings('theme_enabled', checked)
                                            }
                                            label={t('sections.header.themeSelector')}
                                        />
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2 border-t border-border dark:border-border-dark">
                                        <Select
                                            label={t('sections.header.defaultLayout')}
                                            value={formData.settings.header?.layout_default || 'home1'}
                                            onChange={(e) =>
                                                updateHeaderSettings('layout_default', e.target.value)
                                            }
                                            variant="form"
                                        >
                                            <option value="home1">Home 1</option>
                                            <option value="home2">Home 2</option>
                                            <option value="home3">Home 3</option>
                                        </Select>
                                        <Select
                                            label={t('sections.header.defaultTheme')}
                                            value={formData.settings.header?.theme_default || 'light'}
                                            onChange={(e) =>
                                                updateHeaderSettings('theme_default', e.target.value)
                                            }
                                            variant="form"
                                        >
                                            <option value="light">
                                                {t('sections.header.themeLight')}
                                            </option>
                                            <option value="dark">
                                                {t('sections.header.themeDark')}
                                            </option>
                                            <option value="system">
                                                {t('sections.header.themeSystem')}
                                            </option>
                                        </Select>
                                        <Select
                                            label={t('sections.header.defaultPagination')}
                                            value={
                                                formData.settings.header?.pagination_default ||
                                                'standard'
                                            }
                                            onChange={(e) =>
                                                updateHeaderSettings(
                                                    'pagination_default',
                                                    e.target.value,
                                                )
                                            }
                                            variant="form"
                                        >
                                            <option value="standard">
                                                {t('sections.header.paginationStandard')}
                                            </option>
                                            <option value="infinite">
                                                {t('sections.header.paginationInfinite')}
                                            </option>
                                            <option value="loadmore">
                                                {t('sections.header.paginationLoadMore')}
                                            </option>
                                        </Select>
                                    </div>
                                </div>
                            </SettingsCard>

                            {/* Homepage Settings Card */}
                            <SettingsCard title={t('sections.homepage.title')}>
                                <div className="space-y-4">
                                    <div className="grid grid-cols-2 gap-4">
                                        <Switch
                                            checked={formData.settings.homepage?.hero_enabled ?? true}
                                            onChange={(checked) =>
                                                updateHomepageSettings('hero_enabled', checked)
                                            }
                                            label={t('sections.homepage.hero')}
                                        />
                                        <Switch
                                            checked={
                                                formData.settings.homepage?.search_enabled ?? true
                                            }
                                            onChange={(checked) =>
                                                updateHomepageSettings('search_enabled', checked)
                                            }
                                            label={t('sections.homepage.search')}
                                        />
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-border dark:border-border-dark">
                                        <Select
                                            label={t('sections.homepage.defaultView')}
                                            value={
                                                formData.settings.homepage?.default_view || 'classic'
                                            }
                                            onChange={(e) =>
                                                updateHomepageSettings('default_view', e.target.value)
                                            }
                                            variant="form"
                                        >
                                            <option value="classic">
                                                {t('sections.homepage.viewClassic')}
                                            </option>
                                            <option value="grid">
                                                {t('sections.homepage.viewGrid')}
                                            </option>
                                            <option value="list">
                                                {t('sections.homepage.viewList')}
                                            </option>
                                        </Select>
                                        <Select
                                            label={t('sections.homepage.defaultSort')}
                                            value={
                                                formData.settings.homepage?.default_sort ||
                                                'popularity'
                                            }
                                            onChange={(e) =>
                                                updateHomepageSettings('default_sort', e.target.value)
                                            }
                                            variant="form"
                                        >
                                            <option value="popularity">
                                                {t('sections.homepage.sortPopularity')}
                                            </option>
                                            <option value="newest">
                                                {t('sections.homepage.sortNewest')}
                                            </option>
                                            <option value="alphabetical">
                                                {t('sections.homepage.sortAlphabetical')}
                                            </option>
                                        </Select>
                                    </div>
                                </div>
                            </SettingsCard>

                            {/* Footer Settings Card */}
                            <SettingsCard title={t('sections.footer.title')}>
                                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                                    <Switch
                                        checked={formData.settings.footer?.subscribe_enabled ?? true}
                                        onChange={(checked) =>
                                            updateFooterSettings('subscribe_enabled', checked)
                                        }
                                        label={t('sections.footer.subscribe')}
                                    />
                                    <Switch
                                        checked={formData.settings.footer?.version_enabled ?? true}
                                        onChange={(checked) =>
                                            updateFooterSettings('version_enabled', checked)
                                        }
                                        label={t('sections.footer.version')}
                                    />
                                    <Switch
                                        checked={
                                            formData.settings.footer?.theme_selector_enabled ?? true
                                        }
                                        onChange={(checked) =>
                                            updateFooterSettings('theme_selector_enabled', checked)
                                        }
                                        label={t('sections.footer.themeSelector')}
                                    />
                                </div>
                            </SettingsCard>

                            {/* Custom Menu Links Card */}
                            <SettingsCard title={t('sections.customMenu.title')}>
                                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                                    {t('sections.customMenu.description')}
                                </p>

                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                    {/* Header Links */}
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between">
                                            <h5 className="text-sm font-medium text-text dark:text-text-dark">
                                                {t('sections.customMenu.headerLinks')}
                                            </h5>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => addMenuItem('header')}
                                                disabled={formData.custom_menu.header.length >= 10}
                                            >
                                                <PlusIcon className="h-4 w-4" />
                                            </Button>
                                        </div>
                                        {formData.custom_menu.header.length === 0 ? (
                                            <p className="text-sm text-text-muted dark:text-text-muted-dark italic py-2">
                                                {t('sections.customMenu.noLinks')}
                                            </p>
                                        ) : (
                                            <div className="space-y-2">
                                                {formData.custom_menu.header.map((item, index) => (
                                                    <div
                                                        key={index}
                                                        className="flex items-center gap-2 p-2 bg-surface-secondary dark:bg-surface-secondary-dark rounded"
                                                    >
                                                        <Input
                                                            placeholder={t(
                                                                'sections.customMenu.labelPlaceholder',
                                                            )}
                                                            value={item.label}
                                                            onChange={(e) =>
                                                                updateMenuItem(
                                                                    'header',
                                                                    index,
                                                                    'label',
                                                                    e.target.value,
                                                                )
                                                            }
                                                            variant="form"
                                                            className="flex-1"
                                                        />
                                                        <Input
                                                            placeholder={t(
                                                                'sections.customMenu.pathPlaceholder',
                                                            )}
                                                            value={item.path}
                                                            onChange={(e) =>
                                                                updateMenuItem(
                                                                    'header',
                                                                    index,
                                                                    'path',
                                                                    e.target.value,
                                                                )
                                                            }
                                                            variant="form"
                                                            className="flex-1"
                                                        />
                                                        <Select
                                                            value={item.target || '_self'}
                                                            onChange={(e) =>
                                                                updateMenuItem(
                                                                    'header',
                                                                    index,
                                                                    'target',
                                                                    e.target.value,
                                                                )
                                                            }
                                                            variant="form"
                                                            className="w-24"
                                                        >
                                                            <option value="_self">
                                                                {t('sections.customMenu.targetSelf')}
                                                            </option>
                                                            <option value="_blank">
                                                                {t('sections.customMenu.targetBlank')}
                                                            </option>
                                                        </Select>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="sm"
                                                            onClick={() =>
                                                                removeMenuItem('header', index)
                                                            }
                                                            className="text-danger hover:text-danger shrink-0"
                                                        >
                                                            <TrashIcon className="h-4 w-4" />
                                                        </Button>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {/* Footer Links */}
                                    <div className="space-y-3">
                                        <div className="flex items-center justify-between">
                                            <h5 className="text-sm font-medium text-text dark:text-text-dark">
                                                {t('sections.customMenu.footerLinks')}
                                            </h5>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => addMenuItem('footer')}
                                                disabled={formData.custom_menu.footer.length >= 10}
                                            >
                                                <PlusIcon className="h-4 w-4" />
                                            </Button>
                                        </div>
                                        {formData.custom_menu.footer.length === 0 ? (
                                            <p className="text-sm text-text-muted dark:text-text-muted-dark italic py-2">
                                                {t('sections.customMenu.noLinks')}
                                            </p>
                                        ) : (
                                            <div className="space-y-2">
                                                {formData.custom_menu.footer.map((item, index) => (
                                                    <div
                                                        key={index}
                                                        className="flex items-center gap-2 p-2 bg-surface-secondary dark:bg-surface-secondary-dark rounded"
                                                    >
                                                        <Input
                                                            placeholder={t(
                                                                'sections.customMenu.labelPlaceholder',
                                                            )}
                                                            value={item.label}
                                                            onChange={(e) =>
                                                                updateMenuItem(
                                                                    'footer',
                                                                    index,
                                                                    'label',
                                                                    e.target.value,
                                                                )
                                                            }
                                                            variant="form"
                                                            className="flex-1"
                                                        />
                                                        <Input
                                                            placeholder={t(
                                                                'sections.customMenu.pathPlaceholder',
                                                            )}
                                                            value={item.path}
                                                            onChange={(e) =>
                                                                updateMenuItem(
                                                                    'footer',
                                                                    index,
                                                                    'path',
                                                                    e.target.value,
                                                                )
                                                            }
                                                            variant="form"
                                                            className="flex-1"
                                                        />
                                                        <Select
                                                            value={item.target || '_self'}
                                                            onChange={(e) =>
                                                                updateMenuItem(
                                                                    'footer',
                                                                    index,
                                                                    'target',
                                                                    e.target.value,
                                                                )
                                                            }
                                                            variant="form"
                                                            className="w-24"
                                                        >
                                                            <option value="_self">
                                                                {t('sections.customMenu.targetSelf')}
                                                            </option>
                                                            <option value="_blank">
                                                                {t('sections.customMenu.targetBlank')}
                                                            </option>
                                                        </Select>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="sm"
                                                            onClick={() =>
                                                                removeMenuItem('footer', index)
                                                            }
                                                            className="text-danger hover:text-danger shrink-0"
                                                        >
                                                            <TrashIcon className="h-4 w-4" />
                                                        </Button>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </SettingsCard>

                            {/* Save Button */}
                            <div className="flex justify-end pt-2">
                                <Button
                                    type="button"
                                    onClick={handleSave}
                                    disabled={isSaving}
                                    loading={isSaving}
                                >
                                    {t('save')}
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

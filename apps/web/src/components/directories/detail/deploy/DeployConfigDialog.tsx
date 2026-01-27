'use client';

import { useEffect, useState } from 'react';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import { Loader2, ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { getWebsiteSettings } from '@/app/actions/dashboard/directories';

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

export interface DeployConfigData {
    company_name: string;
    settings: WebsiteSettings;
    custom_menu: {
        header: CustomMenuItem[];
        footer: CustomMenuItem[];
    };
}

interface DeployConfigDialogProps {
    open: boolean;
    directoryId: string;
    isSubmitting?: boolean;
    onConfirm: (settings: DeployConfigData | null) => void;
    onCancel: () => void;
}

const DEFAULT_SETTINGS: WebsiteSettings = {
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
};

export function DeployConfigDialog({
    open,
    directoryId,
    isSubmitting = false,
    onConfirm,
    onCancel,
}: DeployConfigDialogProps) {
    const t = useTranslations('dashboard.directoryDetail.deploy.form.configDialog');
    const tSettings = useTranslations('dashboard.directoryDetail.settings.websiteConfig.sections');

    const [isLoading, setIsLoading] = useState(false);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [formData, setFormData] = useState<DeployConfigData>({
        company_name: 'Acme',
        settings: DEFAULT_SETTINGS,
        custom_menu: { header: [], footer: [] },
    });

    // Load settings when dialog opens
    useEffect(() => {
        if (open && !hasLoaded) {
            loadSettings();
        }
    }, [open, hasLoaded]);

    // Reset state when dialog closes
    useEffect(() => {
        if (!open) {
            setShowAdvanced(false);
        }
    }, [open]);

    const loadSettings = async () => {
        setIsLoading(true);
        try {
            const result = await getWebsiteSettings(directoryId);
            if (result.success && result.data) {
                const { company_name, settings, custom_menu } = result.data;
                setFormData({
                    company_name: company_name || 'Acme',
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
            toast.error(t('loadFailed'));
        } finally {
            setIsLoading(false);
        }
    };

    const handleSaveAndDeploy = () => {
        onConfirm(formData);
    };

    const handleSkipAndDeploy = () => {
        onConfirm(null);
    };

    const handleOpenChange = (nextOpen: boolean) => {
        if (!nextOpen) {
            onCancel();
        }
    };

    const updateSettings = <K extends keyof WebsiteSettings>(key: K, value: WebsiteSettings[K]) => {
        setFormData((prev) => ({
            ...prev,
            settings: {
                ...prev.settings,
                [key]: value,
            },
        }));
    };

    const updateHeaderSettings = (key: string, value: unknown) => {
        setFormData((prev) => ({
            ...prev,
            settings: {
                ...prev.settings,
                header: {
                    ...prev.settings.header,
                    [key]: value,
                },
            },
        }));
    };

    const updateHomepageSettings = (key: string, value: unknown) => {
        setFormData((prev) => ({
            ...prev,
            settings: {
                ...prev.settings,
                homepage: {
                    ...prev.settings.homepage,
                    [key]: value,
                },
            },
        }));
    };

    const updateFooterSettings = (key: string, value: unknown) => {
        setFormData((prev) => ({
            ...prev,
            settings: {
                ...prev.settings,
                footer: {
                    ...prev.settings.footer,
                    [key]: value,
                },
            },
        }));
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
                <DialogClose onClose={onCancel} />
                <DialogHeader>
                    <DialogTitle>{t('title')}</DialogTitle>
                    <DialogDescription>{t('description')}</DialogDescription>
                </DialogHeader>

                {isLoading ? (
                    <div className="flex justify-center py-8">
                        <Loader2 className="animate-spin h-8 w-8 text-primary" />
                    </div>
                ) : (
                    <div className="space-y-6">
                        {/* Site Name - Primary Setting */}
                        <div>
                            <Input
                                label={t('siteName')}
                                value={formData.company_name}
                                onChange={(e) =>
                                    setFormData((prev) => ({
                                        ...prev,
                                        company_name: e.target.value,
                                    }))
                                }
                                placeholder={t('siteNamePlaceholder')}
                                helperText={t('siteNameHelper')}
                                variant="form"
                            />
                        </div>

                        {/* Advanced Settings Toggle */}
                        <div className="border-t border-border dark:border-border-dark pt-4">
                            <button
                                type="button"
                                onClick={() => setShowAdvanced(!showAdvanced)}
                                className="w-full flex items-center justify-between text-left py-2 text-sm font-medium text-text dark:text-text-dark hover:text-primary dark:hover:text-primary-dark transition-colors"
                            >
                                <span>{t('advancedSettings')}</span>
                                {showAdvanced ? (
                                    <ChevronUpIcon className="h-4 w-4" />
                                ) : (
                                    <ChevronDownIcon className="h-4 w-4" />
                                )}
                            </button>

                            {showAdvanced && (
                                <div className="mt-4 space-y-6">
                                    {/* Global Settings */}
                                    <section>
                                        <h4 className="text-sm font-medium text-text dark:text-text-dark mb-3">
                                            {tSettings('global.title')}
                                        </h4>
                                        <div className="space-y-2">
                                            <Switch
                                                checked={formData.settings.categories_enabled ?? true}
                                                onChange={(checked) =>
                                                    updateSettings('categories_enabled', checked)
                                                }
                                                label={tSettings('global.categories')}
                                            />
                                            <Switch
                                                checked={formData.settings.tags_enabled ?? true}
                                                onChange={(checked) =>
                                                    updateSettings('tags_enabled', checked)
                                                }
                                                label={tSettings('global.tags')}
                                            />
                                            <Switch
                                                checked={formData.settings.companies_enabled ?? true}
                                                onChange={(checked) =>
                                                    updateSettings('companies_enabled', checked)
                                                }
                                                label={tSettings('global.companies')}
                                            />
                                            <Switch
                                                checked={formData.settings.surveys_enabled ?? true}
                                                onChange={(checked) =>
                                                    updateSettings('surveys_enabled', checked)
                                                }
                                                label={tSettings('global.surveys')}
                                            />
                                        </div>
                                    </section>

                                    {/* Header Settings */}
                                    <section>
                                        <h4 className="text-sm font-medium text-text dark:text-text-dark mb-3">
                                            {tSettings('header.title')}
                                        </h4>
                                        <div className="space-y-2">
                                            <Switch
                                                checked={
                                                    formData.settings.header?.submit_enabled ?? true
                                                }
                                                onChange={(checked) =>
                                                    updateHeaderSettings('submit_enabled', checked)
                                                }
                                                label={tSettings('header.submit')}
                                            />
                                            <Switch
                                                checked={
                                                    formData.settings.header?.pricing_enabled ?? true
                                                }
                                                onChange={(checked) =>
                                                    updateHeaderSettings('pricing_enabled', checked)
                                                }
                                                label={tSettings('header.pricing')}
                                            />
                                            <Switch
                                                checked={
                                                    formData.settings.header?.layout_enabled ?? true
                                                }
                                                onChange={(checked) =>
                                                    updateHeaderSettings('layout_enabled', checked)
                                                }
                                                label={tSettings('header.layoutSelector')}
                                            />
                                            <Switch
                                                checked={
                                                    formData.settings.header?.language_enabled ?? true
                                                }
                                                onChange={(checked) =>
                                                    updateHeaderSettings('language_enabled', checked)
                                                }
                                                label={tSettings('header.languageSelector')}
                                            />
                                            <Switch
                                                checked={
                                                    formData.settings.header?.theme_enabled ?? true
                                                }
                                                onChange={(checked) =>
                                                    updateHeaderSettings('theme_enabled', checked)
                                                }
                                                label={tSettings('header.themeSelector')}
                                            />
                                        </div>
                                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
                                            <Select
                                                label={tSettings('header.defaultLayout')}
                                                value={
                                                    formData.settings.header?.layout_default ||
                                                    'home1'
                                                }
                                                onChange={(e) =>
                                                    updateHeaderSettings(
                                                        'layout_default',
                                                        e.target.value,
                                                    )
                                                }
                                                variant="form"
                                            >
                                                <option value="home1">Home 1</option>
                                                <option value="home2">Home 2</option>
                                                <option value="home3">Home 3</option>
                                            </Select>
                                            <Select
                                                label={tSettings('header.defaultTheme')}
                                                value={
                                                    formData.settings.header?.theme_default ||
                                                    'light'
                                                }
                                                onChange={(e) =>
                                                    updateHeaderSettings(
                                                        'theme_default',
                                                        e.target.value,
                                                    )
                                                }
                                                variant="form"
                                            >
                                                <option value="light">
                                                    {tSettings('header.themeLight')}
                                                </option>
                                                <option value="dark">
                                                    {tSettings('header.themeDark')}
                                                </option>
                                                <option value="system">
                                                    {tSettings('header.themeSystem')}
                                                </option>
                                            </Select>
                                            <Select
                                                label={tSettings('header.defaultPagination')}
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
                                                    {tSettings('header.paginationStandard')}
                                                </option>
                                                <option value="infinite">
                                                    {tSettings('header.paginationInfinite')}
                                                </option>
                                                <option value="loadmore">
                                                    {tSettings('header.paginationLoadMore')}
                                                </option>
                                            </Select>
                                        </div>
                                    </section>

                                    {/* Homepage Settings */}
                                    <section>
                                        <h4 className="text-sm font-medium text-text dark:text-text-dark mb-3">
                                            {tSettings('homepage.title')}
                                        </h4>
                                        <div className="space-y-2">
                                            <Switch
                                                checked={
                                                    formData.settings.homepage?.hero_enabled ?? true
                                                }
                                                onChange={(checked) =>
                                                    updateHomepageSettings('hero_enabled', checked)
                                                }
                                                label={tSettings('homepage.hero')}
                                            />
                                            <Switch
                                                checked={
                                                    formData.settings.homepage?.search_enabled ??
                                                    true
                                                }
                                                onChange={(checked) =>
                                                    updateHomepageSettings('search_enabled', checked)
                                                }
                                                label={tSettings('homepage.search')}
                                            />
                                        </div>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                                            <Select
                                                label={tSettings('homepage.defaultView')}
                                                value={
                                                    formData.settings.homepage?.default_view ||
                                                    'classic'
                                                }
                                                onChange={(e) =>
                                                    updateHomepageSettings(
                                                        'default_view',
                                                        e.target.value,
                                                    )
                                                }
                                                variant="form"
                                            >
                                                <option value="classic">
                                                    {tSettings('homepage.viewClassic')}
                                                </option>
                                                <option value="grid">
                                                    {tSettings('homepage.viewGrid')}
                                                </option>
                                                <option value="list">
                                                    {tSettings('homepage.viewList')}
                                                </option>
                                            </Select>
                                            <Select
                                                label={tSettings('homepage.defaultSort')}
                                                value={
                                                    formData.settings.homepage?.default_sort ||
                                                    'popularity'
                                                }
                                                onChange={(e) =>
                                                    updateHomepageSettings(
                                                        'default_sort',
                                                        e.target.value,
                                                    )
                                                }
                                                variant="form"
                                            >
                                                <option value="popularity">
                                                    {tSettings('homepage.sortPopularity')}
                                                </option>
                                                <option value="newest">
                                                    {tSettings('homepage.sortNewest')}
                                                </option>
                                                <option value="alphabetical">
                                                    {tSettings('homepage.sortAlphabetical')}
                                                </option>
                                            </Select>
                                        </div>
                                    </section>

                                    {/* Footer Settings */}
                                    <section>
                                        <h4 className="text-sm font-medium text-text dark:text-text-dark mb-3">
                                            {tSettings('footer.title')}
                                        </h4>
                                        <div className="space-y-2">
                                            <Switch
                                                checked={
                                                    formData.settings.footer?.subscribe_enabled ??
                                                    true
                                                }
                                                onChange={(checked) =>
                                                    updateFooterSettings('subscribe_enabled', checked)
                                                }
                                                label={tSettings('footer.subscribe')}
                                            />
                                            <Switch
                                                checked={
                                                    formData.settings.footer?.version_enabled ?? true
                                                }
                                                onChange={(checked) =>
                                                    updateFooterSettings('version_enabled', checked)
                                                }
                                                label={tSettings('footer.version')}
                                            />
                                            <Switch
                                                checked={
                                                    formData.settings.footer
                                                        ?.theme_selector_enabled ?? true
                                                }
                                                onChange={(checked) =>
                                                    updateFooterSettings(
                                                        'theme_selector_enabled',
                                                        checked,
                                                    )
                                                }
                                                label={tSettings('footer.themeSelector')}
                                            />
                                        </div>
                                    </section>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                <DialogFooter className="flex-col sm:flex-row gap-2">
                    <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
                        {t('cancel')}
                    </Button>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={handleSkipAndDeploy}
                        disabled={isSubmitting || isLoading}
                    >
                        {t('skipAndDeploy')}
                    </Button>
                    <Button
                        type="button"
                        onClick={handleSaveAndDeploy}
                        disabled={isSubmitting || isLoading}
                    >
                        {isSubmitting ? (
                            <span className="flex items-center gap-2">
                                <Loader2 className="animate-spin h-4 w-4" />
                                {t('saveAndDeploy')}
                            </span>
                        ) : (
                            t('saveAndDeploy')
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
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
import { Globe, LayoutGrid, PanelTop, PanelBottom, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
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

type TabId = 'general' | 'header' | 'homepage' | 'footer';

const TABS: { id: TabId; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'general', icon: Globe },
    { id: 'header', icon: PanelTop },
    { id: 'homepage', icon: LayoutGrid },
    { id: 'footer', icon: PanelBottom },
];

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
    const [activeTab, setActiveTab] = useState<TabId>('general');
    const [formData, setFormData] = useState<DeployConfigData>({
        company_name: 'Acme',
        settings: DEFAULT_SETTINGS,
        custom_menu: { header: [], footer: [] },
    });

    const TAB_LABELS: Record<TabId, string> = {
        general: t('tabGeneral'),
        header: t('tabHeader'),
        homepage: t('tabHomepage'),
        footer: t('tabFooter'),
    };

    const loadSettings = useCallback(async () => {
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
    }, [directoryId, t]);

    useEffect(() => {
        if (open && !hasLoaded) {
            loadSettings();
        }
    }, [open, hasLoaded, loadSettings]);

    useEffect(() => {
        if (!open) {
            setActiveTab('general');
        }
    }, [open]);

    const handleSaveAndDeploy = () => onConfirm(formData);
    const handleSkipAndDeploy = () => onConfirm(null);
    const handleOpenChange = (nextOpen: boolean) => {
        if (!nextOpen) onCancel();
    };

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

    const renderTabContent = () => {
        switch (activeTab) {
            case 'general':
                return (
                    <div className="space-y-6">
                        <Input
                            label={t('siteName')}
                            value={formData.company_name}
                            onChange={(e) =>
                                setFormData((prev) => ({ ...prev, company_name: e.target.value }))
                            }
                            placeholder={t('siteNamePlaceholder')}
                            helperText={t('siteNameHelper')}
                            variant="form"
                        />
                        <div>
                            <p className="text-sm font-medium text-text dark:text-text-dark mb-3">
                                {t('featuresLabel')}
                            </p>
                            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                                <Switch
                                    checked={formData.settings.categories_enabled ?? true}
                                    onChange={(checked) =>
                                        updateSettings('categories_enabled', checked)
                                    }
                                    label={tSettings('global.categories')}
                                />
                                <Switch
                                    checked={formData.settings.tags_enabled ?? true}
                                    onChange={(checked) => updateSettings('tags_enabled', checked)}
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
                        </div>
                    </div>
                );

            case 'header':
                return (
                    <div className="space-y-6">
                        <div>
                            <p className="text-sm font-medium text-text dark:text-text-dark mb-3">
                                {t('visibilityLabel')}
                            </p>
                            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                                <Switch
                                    checked={formData.settings.header?.submit_enabled ?? true}
                                    onChange={(checked) =>
                                        updateHeaderSettings('submit_enabled', checked)
                                    }
                                    label={tSettings('header.submit')}
                                />
                                <Switch
                                    checked={formData.settings.header?.pricing_enabled ?? true}
                                    onChange={(checked) =>
                                        updateHeaderSettings('pricing_enabled', checked)
                                    }
                                    label={tSettings('header.pricing')}
                                />
                                <Switch
                                    checked={formData.settings.header?.layout_enabled ?? true}
                                    onChange={(checked) =>
                                        updateHeaderSettings('layout_enabled', checked)
                                    }
                                    label={tSettings('header.layoutSelector')}
                                />
                                <Switch
                                    checked={formData.settings.header?.language_enabled ?? true}
                                    onChange={(checked) =>
                                        updateHeaderSettings('language_enabled', checked)
                                    }
                                    label={tSettings('header.languageSelector')}
                                />
                                <Switch
                                    checked={formData.settings.header?.theme_enabled ?? true}
                                    onChange={(checked) =>
                                        updateHeaderSettings('theme_enabled', checked)
                                    }
                                    label={tSettings('header.themeSelector')}
                                />
                            </div>
                        </div>
                        <div>
                            <p className="text-sm font-medium text-text dark:text-text-dark mb-3">
                                {t('defaultsLabel')}
                            </p>
                            <div className="grid grid-cols-3 gap-4">
                                <Select
                                    label={tSettings('header.defaultLayout')}
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
                                    label={tSettings('header.defaultTheme')}
                                    value={formData.settings.header?.theme_default || 'light'}
                                    onChange={(e) =>
                                        updateHeaderSettings('theme_default', e.target.value)
                                    }
                                    variant="form"
                                >
                                    <option value="light">{tSettings('header.themeLight')}</option>
                                    <option value="dark">{tSettings('header.themeDark')}</option>
                                    <option value="system">
                                        {tSettings('header.themeSystem')}
                                    </option>
                                </Select>
                                <Select
                                    label={tSettings('header.defaultPagination')}
                                    value={
                                        formData.settings.header?.pagination_default || 'standard'
                                    }
                                    onChange={(e) =>
                                        updateHeaderSettings('pagination_default', e.target.value)
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
                        </div>
                    </div>
                );

            case 'homepage':
                return (
                    <div className="space-y-6">
                        <div>
                            <p className="text-sm font-medium text-text dark:text-text-dark mb-3">
                                {t('visibilityLabel')}
                            </p>
                            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                                <Switch
                                    checked={formData.settings.homepage?.hero_enabled ?? true}
                                    onChange={(checked) =>
                                        updateHomepageSettings('hero_enabled', checked)
                                    }
                                    label={tSettings('homepage.hero')}
                                />
                                <Switch
                                    checked={formData.settings.homepage?.search_enabled ?? true}
                                    onChange={(checked) =>
                                        updateHomepageSettings('search_enabled', checked)
                                    }
                                    label={tSettings('homepage.search')}
                                />
                            </div>
                        </div>
                        <div>
                            <p className="text-sm font-medium text-text dark:text-text-dark mb-3">
                                {t('defaultsLabel')}
                            </p>
                            <div className="grid grid-cols-2 gap-4">
                                <Select
                                    label={tSettings('homepage.defaultView')}
                                    value={formData.settings.homepage?.default_view || 'classic'}
                                    onChange={(e) =>
                                        updateHomepageSettings('default_view', e.target.value)
                                    }
                                    variant="form"
                                >
                                    <option value="classic">
                                        {tSettings('homepage.viewClassic')}
                                    </option>
                                    <option value="grid">{tSettings('homepage.viewGrid')}</option>
                                    <option value="list">{tSettings('homepage.viewList')}</option>
                                </Select>
                                <Select
                                    label={tSettings('homepage.defaultSort')}
                                    value={formData.settings.homepage?.default_sort || 'popularity'}
                                    onChange={(e) =>
                                        updateHomepageSettings('default_sort', e.target.value)
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
                        </div>
                    </div>
                );

            case 'footer':
                return (
                    <div>
                        <p className="text-sm font-medium text-text dark:text-text-dark mb-3">
                            {t('visibilityLabel')}
                        </p>
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                            <Switch
                                checked={formData.settings.footer?.subscribe_enabled ?? true}
                                onChange={(checked) =>
                                    updateFooterSettings('subscribe_enabled', checked)
                                }
                                label={tSettings('footer.subscribe')}
                            />
                            <Switch
                                checked={formData.settings.footer?.version_enabled ?? true}
                                onChange={(checked) =>
                                    updateFooterSettings('version_enabled', checked)
                                }
                                label={tSettings('footer.version')}
                            />
                            <Switch
                                checked={formData.settings.footer?.theme_selector_enabled ?? true}
                                onChange={(checked) =>
                                    updateFooterSettings('theme_selector_enabled', checked)
                                }
                                label={tSettings('footer.themeSelector')}
                            />
                        </div>
                    </div>
                );
        }
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogClose onClose={onCancel} />
                <DialogHeader>
                    <DialogTitle>{t('title')}</DialogTitle>
                    <DialogDescription>{t('description')}</DialogDescription>
                </DialogHeader>

                {isLoading ? (
                    <div className="flex justify-center py-16">
                        <Loader2 className="animate-spin h-8 w-8 text-primary" />
                    </div>
                ) : (
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
                                    {TAB_LABELS[id]}
                                </button>
                            ))}
                        </div>

                        {/* Tab Content */}
                        <div className="min-h-[220px]">{renderTabContent()}</div>
                    </div>
                )}

                <DialogFooter className="flex-col sm:flex-row gap-2 pt-4 border-t border-border dark:border-border-dark">
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={onCancel}
                        disabled={isSubmitting}
                        className="sm:mr-auto"
                    >
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

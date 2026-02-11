'use client';

import { useState, useCallback, memo, Dispatch, SetStateAction, KeyboardEvent } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { Loader2, Link2, Plus, X, Camera } from 'lucide-react';
import { extractItemDetails, captureScreenshot } from '@/app/actions/dashboard/items';
import { toast } from 'sonner';
import { CategoriesField } from './CategoriesField';
import { useItemsContext } from './ItemsContext';

export interface ItemFormData {
    name: string;
    description: string;
    source_url: string;
    categories: string[];
    tags: string[];
    featured: boolean;
    pay_and_publish_now: boolean;
    slug: string;
    brand: string;
    brand_logo_url: string;
    images: string[];
}

interface AddItemFormProps {
    categories: string[];
    formData: ItemFormData;
    setFormData: Dispatch<SetStateAction<ItemFormData>>;
    updateWithPR: boolean;
    setUpdateWithPR: (value: boolean) => void;
    isPending: boolean;
}

export const AddItemForm = memo(function AddItemForm({
    categories,
    formData,
    setFormData,
    updateWithPR,
    setUpdateWithPR,
    isPending,
}: AddItemFormProps) {
    const t = useTranslations('dashboard.directoryDetail.items.addModal');
    const [isExtracting, setIsExtracting] = useState(false);
    const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
    const [tagInput, setTagInput] = useState('');
    const [imageInput, setImageInput] = useState('');

    const isValidHttpUrl = useCallback((value: string) => {
        try {
            const url = new URL(value);
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch {
            return false;
        }
    }, []);

    const handleExtractFromUrl = async () => {
        if (!formData.source_url) {
            toast.error(t('errors.urlRequired'));
            return;
        }

        if (!isValidHttpUrl(formData.source_url)) {
            toast.error(t('errors.invalidUrl'));
            return;
        }

        setIsExtracting(true);
        try {
            const result = await extractItemDetails(formData.source_url, categories);

            if (result.success && result.data) {
                setFormData((prev) => {
                    // Handle extracted category - add to categories if valid and not already present
                    let newCategories = [...prev.categories];
                    if (result.data?.category) {
                        const extractedCategory = result.data.category;
                        if (!newCategories.includes(extractedCategory)) {
                            newCategories = [...newCategories, extractedCategory];
                        }
                    }

                    return {
                        ...prev,
                        name: result.data.name || prev.name,
                        description: result.data.description || prev.description,
                        tags:
                            result.data.tags && result.data.tags.length > 0
                                ? ([...result.data.tags] as string[])
                                : prev.tags,
                        categories: newCategories.length > 0 ? newCategories : prev.categories,
                        brand: result.data.brand || prev.brand,
                        brand_logo_url: result.data.brand_logo_url || prev.brand_logo_url,
                        images:
                            result.data.images && result.data.images.length > 0
                                ? [...result.data.images]
                                : prev.images,
                    };
                });
                toast.success(result.message || t('extractSuccess'));
            } else {
                toast.error(result.error || t('extractFailed'));
            }
        } catch (error) {
            console.error(error);
            toast.error(t('extractError'));
        } finally {
            setIsExtracting(false);
        }
    };

    const handleAddCategory = (category: string) => {
        if (category.trim() && !formData.categories.includes(category.trim())) {
            setFormData({
                ...formData,
                categories: [...formData.categories, category.trim()],
            });
        }
    };

    const handleRemoveCategory = (category: string) => {
        setFormData({
            ...formData,
            categories: formData.categories.filter((c) => c !== category),
        });
    };

    const handleAddTag = () => {
        if (tagInput.trim() && !formData.tags.includes(tagInput.trim())) {
            setFormData({
                ...formData,
                tags: [...formData.tags, tagInput.trim()],
            });
            setTagInput('');
        }
    };

    const handleRemoveTag = (tag: string) => {
        setFormData({
            ...formData,
            tags: formData.tags.filter((t) => t !== tag),
        });
    };

    const handleAddImage = () => {
        if (imageInput.trim() && isValidHttpUrl(imageInput.trim())) {
            if (!formData.images.includes(imageInput.trim())) {
                setFormData({
                    ...formData,
                    images: [...formData.images, imageInput.trim()],
                });
            }
            setImageInput('');
        } else if (imageInput.trim()) {
            toast.error(t('errors.invalidImageUrl'));
        }
    };

    const handleRemoveImage = (url: string) => {
        setFormData({
            ...formData,
            images: formData.images.filter((img) => img !== url),
        });
    };

    const handleCaptureScreenshot = async () => {
        if (!formData.source_url) {
            toast.error(t('errors.urlRequired'));
            return;
        }

        if (!isValidHttpUrl(formData.source_url)) {
            toast.error(t('errors.invalidUrl'));
            return;
        }

        setIsCapturingScreenshot(true);
        try {
            const result = await captureScreenshot(formData.source_url);

            if (result.success && result.imageUrl) {
                if (!formData.images.includes(result.imageUrl)) {
                    setFormData({
                        ...formData,
                        images: [result.imageUrl, ...formData.images],
                    });
                }
                toast.success(result.message || t('screenshotSuccess'));
            } else {
                toast.error(result.error || t('screenshotFailed'));
            }
        } catch (error) {
            console.error(error);
            toast.error(t('screenshotError'));
        } finally {
            setIsCapturingScreenshot(false);
        }
    };

    return (
        <div className="space-y-4">
            {/* Source URL with Extract Button */}
            <div className="space-y-2">
                <label className="text-sm font-medium text-text dark:text-text-dark">
                    {t('sourceUrl')} *
                </label>
                <div className="flex gap-2">
                    <Input
                        type="url"
                        value={formData.source_url}
                        onChange={(e) => setFormData({ ...formData, source_url: e.target.value })}
                        placeholder={t('sourceUrlPlaceholder')}
                        variant="form"
                        className="flex-1"
                        disabled={isPending}
                    />
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={handleExtractFromUrl}
                        disabled={isPending || isExtracting || !formData.source_url}
                        className="shrink-0"
                    >
                        {isExtracting ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <Link2 className="w-4 h-4" />
                        )}
                        <span className="ml-2">{t('extract')}</span>
                    </Button>
                </div>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('sourceUrlHelp')}
                </p>
            </div>

            {/* Name */}
            <Input
                label={`${t('name')} *`}
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder={t('namePlaceholder')}
                variant="form"
                disabled={isPending}
            />

            {/* Description */}
            <Textarea
                label={`${t('description')} *`}
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder={t('descriptionPlaceholder')}
                rows={3}
                variant="form"
                disabled={isPending}
            />

            {/* Categories */}
            <CategoriesField
                existingCategories={categories}
                selectedCategories={formData.categories}
                onAddCategory={handleAddCategory}
                onRemoveCategory={handleRemoveCategory}
                isPending={isPending}
            />

            {/* Tags */}
            <TagsField
                tags={formData.tags}
                tagInput={tagInput}
                setTagInput={setTagInput}
                onAddTag={handleAddTag}
                onRemoveTag={handleRemoveTag}
                isPending={isPending}
            />

            {/* Slug (optional) */}
            <div className="space-y-2">
                <Input
                    label={t('slug')}
                    type="text"
                    value={formData.slug}
                    onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
                    placeholder={t('slugPlaceholder')}
                    variant="form"
                    disabled={isPending}
                />
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('slugHelp')}</p>
            </div>

            {/* Brand (optional) */}
            <Input
                label={t('brand')}
                type="text"
                value={formData.brand}
                onChange={(e) => setFormData({ ...formData, brand: e.target.value })}
                placeholder={t('brandPlaceholder')}
                variant="form"
                disabled={isPending}
            />

            {/* Brand Logo URL (optional) */}
            <Input
                label={t('brandLogoUrl')}
                type="url"
                value={formData.brand_logo_url}
                onChange={(e) => setFormData({ ...formData, brand_logo_url: e.target.value })}
                placeholder={t('brandLogoUrlPlaceholder')}
                variant="form"
                disabled={isPending}
            />

            {/* Images (optional) */}
            <ImagesField
                images={formData.images}
                imageInput={imageInput}
                setImageInput={setImageInput}
                onAddImage={handleAddImage}
                onRemoveImage={handleRemoveImage}
                onCaptureScreenshot={handleCaptureScreenshot}
                isCapturingScreenshot={isCapturingScreenshot}
                sourceUrl={formData.source_url}
                isPending={isPending}
            />

            {/* Options */}
            <div className="space-y-3">
                <Checkbox
                    checked={formData.featured}
                    onChange={(e) => setFormData({ ...formData, featured: e.target.checked })}
                    label={t('featured')}
                    description={t('featuredHelp')}
                    variant="form"
                    disabled={isPending}
                />

                <Checkbox
                    checked={updateWithPR}
                    onChange={(e) => setUpdateWithPR(e.target.checked)}
                    label={t('updateWithPR')}
                    description={t('updateWithPRHelp')}
                    variant="form"
                    disabled={isPending}
                />
            </div>
        </div>
    );
});

interface TagsFieldProps {
    tags: string[];
    tagInput: string;
    setTagInput: (value: string) => void;
    onAddTag: () => void;
    onRemoveTag: (tag: string) => void;
    isPending: boolean;
}

const TagsField = memo(function TagsField({
    tags,
    tagInput,
    setTagInput,
    onAddTag,
    onRemoveTag,
    isPending,
}: TagsFieldProps) {
    const t = useTranslations('dashboard.directoryDetail.items.addModal');

    return (
        <div className="space-y-2">
            <label className="text-sm font-medium text-text dark:text-text-dark">{t('tags')}</label>
            <div className="flex gap-2">
                <Input
                    type="text"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e: KeyboardEvent) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            onAddTag();
                        }
                    }}
                    placeholder={t('tagPlaceholder')}
                    variant="form"
                    className="flex-1"
                    disabled={isPending}
                />
                <Button
                    type="button"
                    variant="secondary"
                    onClick={onAddTag}
                    disabled={isPending || !tagInput.trim()}
                >
                    <Plus className="w-4 h-4" />
                </Button>
            </div>
            {tags.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                    {tags.map((tag) => (
                        <span
                            key={tag}
                            className={cn(
                                'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs',
                                'bg-primary/10 dark:bg-primary-dark/10',
                                'text-primary dark:text-primary-dark',
                            )}
                        >
                            {tag}
                            <button
                                type="button"
                                onClick={() => onRemoveTag(tag)}
                                className="hover:opacity-70"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
});

interface ImagesFieldProps {
    images: string[];
    imageInput: string;
    setImageInput: (value: string) => void;
    onAddImage: () => void;
    onRemoveImage: (url: string) => void;
    onCaptureScreenshot: () => void;
    isCapturingScreenshot: boolean;
    sourceUrl: string;
    isPending: boolean;
}

const ImagesField = memo(function ImagesField({
    images,
    imageInput,
    setImageInput,
    onAddImage,
    onRemoveImage,
    onCaptureScreenshot,
    isCapturingScreenshot,
    sourceUrl,
    isPending,
}: ImagesFieldProps) {
    const t = useTranslations('dashboard.directoryDetail.items.addModal');
    const { screenshotAvailable } = useItemsContext();

    const isValidHttpUrl = (value: string) => {
        try {
            const url = new URL(value);
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch {
            return false;
        }
    };

    return (
        <div className="space-y-2">
            <label className="text-sm font-medium text-text dark:text-text-dark">
                {t('images')}
            </label>
            <div className="flex gap-2">
                <Input
                    type="url"
                    value={imageInput}
                    onChange={(e) => setImageInput(e.target.value)}
                    onKeyDown={(e: KeyboardEvent) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            onAddImage();
                        }
                    }}
                    placeholder={t('imagePlaceholder')}
                    variant="form"
                    className="flex-1"
                    disabled={isPending}
                />
                <Button
                    type="button"
                    variant="secondary"
                    onClick={onAddImage}
                    disabled={isPending || !imageInput.trim()}
                >
                    <Plus className="w-4 h-4" />
                </Button>
            </div>
            {screenshotAvailable && (
                <div className="flex items-center gap-2">
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={onCaptureScreenshot}
                        disabled={
                            isPending ||
                            isCapturingScreenshot ||
                            !sourceUrl ||
                            !isValidHttpUrl(sourceUrl)
                        }
                        className="shrink-0"
                    >
                        {isCapturingScreenshot ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <Camera className="w-4 h-4" />
                        )}
                        <span className="ml-2">{t('captureScreenshot')}</span>
                    </Button>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('captureScreenshotHelp')}
                    </p>
                </div>
            )}
            {images.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                    {images.map((url) => (
                        <span
                            key={url}
                            className={cn(
                                'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs max-w-[200px]',
                                'bg-surface-secondary dark:bg-surface-secondary-dark',
                                'text-text dark:text-text-dark',
                            )}
                        >
                            <span className="truncate">{url}</span>
                            <button
                                type="button"
                                onClick={() => onRemoveImage(url)}
                                className="hover:opacity-70 shrink-0"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
});

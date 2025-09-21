'use client';

import { useState, useTransition } from 'react';
import { Directory, UpdateDirectoryDto } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import { deleteDirectory } from '@/app/actions/dashboard/directories';
import { ROUTES } from '@/lib/constants';

interface SettingsFormProps {
    directory: Directory;
}

export function SettingsForm({ directory }: SettingsFormProps) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    const [formData, setFormData] = useState<UpdateDirectoryDto>({
        name: directory.name,
        description: directory.description,
        readmeConfig: directory.readmeConfig || {
            header: '',
            overwriteDefaultHeader: false,
            footer: '',
            overwriteDefaultFooter: false,
        },
    });

    const handleUpdate = async (e: React.FormEvent) => {
        e.preventDefault();
        // TODO: Implement update action
        toast.success('Settings updated successfully');
    };

    const handleDelete = async () => {
        if (!showDeleteConfirm) {
            setShowDeleteConfirm(true);
            return;
        }

        startTransition(async () => {
            const result = await deleteDirectory(directory.id);

            if (result.success) {
                toast.success(result.message || 'Directory deleted successfully');
                router.push(ROUTES.DASHBOARD_DIRECTORIES);
            } else {
                toast.error(result.error || 'Failed to delete directory');
            }
        });
    };

    return (
        <div className="space-y-6">
            {/* General Settings */}
            <div className={cn(
                'rounded-lg border p-6',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
            )}>
                <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-4">
                    General Settings
                </h3>

                <form onSubmit={handleUpdate} className="space-y-4">
                    <Input
                        label="Directory Name"
                        type="text"
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        variant="form"
                        required
                    />

                    <Textarea
                        label="Description"
                        value={formData.description}
                        onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                        rows={3}
                        variant="form"
                        required
                    />

                    <Button type="submit" disabled={isPending} variant="primary">
                        Save Changes
                    </Button>
                </form>
            </div>

            {/* README Configuration */}
            <div className={cn(
                'rounded-lg border p-6',
                'bg-card dark:bg-card-dark',
                'border-card-border dark:border-card-border-dark',
            )}>
                <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-4">
                    README Configuration
                </h3>

                <div className="space-y-4">
                    <div className="space-y-3">
                        <Textarea
                            label="Custom Header"
                            value={formData.readmeConfig?.header || ''}
                            onChange={(e) => setFormData({
                                ...formData,
                                readmeConfig: {
                                    ...formData.readmeConfig,
                                    header: e.target.value,
                                },
                            })}
                            placeholder="Add custom content to the README header"
                            rows={3}
                            variant="form"
                        />
                        <Checkbox
                            checked={formData.readmeConfig?.overwriteDefaultHeader || false}
                            onChange={(e) => setFormData({
                                ...formData,
                                readmeConfig: {
                                    ...formData.readmeConfig,
                                    overwriteDefaultHeader: e.target.checked,
                                },
                            })}
                            label="Overwrite default header"
                            variant="form"
                        />
                    </div>

                    <div className="space-y-3">
                        <Textarea
                            label="Custom Footer"
                            value={formData.readmeConfig?.footer || ''}
                            onChange={(e) => setFormData({
                                ...formData,
                                readmeConfig: {
                                    ...formData.readmeConfig,
                                    footer: e.target.value,
                                },
                            })}
                            placeholder="Add custom content to the README footer"
                            rows={3}
                            variant="form"
                        />
                        <Checkbox
                            checked={formData.readmeConfig?.overwriteDefaultFooter || false}
                            onChange={(e) => setFormData({
                                ...formData,
                                readmeConfig: {
                                    ...formData.readmeConfig,
                                    overwriteDefaultFooter: e.target.checked,
                                },
                            })}
                            label="Overwrite default footer"
                            variant="form"
                        />
                    </div>

                    <Button type="button" disabled={isPending} variant="secondary">
                        Update README
                    </Button>
                </div>
            </div>

            {/* Danger Zone */}
            <div className={cn(
                'rounded-lg border-2 p-6',
                'bg-red-50 dark:bg-red-900/20',
                'border-red-200 dark:border-red-800',
            )}>
                <h3 className="text-lg font-semibold text-red-800 dark:text-red-200 mb-2">
                    Danger Zone
                </h3>
                <p className="text-sm text-red-700 dark:text-red-300 mb-4">
                    Once you delete a directory, there is no going back. Please be certain.
                </p>

                {showDeleteConfirm ? (
                    <div className="flex items-center gap-3">
                        <p className="text-sm text-red-700 dark:text-red-300">
                            Are you absolutely sure?
                        </p>
                        <Button
                            onClick={handleDelete}
                            disabled={isPending}
                            loading={isPending}
                            variant="primary"
                            className="bg-red-600 hover:bg-red-700"
                        >
                            Yes, Delete
                        </Button>
                        <Button
                            onClick={() => setShowDeleteConfirm(false)}
                            disabled={isPending}
                            variant="secondary"
                        >
                            Cancel
                        </Button>
                    </div>
                ) : (
                    <Button
                        onClick={handleDelete}
                        disabled={isPending}
                        variant="secondary"
                        className="border-red-600 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
                    >
                        Delete Directory
                    </Button>
                )}
            </div>
        </div>
    );
}
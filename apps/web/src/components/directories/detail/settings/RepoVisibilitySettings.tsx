'use client';

import { useState } from 'react';
import { useSettings } from './SettingsContext';
import { RepositoryStatus, RepositoryType } from '@/lib/api/directory';
import { toggleRepositoryVisibility } from '@/app/actions/dashboard/directories';
import { Switch } from '@/components/ui/switch';
import { Loader2, Lock, Unlock, Github } from 'lucide-react';
import { toast } from 'sonner';

interface RepoVisibilitySettingsProps {
    initialRepositories: RepositoryStatus[];
}

export function RepoVisibilitySettings({ initialRepositories }: RepoVisibilitySettingsProps) {
    const { context } = useSettings();
    const { directory } = context;
    const [repositories, setRepositories] = useState<RepositoryStatus[]>(initialRepositories);
    const [updating, setUpdating] = useState<RepositoryType | null>(null);

    const handleToggle = async (repo: RepositoryStatus) => {
        try {
            setUpdating(repo.type);
            const newIsPrivate = !repo.isPrivate;

            const result = await toggleRepositoryVisibility(directory.id, repo.type, newIsPrivate);

            if (result.success) {
                setRepositories((prev) =>
                    prev.map((r) => (r.type === repo.type ? { ...r, isPrivate: newIsPrivate } : r)),
                );

                toast.success(`${repo.name} is now ${newIsPrivate ? 'Private' : 'Public'}`);
            } else {
                toast.error(result.error || 'Failed to update repository visibility');
            }
        } catch (error) {
            console.error('Failed to update repo visibility:', error);
            toast.error('Failed to update repository visibility');
        } finally {
            setUpdating(null);
        }
    };

    return (
        <div className="bg-card dark:bg-card-dark border border-border dark:border-border-dark rounded-lg p-6">
            <h3 className="text-lg font-medium mb-4">Repository Visibility</h3>
            <div className="space-y-4">
                {repositories.map((repo) => (
                    <div
                        key={repo.type}
                        className="flex items-center justify-between p-4 border rounded-lg dark:border-border-dark"
                    >
                        <div className="space-y-1">
                            <div className="flex items-center gap-2">
                                <span className="font-medium capitalize">
                                    {repo.type === 'directory'
                                        ? 'Main'
                                        : repo.type === 'data'
                                          ? 'Data'
                                          : 'Website'}{' '}
                                    Repo
                                </span>
                                {repo.isPrivate ? (
                                    <Lock className="h-3 w-3 text-muted-foreground" />
                                ) : (
                                    <Unlock className="h-3 w-3 text-muted-foreground" />
                                )}
                            </div>
                            <div className="text-sm text-muted-foreground flex items-center gap-1">
                                <Github className="h-3 w-3" />
                                {repo.name}
                            </div>
                        </div>

                        <div className="flex items-center gap-3">
                            <span className="text-sm font-medium">
                                {repo.isPrivate ? 'Private' : 'Public'}
                            </span>
                            <Switch
                                checked={!repo.isPrivate}
                                onChange={() => handleToggle(repo)}
                                disabled={updating === repo.type || !repo.exists}
                            />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

'use client';

import { useState, useTransition } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { updateProfile } from '@/app/actions/settings';
import { toast } from 'sonner';

interface ProfileSettingsProps {
    user: {
        id: string;
        username: string;
        email: string;
    };
}

export function ProfileSettings({ user }: ProfileSettingsProps) {
    const [isPending, startTransition] = useTransition();
    const [username, setUsername] = useState(user.username);

    const handleSaveProfile = () => {
        if (!username.trim()) {
            toast.error('Username is required');
            return;
        }

        startTransition(async () => {
            try {
                const result = await updateProfile({
                    username: username.trim(),
                });

                if (result.success) {
                    toast.success('Profile updated successfully');
                } else {
                    toast.error(result.error || 'Failed to update profile');
                }
            } catch (error) {
                toast.error('An unexpected error occurred');
            }
        });
    };

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-4">
                    Profile Settings
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">
                    Update your profile information and avatar
                </p>
            </div>

            <div className="space-y-4">
                {/* Username Field */}
                <Input
                    label="Username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Enter your username"
                />

                {/* Email Field (Read-only) */}
                <Input
                    label="Email"
                    type="email"
                    value={user.email}
                    disabled
                    helperText="Email cannot be changed"
                />

                {/* Save Button */}
                <div className="flex justify-end">
                    <Button
                        onClick={handleSaveProfile}
                        loading={isPending}
                    >
                        Save Changes
                    </Button>
                </div>
            </div>
        </div>
    );
}
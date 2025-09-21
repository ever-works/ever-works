'use client';

import { useState } from 'react';
import { Directory } from '@/lib/api';
import { DirectoryHeader } from '@/components/directories/detail/DirectoryHeader';
import { DirectoryTabs } from '@/components/directories/detail/DirectoryTabs';
import { OverviewTab } from '@/components/directories/detail/tabs/OverviewTab';
import { ItemsTab } from '@/components/directories/detail/tabs/ItemsTab';
import { GeneratorTab } from '@/components/directories/detail/tabs/GeneratorTab';

interface DirectoryClientProps {
    directory: Directory;
}

export default function DirectoryClient({ directory }: DirectoryClientProps) {
    const [activeTab, setActiveTab] = useState<'overview' | 'items' | 'generator'>('overview');

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
            <DirectoryHeader directory={directory} />

            <DirectoryTabs activeTab={activeTab} onTabChange={setActiveTab} />

            <div className="mt-6">
                {activeTab === 'overview' && <OverviewTab directory={directory} />}
                {activeTab === 'items' && <ItemsTab directoryId={directory.id} />}
                {activeTab === 'generator' && (
                    <GeneratorTab
                        directoryId={directory.id}
                        isGenerating={directory.generateStatus?.status === 'generating'}
                    />
                )}
            </div>
        </div>
    );
}
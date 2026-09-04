import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Work } from '@/lib/api/types-only';
import type { AuthUser } from '@/lib/auth';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

// The form is a composition root: each card is its own client component
// with its own data needs. They are stubbed to a marker so the spec asserts
// only what this file decides — which cards are mounted for which kind.
vi.mock('./SettingsContext', () => ({
    SettingsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./DeleteComponent', () => ({
    DeleteComponent: () => <div data-testid="card-delete" />,
}));
vi.mock('./GeneralSettings', () => ({
    GeneralSettings: () => <div data-testid="card-general" />,
}));
vi.mock('./SourceSettings', () => ({
    SourceSettings: () => <div data-testid="card-source" />,
}));
vi.mock('./ReadmeConfiguration', () => ({
    ReadmeConfiguration: () => <div data-testid="card-readme" />,
}));
vi.mock('./RepoVisibilitySettings', () => ({
    RepoVisibilitySettings: () => <div data-testid="card-repo-visibility" />,
}));
vi.mock('./AdvancedPromptsSettings', () => ({
    AdvancedPromptsSettings: () => <div data-testid="card-advanced-prompts" />,
}));
vi.mock('./CommunityPrSettings', () => ({
    CommunityPrSettings: () => <div data-testid="card-community-pr" />,
}));
vi.mock('./ProviderRepositorySettings', () => ({
    ProviderRepositorySettings: () => <div data-testid="card-provider-repository" />,
}));
vi.mock('./WebsiteConfigSettings', () => ({
    WebsiteConfigSettings: () => <div data-testid="card-website-config" />,
}));
vi.mock('./ItemImportExportSettings', () => ({
    ItemImportExportSettings: () => <div data-testid="card-item-import-export" />,
}));
vi.mock('./CommitterSettings', () => ({
    CommitterSettings: () => <div data-testid="card-committer" />,
}));
vi.mock('./ActivitySyncSettings', () => ({
    ActivitySyncSettings: () => <div data-testid="card-activity-sync" />,
}));
vi.mock('./TaskIsolationSettings', () => ({
    TaskIsolationSettings: () => <div data-testid="card-task-isolation" />,
}));
vi.mock('./QualityGatesSettings', () => ({
    QualityGatesSettings: () => <div data-testid="card-quality-gates" />,
}));
vi.mock('./MergePolicySettings', () => ({
    MergePolicySettings: () => <div data-testid="card-merge-policy" />,
}));
vi.mock('./ExternalRefsSettings', () => ({
    ExternalRefsSettings: () => <div data-testid="card-external-refs" />,
}));

import { SettingsForm } from './SettingsForm';

const USER = { id: 'u1' } as unknown as AuthUser;

function makeWork(kind: string): Work {
    return { id: 'w1', name: 'Platform', kind } as unknown as Work;
}

describe('SettingsForm — cards per Work kind', () => {
    it('mounts the repository-visibility and community-PR cards for a default Work', () => {
        render(<SettingsForm work={makeWork('default')} user={USER} initialRepositories={[]} />);

        expect(screen.getByTestId('card-repo-visibility')).toBeInTheDocument();
        expect(screen.getByTestId('card-community-pr')).toBeInTheDocument();
        expect(screen.getByTestId('card-delete')).toBeInTheDocument();
    });

    // Self-build slice D (EW-766): the API refuses to flip the visibility of
    // a repository the platform did not create and refuses community-PR
    // intake on it, so neither card is offered for a Repository Work. The
    // provider-repository card and the danger zone stay — the latter gates
    // its own checkboxes by kind.
    it('withholds the repository-visibility and community-PR cards for a Repository Work', () => {
        render(<SettingsForm work={makeWork('repo')} user={USER} initialRepositories={[]} />);

        expect(screen.queryByTestId('card-repo-visibility')).not.toBeInTheDocument();
        expect(screen.queryByTestId('card-community-pr')).not.toBeInTheDocument();
        expect(screen.getByTestId('card-provider-repository')).toBeInTheDocument();
        expect(screen.getByTestId('card-delete')).toBeInTheDocument();
    });
});

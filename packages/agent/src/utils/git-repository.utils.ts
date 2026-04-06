import type { GitRepository } from '@ever-works/plugin';

export function assertCreatedRepositoryTarget(
    createdRepository: GitRepository,
    expectedOwner: string,
    expectedName: string,
    contextLabel: string,
): GitRepository {
    if (createdRepository.owner === expectedOwner && createdRepository.name === expectedName) {
        return createdRepository;
    }

    throw new Error(
        `${contextLabel} was created as ${createdRepository.fullName}, but the directory expects ${expectedOwner}/${expectedName}. ` +
            'This usually means the connected Git account does not match the directory owner.',
    );
}

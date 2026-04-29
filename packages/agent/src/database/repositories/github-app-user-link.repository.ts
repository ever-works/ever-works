import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GitHubAppUserLink } from '../../entities';

export type UpsertGitHubAppUserLinkData = {
    userId: string;
    githubUserId: string;
    githubLogin: string;
    githubNodeId?: string | null;
    accessToken?: string | null;
    refreshToken?: string | null;
    accessTokenExpiresAt?: Date | null;
    refreshTokenExpiresAt?: Date | null;
    scope?: string | null;
};

@Injectable()
export class GitHubAppUserLinkRepository {
    constructor(
        @InjectRepository(GitHubAppUserLink)
        private readonly repository: Repository<GitHubAppUserLink>,
    ) {}

    async findByUserId(userId: string): Promise<GitHubAppUserLink | null> {
        return this.repository.findOne({ where: { userId } });
    }

    async findByGithubUserId(githubUserId: string): Promise<GitHubAppUserLink | null> {
        return this.repository.findOne({ where: { githubUserId } });
    }

    async upsertLink(data: UpsertGitHubAppUserLinkData): Promise<GitHubAppUserLink> {
        const existingByUserId = await this.findByUserId(data.userId);
        const existingByGithubUserId = await this.findByGithubUserId(data.githubUserId);

        if (
            existingByUserId &&
            existingByGithubUserId &&
            existingByUserId.id !== existingByGithubUserId.id
        ) {
            throw new ConflictException(
                `GitHub user ${data.githubUserId} is already linked to another Ever Works user`,
            );
        }

        const target = existingByUserId ?? existingByGithubUserId;
        if (target) {
            await this.repository.update(target.id, data);
            return this.repository.findOneOrFail({ where: { id: target.id } });
        }

        return this.repository.save(this.repository.create(data));
    }
}

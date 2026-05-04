import { createHash } from 'node:crypto';
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    HttpException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    UnprocessableEntityException,
    UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnboardingRequest, type OnboardingStatus } from '@ever-works/agent/entities';
import {
    ONBOARDING_ACCOUNT_UPSERT,
    ONBOARDING_GIT_PROVIDER,
    ONBOARDING_WORK_CREATOR,
    OnboardingRequestRepository,
    WorksManifestService,
    type OnboardingAccountUpsert,
    type OnboardingGitProvider,
    type OnboardingWorkCreator,
} from '@ever-works/agent/onboarding';
import type {
    ManifestValidationError,
    RegisterWorkErrorCode,
    RegisterWorkResponse,
} from '@ever-works/contracts/api';
import { RegisterWorkRequestDto } from './dto/register-work.dto';

interface OnboardingContext {
    body: RegisterWorkRequestDto;
    githubToken: string;
    idempotencyKey?: string;
}

interface TypedOnboardingError {
    code: RegisterWorkErrorCode;
    message: string;
    errors?: ManifestValidationError[];
}

interface ParsedRepoCoords {
    owner: string;
    repo: string;
    canonicalUrl: string;
}

const MANIFEST_PATHS = ['works.yml', 'works.yaml'];

@Injectable()
export class OnboardingService {
    private readonly logger = new Logger(OnboardingService.name);

    constructor(
        @InjectRepository(OnboardingRequest)
        private readonly onboardingRepo: Repository<OnboardingRequest>,
        private readonly manifestService: WorksManifestService,
        @Inject(ONBOARDING_GIT_PROVIDER)
        private readonly gitFacade: OnboardingGitProvider,
        private readonly onboardingRowRepo: OnboardingRequestRepository,
        @Inject(ONBOARDING_ACCOUNT_UPSERT)
        private readonly accountUpsert: OnboardingAccountUpsert,
        @Inject(ONBOARDING_WORK_CREATOR)
        private readonly workCreator: OnboardingWorkCreator,
    ) {}

    /**
     * Top-level entry point for `POST /api/register-work`.
     *
     * Stages implemented in this slice:
     *   1. Canonicalise the repo URL.
     *   2. Resolve GitHub identity from the supplied token via GitFacade.getUser().
     *   3. Validate repo write access via GitFacade.getRepository().
     *   4. Idempotency lookup on (githubIdentityHash, repoUrlCanonical) — return early
     *      if a row already exists for the same owner.
     *   5. Conflict check — return 409 if another identity owns the repo.
     *   6. Fetch and validate `works.yml` via GitFacade.getFileContent + WorksManifestService.
     *   7. Persist OnboardingRequest with status='validated'.
     *
     * Stages deferred to subsequent slices:
     *   - Better Auth account upsert linked to GitHub identity (T9b).
     *   - WorksService.createFromManifest call (T9c).
     *   - Trigger.dev work-onboarding.task enqueue (T19, picks up status='validated' rows).
     *   - Webhook + state-marker fan-out on terminal status (T10, T11, T21).
     */
    async handle(ctx: OnboardingContext): Promise<RegisterWorkResponse> {
        const coords = parseRepoCoords(ctx.body.repo);
        if (!coords) {
            this.fail({ code: 'validation_error', message: 'invalid repo URL' });
        }

        const { githubIdentityHash, ghLogin } = await this.resolveGitHubIdentity(ctx.githubToken);

        const existingForOwner = await this.onboardingRepo.findOne({
            where: { githubIdentityHash, repoUrlCanonical: coords.canonicalUrl },
        });
        if (existingForOwner) {
            return this.toResponse(existingForOwner);
        }

        const existingForOtherOwner = await this.onboardingRepo.findOne({
            where: { repoUrlCanonical: coords.canonicalUrl },
        });
        if (existingForOtherOwner) {
            this.fail({
                code: 'repo_already_owned',
                message: 'This repo is already onboarded by another GitHub identity',
            });
        }

        await this.assertRepoAccess(coords, ctx.githubToken);

        const manifestText = await this.fetchManifest(coords, ctx.githubToken);
        const parseResult = this.manifestService.parseAndValidate(manifestText);
        if (parseResult.kind === 'failure') {
            this.fail({
                code: parseResult.code,
                message:
                    parseResult.code === 'manifest_invalid_yaml'
                        ? 'works.yml could not be parsed'
                        : 'works.yml failed schema validation',
                errors: parseResult.errors,
            });
        }

        const subdomainHint =
            ctx.body.subdomain ??
            parseResult.manifest.metadata.subdomain ??
            parseResult.manifest.metadata.slug ??
            slugify(parseResult.manifest.metadata.name);

        const persisted = await this.onboardingRepo.save(
            this.onboardingRepo.create({
                githubIdentityHash,
                repoUrlCanonical: coords.canonicalUrl,
                contactEmail: ctx.body.email ?? null,
                agentId: ctx.body.agentId ?? ghLogin,
                webhookUrl: ctx.body.webhookUrl ?? null,
                subdomain: subdomainHint,
                idempotencyKey: ctx.idempotencyKey ?? null,
                status: 'validated',
            }),
        );

        this.logger.log(
            `onboarding.validated id=${persisted.id} repo=${coords.canonicalUrl} login=${ghLogin}`,
        );

        // T9b: account upsert. Best-effort — if it fails, the row stays in
        //      'validated' and a background reconciler can retry.
        try {
            const githubUserId = githubIdentityHash.slice(0, 40);
            const { accountId } = await this.accountUpsert.upsertFromGithub({
                githubUserId,
                login: ghLogin,
                email: ctx.body.email,
                accessToken: ctx.githubToken,
            });
            await this.onboardingRowRepo.setAccountId(persisted.id, accountId);
            persisted.accountId = accountId;

            // T9c: work creation. Hand the manifest off to the existing
            //      WorkLifecycleService. On success the row transitions to
            //      `queued` and the agent's status URL starts returning the
            //      real workId. On failure, mark the row failed with a typed
            //      code so the agent's status poll surfaces the error.
            try {
                const { workId } = await this.workCreator.createFromManifest({
                    accountId,
                    githubAccessToken: ctx.githubToken,
                    manifestRepoUrl: coords.canonicalUrl,
                    manifest: parseResult.manifest as unknown as Record<string, unknown>,
                    subdomain: subdomainHint,
                    onboardingId: persisted.id,
                });
                await this.onboardingRowRepo.setWorkId(persisted.id, workId);
                await this.onboardingRowRepo.tryTransition(persisted.id, 'validated', 'queued', { workId });
                persisted.workId = workId;
                persisted.status = 'queued';
            } catch (workErr) {
                this.logger.warn(
                    `onboarding.work_creation_failed id=${persisted.id} reason=${describeError(workErr)}`,
                );
                await this.onboardingRowRepo.markFailure(
                    persisted.id,
                    'work_creation_failed',
                    { message: describeError(workErr) },
                );
                persisted.status = 'failed';
                persisted.failureCode = 'work_creation_failed';
            }
        } catch (acctErr) {
            // Account upsert failure shouldn't reject the request — the row
            // stays 'validated' for a reconciler. Log but proceed.
            this.logger.warn(
                `onboarding.account_upsert_failed id=${persisted.id} reason=${describeError(acctErr)}`,
            );
        }

        return this.toResponse(persisted);
    }

    async getStatus(id: string, proofToken: string | undefined): Promise<RegisterWorkResponse> {
        if (!proofToken) {
            throw new ForbiddenException({
                statusCode: 403,
                code: 'gh_credential_invalid',
                message: 'X-GitHub-Token header is required',
            });
        }
        const row = await this.onboardingRepo.findOne({ where: { id } });
        if (!row) {
            throw new NotFoundException({
                statusCode: 404,
                code: 'not_found',
                message: 'unknown onboarding id',
            });
        }

        const { githubIdentityHash } = await this.resolveGitHubIdentity(proofToken);
        if (githubIdentityHash !== row.githubIdentityHash) {
            throw new ForbiddenException({
                statusCode: 403,
                code: 'gh_repo_access_denied',
                message: 'token does not match onboarding owner',
            });
        }

        return this.toResponse(row);
    }

    /**
     * Resolves the GitHub identity from a raw token by calling GitFacade.getUser
     * with token-based auth. Returns a deterministic SHA-256 hash of the numeric
     * GitHub user id, plus the login for logging / agentId fallback.
     */
    private async resolveGitHubIdentity(
        token: string,
    ): Promise<{ githubIdentityHash: string; ghLogin: string }> {
        if (!token || token.length < 4) {
            throw new UnauthorizedException({
                statusCode: 401,
                code: 'gh_credential_invalid',
                message: 'GitHub credential is missing or malformed',
            });
        }

        try {
            const user = await this.gitFacade.getUser({ providerId: 'github', token });
            const id = String(user.id);
            return {
                githubIdentityHash: createHash('sha256').update(`github:${id}`).digest('hex'),
                ghLogin: user.login || `gh-${id}`,
            };
        } catch (err) {
            this.logger.warn(`onboarding.token_rejected reason=${describeError(err)}`);
            throw new ForbiddenException({
                statusCode: 403,
                code: 'gh_credential_invalid',
                message: 'GitHub credential could not be resolved',
            });
        }
    }

    private async assertRepoAccess(coords: ParsedRepoCoords, token: string): Promise<void> {
        try {
            const repo = await this.gitFacade.getRepository(coords.owner, coords.repo, {
                providerId: 'github',
                token,
            });
            if (!repo) {
                this.fail({
                    code: 'gh_repo_access_denied',
                    message: 'token cannot read the named repository',
                });
            }
            const permissions = (repo as { permissions?: { push?: boolean; admin?: boolean } })
                .permissions;
            const hasWrite = !!(permissions?.push || permissions?.admin);
            if (!hasWrite) {
                this.fail({
                    code: 'gh_repo_access_denied',
                    message: 'token lacks write access to the repository',
                });
            }
        } catch (err) {
            if (err instanceof HttpException) throw err;
            this.logger.warn(`onboarding.repo_access_failed reason=${describeError(err)}`);
            this.fail({
                code: 'gh_repo_access_denied',
                message: 'failed to verify repository access',
            });
        }
    }

    private async fetchManifest(coords: ParsedRepoCoords, token: string): Promise<string> {
        for (const path of MANIFEST_PATHS) {
            try {
                const file = await this.gitFacade.getFileContent(
                    coords.owner,
                    coords.repo,
                    path,
                    { providerId: 'github', token },
                );
                if (file) {
                    return decodeFileContent(file.content, file.encoding);
                }
            } catch (err) {
                this.logger.warn(
                    `onboarding.manifest_fetch_failed path=${path} reason=${describeError(err)}`,
                );
            }
        }

        this.fail({
            code: 'manifest_missing',
            message: 'works.yml not found at repository root',
        });
    }

    private toResponse(row: OnboardingRequest): RegisterWorkResponse {
        return {
            onboardingId: row.id,
            workId: row.workId ?? row.id,
            status: row.status as OnboardingStatus,
            statusUrl: `/api/register-work/${row.id}`,
            subdomain: row.subdomain
                ? `${row.subdomain}.ever.works`
                : `${row.id.slice(0, 8)}.ever.works`,
        };
    }

    private fail(err: TypedOnboardingError): never {
        const body = { statusCode: errorStatus(err.code), ...err };
        switch (err.code) {
            case 'validation_error':
                throw new BadRequestException(body);
            case 'manifest_missing':
            case 'manifest_invalid':
            case 'unsupported_capability':
            case 'gh_insufficient_scope_for_repo_creation':
                throw new UnprocessableEntityException(body);
            case 'gh_repo_access_denied':
            case 'gh_credential_invalid':
                throw new ForbiddenException(body);
            case 'repo_already_owned':
            case 'subdomain_taken':
                throw new ConflictException(body);
            default:
                throw new BadRequestException(body);
        }
    }
}

export function canonicaliseRepoUrl(input: string): string | null {
    const coords = parseRepoCoords(input);
    return coords ? coords.canonicalUrl : null;
}

export function parseRepoCoords(input: string): ParsedRepoCoords | null {
    try {
        const url = new URL(input);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        if (url.hostname.toLowerCase() !== 'github.com') return null;
        const segments = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
        if (segments.length < 2) return null;
        const owner = segments[0].toLowerCase();
        const repo = segments[1].toLowerCase();
        return {
            owner,
            repo,
            canonicalUrl: `https://github.com/${owner}/${repo}`,
        };
    } catch {
        return null;
    }
}

function slugify(name: string): string {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63) || 'work';
}

function decodeFileContent(content: string, encoding: string): string {
    if (encoding === 'base64') {
        return Buffer.from(content, 'base64').toString('utf-8');
    }
    return content;
}

function describeError(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

function errorStatus(code: RegisterWorkErrorCode): number {
    switch (code) {
        case 'validation_error':
            return 400;
        case 'gh_repo_access_denied':
        case 'gh_credential_invalid':
            return 403;
        case 'repo_already_owned':
        case 'subdomain_taken':
            return 409;
        case 'manifest_missing':
        case 'manifest_invalid':
        case 'unsupported_capability':
        case 'gh_insufficient_scope_for_repo_creation':
            return 422;
        case 'rate_limited':
            return 429;
        default:
            return 400;
    }
}

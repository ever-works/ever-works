import { Type, Transform } from 'class-transformer';
import {
    IsBoolean,
    IsDefined,
    IsIn,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    ValidateIf,
    ValidateNested,
    Matches,
    MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { APP_REPOSITORY_MODES, type AppRepositoryMode } from '@ever-works/contracts';
import {
    MarkdownReadmeConfig,
    normalizeCreateWorkKind,
    USER_SELECTABLE_WORK_KINDS,
} from '../entities/work.entity';
import { sanitizeName, sanitizeDescription, sanitizeText } from '../utils/sanitize.util';

export class MarkdownReadmeConfigDto implements MarkdownReadmeConfig {
    @ApiPropertyOptional({ description: 'Custom header content for the README' })
    @IsOptional()
    @IsString()
    @Transform(({ value }) =>
        typeof value === 'string'
            ? sanitizeText(value, { removeNewlines: false, collapseSpaces: false, trim: true })
            : value,
    )
    header?: string;

    @ApiPropertyOptional({
        description: 'Whether to replace the default header entirely',
        default: false,
    })
    @IsOptional()
    @IsBoolean()
    overwriteDefaultHeader?: boolean;

    @ApiPropertyOptional({ description: 'Custom footer content for the README' })
    @IsOptional()
    @IsString()
    @Transform(({ value }) =>
        typeof value === 'string'
            ? sanitizeText(value, { removeNewlines: false, collapseSpaces: false, trim: true })
            : value,
    )
    footer?: string;

    @ApiPropertyOptional({
        description: 'Whether to replace the default footer entirely',
        default: false,
    })
    @IsOptional()
    @IsBoolean()
    overwriteDefaultFooter?: boolean;
}

export class CreateWorkDto {
    @ApiProperty({
        description: 'URL-friendly identifier (lowercase letters, numbers, hyphens only)',
        example: 'my-awesome-work',
    })
    @IsString()
    @IsNotEmpty()
    @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
        message: 'Slug can only contain lowercase letters, numbers, and hyphens',
    })
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    slug: string;

    @ApiProperty({
        description: 'Display name for the work',
        example: 'My Awesome Work',
        maxLength: 100,
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeName(value, 100) : value))
    name: string;

    @ApiProperty({
        description: 'Brief description of the work',
        example: 'A curated list of awesome tools and resources',
        maxLength: 500,
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(500)
    @Transform(({ value }) => (typeof value === 'string' ? sanitizeDescription(value, 500) : value))
    description: string;

    @ApiPropertyOptional({
        description: 'Username or organization for repository ownership',
    })
    @IsOptional()
    @IsString()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    owner?: string;

    @ApiProperty({ description: 'Whether the owner is an organization', example: false })
    @IsBoolean()
    organization: boolean;

    @ApiPropertyOptional({
        description: 'Git provider plugin ID (e.g., github, gitlab)',
        default: 'github',
    })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    gitProvider: string = 'github';

    @ApiPropertyOptional({
        description:
            "Deploy provider for this work. One of 'ever-works' (default for users who picked Ever Works in onboarding), 'vercel', 'k8s'. " +
            'When omitted the server seeds from the user’s onboarding choice; failing that, falls back to the historical default of vercel.',
        example: 'ever-works',
    })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    deployProvider?: string;

    @ApiPropertyOptional({
        description:
            "Storage provider. One of 'ever-works-git' (push to the managed Ever Works GitHub org), 'user-github', 'user-gitlab' (planned), 'user-git' (planned). " +
            'Server seeds from the user’s onboarding choice when omitted; defaults to user-github.',
        example: 'ever-works-git',
    })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    storageProvider?: string;

    @ApiPropertyOptional({
        description: 'Website template identifier to use for website repository initialization',
        default: 'classic',
    })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
    websiteTemplateId?: string;

    @ApiPropertyOptional({
        description:
            'Work kind the user picked at creation (website, landing-page, blog, directory, awesome-repo, repo, ' +
            'app). Drives the kind-aware default website template. Unknown values are coerced to "default"; ' +
            'omitted keeps the column default. `repo` registers an existing code repository (see `repositoryUrl`) ' +
            'and never provisions a website template, a provider repository or a deployment. `app` turns any ' +
            'GitHub repository into a runnable App Work: it needs `repositoryUrl` and `repositoryMode`, and ' +
            '`repositoryMode: "fork"` or `"private-copy"` also needs `targetOwner`.',
        enum: [...USER_SELECTABLE_WORK_KINDS, 'default'],
    })
    @IsOptional()
    @IsString()
    // Whitelist at the boundary: the transform coerces any unknown/alias
    // input to a canonical member, so arbitrary strings can never reach
    // the `work.kind` column. `@IsIn` documents + guards the closed set.
    @IsIn([...USER_SELECTABLE_WORK_KINDS, 'default'])
    @Transform(({ value }) => normalizeCreateWorkKind(value))
    kind?: string;

    @ApiPropertyOptional({
        description:
            'Repository Work (`kind: "repo"`) or App Work (`kind: "app"`) — the existing code repository this ' +
            'Work wraps, e.g. `https://github.com/ever-works/ever-works`. Becomes the data repository of the ' +
            'Work verbatim, so Tasks, Goals and fleet runs attach to it. Required when `kind` is `repo`; ' +
            'ignored otherwise. ' +
            'For `app` it is the UPSTREAM this Work links, forks or privately copies — required there too, with ' +
            'the mode in `repositoryMode` and, for fork/private-copy, the account in `targetOwner`.',
        example: 'https://github.com/ever-works/ever-works',
        maxLength: 400,
    })
    @IsOptional()
    @IsString()
    @MaxLength(400)
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    repositoryUrl?: string;

    @ApiPropertyOptional({
        description:
            'App Work only (`kind: "app"`) — how the upstream repository in `repositoryUrl` becomes this Work’s ' +
            'Work Repository: "link" keeps it where it is, "fork" forks it into `targetOwner`, "private-copy" ' +
            'creates a private copy there. Required for `kind: "app"`: the validation pipe answers ' +
            '`400 repositoryMode must be defined` before the handler runs.',
        enum: [...APP_REPOSITORY_MODES],
        example: 'fork',
    })
    // No `@IsOptional()` here, or on `targetOwner` below — deliberately, and it
    // is not an oversight: `@IsOptional()` IS a `@ValidateIf`, class-validator
    // ANDs every CONDITIONAL_VALIDATION on a property, and a `false` result
    // returns from `performValidations` BEFORE the IS_DEFINED metadata is
    // consulted. With `@IsOptional()` in the stack a missing value short-
    // circuits the property, so `@IsDefined()` could never fire and the pipe
    // could never answer `repositoryMode must be defined`. The predicate below
    // carries the same intent — false for every kind except `app` (the property
    // is skipped, so the field stays optional), true for `app` (the field is
    // required and shape-checked).
    @ValidateIf((o) => normalizeCreateWorkKind(o.kind) === 'app')
    @IsDefined({ message: 'repositoryMode must be defined' })
    @IsIn([...APP_REPOSITORY_MODES])
    repositoryMode?: AppRepositoryMode;

    @ApiPropertyOptional({
        description:
            'App Work only (`kind: "app"`) — the GitHub account (user or organization) the fork or the private ' +
            'copy is created in. Required for `repositoryMode: "fork"` and `"private-copy"`; ignored for ' +
            '"link".',
        example: 'my-org',
        maxLength: 100,
    })
    @ValidateIf(
        (o) =>
            normalizeCreateWorkKind(o.kind) === 'app' &&
            (o.repositoryMode === 'fork' || o.repositoryMode === 'private-copy'),
    )
    @IsDefined({ message: 'targetOwner must be defined' })
    @IsString()
    @MaxLength(100)
    @Matches(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/)
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    targetOwner?: string;

    @ApiPropertyOptional({
        description:
            'App Work only (`kind: "app"`) — the Apps catalog Blueprint the member previewed. Optional; when ' +
            'present it must be the id the resolver returns for this upstream, otherwise the create is refused ' +
            'with `400 blueprint_mismatch` — a member never gets a Blueprint they did not see.',
        example: 'cal-diy',
        maxLength: 100,
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    @Matches(/^[a-z0-9][a-z0-9-]{0,99}$/)
    @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
    blueprintId?: string;

    @ApiPropertyOptional({
        description:
            'App Work only (`kind: "app"`) — `false` is the member’s decline of FR-29a’s automatic start ' +
            '(spec §6.2’s "Let an agent work out how to run it"): the Work is created without provisioning and ' +
            'offers Provision instead. Absent means on; ignored for every other kind.',
        default: true,
    })
    @IsOptional()
    @IsBoolean()
    autoProvision?: boolean;

    @ApiPropertyOptional({
        description:
            'App Work only (`kind: "app"`) — write-only answers to the App Blueprint prompts shown on the ' +
            'preview (spec FR-55, plan §7). Carried on the create request and handed to the App env store ' +
            'once the App spec exists; never echoed by any read response and never logged.',
        type: 'object',
        additionalProperties: { type: 'string' },
        example: { admin_email: 'ops@example.com' },
    })
    @IsOptional()
    @IsObject()
    appEnv?: Record<string, string>;

    @ApiPropertyOptional({
        description: 'Custom README configuration',
        type: MarkdownReadmeConfigDto,
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => MarkdownReadmeConfigDto)
    readmeConfig?: MarkdownReadmeConfigDto;

    @ApiPropertyOptional({
        description:
            'Zero-friction funnel correlation id. Minted on the landing form and threaded through the full funnel so REPOS_PUSHED / DEPLOY_STARTED emits stay joinable with the upstream WORK_CREATED event.',
    })
    @IsOptional()
    @IsString()
    correlationId?: string;
}

// This declaration file re-exports only types from API files
// Client components can safely import from this file

export type {
    // From auth.ts
    RegisterDto,
    LoginDto,
    UpdatePasswordDto,
    UpdateProfileDto,
    VerifyEmailDto,
    ForgotPasswordDto,
    ResetPasswordDto,
    AuthResponse,
    OAuthUrlResponse,
    TokenValidationResponse,
} from './auth';

export type {
    // From work.ts
    MarkdownReadmeConfig,
    WebsiteTemplateOption,
    CreateWorkDto,
    UpdateWorkDto,
    DeleteWorkDto,
    GenerateWorkDetailDto,
    GenerateStatus,
    Work,
    WorksResponse,
    DeleteWorkResponse,
    WorkDetails,
    WorkConfig,
    PRUpdate,
    GenerationMetrics,
    GenerationStepLog,
    WorkGenerationHistoryEntry,
    WorkGenerationHistoryResponse,
    WorkScheduleDto,
    WorkScheduleAllowedCadence,
    UpdateReadmeResponse,
    SyncWorkResponse,
    ImportSourceType,
    RepositoryTarget,
    RelatedRepositories,
    WorksConfigSnapshot,
    SourceRepository,
    RepoVisibility,
    ImportEnrichmentConfig,
    AnalyzeRepositoryResponseDto,
    ImportWorkDto,
    AnalyzeForLinkingResponseDto,
    RepositoryStatus,
    RepositoryType,
    SourceValidationSettingsDto,
    // GenerateStatus now has dynamic step support
} from './work';

export type {
    // From items-generator.ts
    ProvidersDto,
    CreateItemsGeneratorDto,
    UpdateItemsGeneratorDto,
    SubmitItemDto,
    RemoveItemDto,
    UpdateItemDto,
    CheckItemHealthDto,
    CheckItemHealthResponseDto,
    ExtractItemDetailsDto,
    ItemsGeneratorResponse,
    ExtractItemDetailsResponse,
    RegenerateMarkdownResponse,
    // Generator form schema types (re-exported from @ever-works/plugin)
    PluginIcon,
    ProviderOption,
    ProviderModelSummary,
    FormFieldDefinition,
    FormFieldGroup,
    GeneratorFormSchema,
    FormSchemaProvidersType,
    ProviderCategoryKey,
    ProviderSelectionState,
    SelectableProviderCategory,
} from './items-generator';

export type {
    // From website.ts
    UpdateWebsiteRepositoryResponse,
} from './website';

export type {
    // From settings.ts
    NotificationPreferencesDto,
    NotificationPreferencesResponse,
} from './settings';

export type {
    // From types.ts
    MessageResponse,
    Category,
    Badge,
    ItemBadges,
    BadgeEvaluationResult,
    Tag,
    Brand,
    ItemData,
    Collection,
    ItemSourceReachabilityStatus,
    ItemSourceAccuracyStatus,
} from './types';

export type {
    // From git-providers.ts (API response types)
    GitProviderInfo,
    GitProviderConnectionInfo,
} from './plugins-capabilities/git-providers';

// Re-export plugin types for client components
export type { GitUser, GitOrganization, GitRepositoryWithPermissions } from '@ever-works/plugin';

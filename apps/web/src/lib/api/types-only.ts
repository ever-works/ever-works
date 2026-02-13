// This declaration file re-exports only types from API files
// Client components can safely import from this file

export type {
    // From auth.ts
    RegisterDto,
    LoginDto,
    RefreshTokenDto,
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
    // From directory.ts
    MarkdownReadmeConfig,
    CreateDirectoryDto,
    UpdateDirectoryDto,
    DeleteDirectoryDto,
    GenerateDirectoryDetailDto,
    GenerateStatus,
    Directory,
    DirectoriesResponse,
    DeleteDirectoryResponse,
    DirectoryDetails,
    DirectoryConfig,
    PRUpdate,
    GenerationMetrics,
    DirectoryGenerationHistoryEntry,
    DirectoryGenerationHistoryResponse,
    DirectoryScheduleDto,
    DirectoryScheduleAllowedCadence,
    UpdateReadmeResponse,
    SyncDirectoryResponse,
    RepositoryStatus,
    RepositoryType,
    // GenerateStatus now has dynamic step support
} from './directory';

export type {
    // From items-generator.ts
    ProvidersDto,
    CreateItemsGeneratorDto,
    UpdateItemsGeneratorDto,
    SubmitItemDto,
    RemoveItemDto,
    UpdateItemDto,
    ExtractItemDetailsDto,
    ItemsGeneratorResponse,
    ExtractItemDetailsResponse,
    RegenerateMarkdownResponse,
    // Generator form schema types (re-exported from @ever-works/plugin)
    PluginIcon,
    ProviderOption,
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
    // From ai-conversation.ts
    ChatMessage as ConversationMessage,
    ChatMessageRole,
    ChatStreamRequestDto,
    StreamChunk,
} from './ai-conversation';

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
} from './types';

export type {
    // From git-providers.ts (API response types)
    GitProviderInfo,
    GitProviderConnectionInfo,
} from './plugins-capabilities/git-providers';

// Re-export plugin types for client components
export type { GitUser, GitOrganization, GitRepositoryWithPermissions } from '@ever-works/plugin';

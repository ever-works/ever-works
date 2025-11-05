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
    ConnectionInfo,
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
    DirectoryGenerationHistoryEntry,
    DirectoryGenerationHistoryResponse,
} from './directory';

export type {
    // From items-generator.ts
    CompanyDto,
    ConfigDto,
    CreateItemsGeneratorDto,
    UpdateItemsGeneratorDto,
    SubmitItemDto,
    RemoveItemDto,
    ExtractItemDetailsDto,
    ItemsGeneratorResponse,
    ExtractItemDetailsResponse,
    RegenerateMarkdownResponse,
} from './items-generator';

export type {
    // From website.ts
    UpdateWebsiteRepositoryResponse,
} from './website';

export type {
    // From settings.ts
    UpdateVercelTokenDto,
    NotificationPreferencesDto,
    VercelTokenStatus,
    NotificationPreferencesResponse,
} from './settings';

export type {
    // From ai-conversation.ts
    StartConversationDto,
    SendMessageDto,
    ConversationStartResponse,
    ConversationHistoryResponse,
    ConversationSummary,
    ConversationMessage,
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
    ItemData,
} from './types';

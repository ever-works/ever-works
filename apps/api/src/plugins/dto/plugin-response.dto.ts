import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
    PluginCategory,
    PluginState,
    ConfigurationMode,
    PluginIconType,
    PluginIcon,
    PluginAuthor,
    PluginSettingsSchemaProperty,
    PluginSettingsSchema,
    PluginResponse,
    UserPluginResponse,
    DirectoryPluginResponse,
    PluginListResponse,
    DirectoryPluginListResponse,
    SettingScopeApi,
    PluginVisibility,
} from '@ever-works/plugin/api';

// Re-export types for convenience
export type {
    PluginCategory,
    PluginState,
    ConfigurationMode,
    PluginIconType,
    PluginVisibility,
} from '@ever-works/plugin/api';

/**
 * Plugin icon representation for UI display
 */
export class PluginIconDto implements PluginIcon {
    @ApiProperty({ description: 'Icon type', enum: ['svg', 'url', 'base64', 'lucide', 'emoji'] })
    type: PluginIconType;

    @ApiProperty({ description: 'Icon value based on type' })
    value: string;

    @ApiPropertyOptional({ description: 'Dark mode variant value' })
    darkValue?: string;

    @ApiPropertyOptional({ description: 'Background color' })
    backgroundColor?: string;

    @ApiPropertyOptional({ description: 'Foreground/stroke color' })
    color?: string;
}

/**
 * Plugin author information
 */
export class PluginAuthorDto implements PluginAuthor {
    @ApiProperty({ description: 'Author name' })
    name: string;

    @ApiPropertyOptional({ description: 'Author email' })
    email?: string;

    @ApiPropertyOptional({ description: 'Author URL' })
    url?: string;
}

/**
 * Plugin settings schema property
 */
export class PluginSettingsSchemaPropertyDto implements PluginSettingsSchemaProperty {
    @ApiProperty({ description: 'Property type' })
    type: string;

    @ApiPropertyOptional({ description: 'Property title' })
    title?: string;

    @ApiPropertyOptional({ description: 'Property description' })
    description?: string;

    @ApiPropertyOptional({ description: 'Default value' })
    default?: unknown;

    @ApiPropertyOptional({
        description: 'Is this a secret field (never returned in API responses)',
    })
    secret?: boolean;

    @ApiPropertyOptional({ description: 'Is this field admin-only' })
    adminOnly?: boolean;

    @ApiPropertyOptional({ description: 'Environment variable name (env-only field)' })
    envVar?: string;

    @ApiPropertyOptional({
        description: 'Setting scope: global, user, or directory',
        enum: ['global', 'user', 'directory'],
        default: 'global',
    })
    scope?: SettingScopeApi;

    @ApiPropertyOptional({ description: 'Enum values', type: [String] })
    enum?: readonly unknown[];

    @ApiPropertyOptional({ description: 'UI widget type hint (e.g., model-select)' })
    widget?: string;

    @ApiPropertyOptional({ description: 'Whether field should be hidden from settings UI' })
    hidden?: boolean;
}

/**
 * Plugin settings schema
 */
export class PluginSettingsSchemaDto implements PluginSettingsSchema {
    @ApiProperty({ description: 'Schema type', default: 'object' })
    type: 'object';

    @ApiPropertyOptional({ description: 'Schema title' })
    title?: string;

    @ApiPropertyOptional({ description: 'Schema description' })
    description?: string;

    @ApiProperty({ description: 'Schema properties' })
    properties: Record<string, PluginSettingsSchemaPropertyDto>;

    @ApiPropertyOptional({ description: 'Required fields', type: [String] })
    required?: string[];
}

/**
 * Response DTO for a single plugin
 */
export class PluginResponseDto implements PluginResponse {
    @ApiProperty({ description: 'Plugin entity ID (database)' })
    id: string;

    @ApiProperty({ description: 'Plugin unique identifier' })
    pluginId: string;

    @ApiProperty({ description: 'Plugin display name' })
    name: string;

    @ApiProperty({ description: 'Plugin version' })
    version: string;

    @ApiPropertyOptional({ description: 'Plugin description' })
    description?: string;

    @ApiPropertyOptional({ description: 'Plugin readme in markdown format' })
    readme?: string;

    @ApiProperty({ description: 'Plugin category' })
    category: PluginCategory;

    @ApiProperty({ description: 'Plugin capabilities', type: [String] })
    capabilities: string[];

    @ApiProperty({ description: 'Configuration mode' })
    configurationMode: ConfigurationMode;

    @ApiProperty({ description: 'Whether plugin is built-in' })
    builtIn: boolean;

    @ApiProperty({ description: 'Whether this is a system plugin that cannot be disabled' })
    systemPlugin: boolean;

    @ApiProperty({
        description: 'UI visibility',
        enum: ['public', 'hidden', 'user-only'],
        default: 'public',
    })
    visibility: PluginVisibility;

    @ApiProperty({ description: 'Plugin state' })
    state: PluginState;

    @ApiPropertyOptional({ description: 'Plugin icon' })
    icon?: PluginIconDto;

    @ApiPropertyOptional({ description: 'Settings schema for configuration' })
    settingsSchema?: PluginSettingsSchemaDto;

    @ApiPropertyOptional({ description: 'Plugin author' })
    author?: PluginAuthorDto;

    @ApiPropertyOptional({ description: 'Plugin homepage URL' })
    homepage?: string;

    @ApiPropertyOptional({ description: 'Whether plugin is auto-enabled' })
    autoEnable?: boolean;
}

/**
 * Response DTO for a plugin with user-specific settings
 */
export class UserPluginResponseDto extends PluginResponseDto implements UserPluginResponse {
    @ApiProperty({ description: 'Whether user has installed this plugin' })
    installed: boolean;

    @ApiProperty({ description: 'Whether user has enabled this plugin' })
    enabled: boolean;

    @ApiPropertyOptional({ description: 'User-specific settings (masked)' })
    settings?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'User plugin entity ID' })
    userPluginId?: string;
}

/**
 * Response DTO for a plugin in directory context
 */
export class DirectoryPluginResponseDto
    extends UserPluginResponseDto
    implements DirectoryPluginResponse
{
    @ApiProperty({ description: 'Whether plugin is enabled for this directory' })
    directoryEnabled: boolean;

    @ApiPropertyOptional({ description: 'Active capability for this directory' })
    activeCapability?: string;

    @ApiPropertyOptional({ description: 'Directory-specific settings (masked)' })
    directorySettings?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Directory plugin entity ID' })
    directoryPluginId?: string;

    @ApiPropertyOptional({ description: 'Priority order for this plugin' })
    priority?: number;
}

/**
 * Response for plugin list
 */
export class PluginListResponseDto implements PluginListResponse {
    @ApiProperty({ description: 'List of plugins', type: [UserPluginResponseDto] })
    plugins: UserPluginResponseDto[];

    @ApiProperty({ description: 'Total count of plugins' })
    total: number;

    @ApiPropertyOptional({ description: 'Available categories', type: [String] })
    categories?: PluginCategory[];

    @ApiPropertyOptional({ description: 'Available capabilities', type: [String] })
    capabilities?: string[];
}

/**
 * Response for directory plugin list
 */
export class DirectoryPluginListResponseDto implements DirectoryPluginListResponse {
    @ApiProperty({ description: 'List of plugins', type: [DirectoryPluginResponseDto] })
    plugins: DirectoryPluginResponseDto[];

    @ApiProperty({ description: 'Total count of plugins' })
    total: number;

    @ApiPropertyOptional({ description: 'Capability providers mapping' })
    capabilityProviders?: Record<string, string>;
}

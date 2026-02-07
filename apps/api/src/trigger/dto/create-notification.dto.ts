import { IsString, IsEnum, IsOptional, IsBoolean, IsDateString, IsObject } from 'class-validator';
import { NotificationType, NotificationCategory } from '@ever-works/agent/entities';

export class CreateNotificationDto {
    @IsString()
    userId: string;

    @IsEnum(NotificationType)
    type: NotificationType;

    @IsEnum(NotificationCategory)
    category: NotificationCategory;

    @IsString()
    title: string;

    @IsString()
    message: string;

    @IsOptional()
    @IsString()
    actionUrl?: string;

    @IsOptional()
    @IsString()
    actionLabel?: string;

    @IsOptional()
    @IsObject()
    metadata?: Record<string, any>;

    @IsOptional()
    @IsBoolean()
    isPersistent?: boolean;

    @IsOptional()
    @IsDateString()
    expiresAt?: string;

    @IsOptional()
    @IsString()
    deduplicationKey?: string;
}

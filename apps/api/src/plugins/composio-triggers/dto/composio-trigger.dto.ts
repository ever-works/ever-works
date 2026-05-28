import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, IsNotEmpty } from 'class-validator';

export class CreateComposioTriggerDto {
    @ApiProperty({ description: 'Composio toolkit slug (e.g. GMAIL).' })
    @IsString()
    @IsNotEmpty()
    toolkitSlug!: string;

    @ApiProperty({ description: 'Composio trigger slug (e.g. GMAIL_NEW_EMAIL).' })
    @IsString()
    @IsNotEmpty()
    triggerSlug!: string;

    @ApiProperty({ description: 'Composio connected-account id (`ca_*`) the trigger binds to.' })
    @IsString()
    @IsNotEmpty()
    composioConnectedAccountId!: string;

    @ApiPropertyOptional({
        description: 'Per-trigger config (filters, polling cadence) — passed through to Composio.',
    })
    @IsOptional()
    @IsObject()
    config?: Record<string, unknown>;
}

export class ComposioTriggerDto {
    @ApiProperty() id!: string;
    @ApiProperty() toolkitSlug!: string;
    @ApiProperty() triggerSlug!: string;
    @ApiProperty() composioTriggerId!: string;
    @ApiProperty() composioConnectedAccountId!: string;
    @ApiProperty() enabled!: boolean;
    @ApiProperty() deliveriesReceived!: number;
    @ApiProperty() deliveriesRejected!: number;
    @ApiPropertyOptional({ type: String }) lastFiredAt?: string | null;
    @ApiProperty() createdAt!: string;

    /** Only returned on initial creation. Never re-fetched. */
    @ApiPropertyOptional() webhookSecret?: string;
}

export class ComposioTriggerListDto {
    @ApiProperty({ type: [ComposioTriggerDto] })
    items!: ComposioTriggerDto[];
}

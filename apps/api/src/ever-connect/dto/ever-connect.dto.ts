import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsString, MaxLength } from 'class-validator';

/** Body of `POST /api/ever-connect/connect`. */
export class EverConnectConnectDto {
    @ApiProperty({
        description: 'The connect code from app.ever.co (`EVC-XXXX-XXXX-XXXX`).',
        example: 'EVC-7K2M-9QXR-4HTB',
    })
    @IsString()
    @MaxLength(32)
    code!: string;
}

/** Body of `POST /api/ever-connect/integrations/:key/accept`. */
export class EverConnectAcceptDto {
    @ApiProperty({ description: 'Accept (`true`) or decline (`false`) the integration.' })
    @IsBoolean()
    accepted!: boolean;
}

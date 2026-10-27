import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Equals, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * `POST /api/account-deletion/request` — the shared contract body (the Gauzy
 * shape). Only `email` is used; the branding fields are accepted so the
 * ever.co fan-out can send one body to every platform, and are ignored here
 * (Ever Works brands its own email). Deliberately loose: a malformed address
 * still gets the same `202` as every other request.
 */
export class RequestAccountDeletionDto {
    @ApiProperty({ example: 'jane@example.com' })
    @IsString()
    @MaxLength(320)
    email: string;

    @ApiPropertyOptional({
        description:
            'Confirm page the emailed link should open. Used only when its host is one this deployment serves (ALLOWED_CALLBACK_HOSTS / WEB_URL); otherwise the platform page is used. The token is appended in the URL fragment.',
        example: 'https://app.ever.works/delete-account/confirm',
    })
    @IsOptional()
    @IsString()
    @MaxLength(2048)
    callbackUrl?: string;

    @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(16) locale?: string;
    @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) appName?: string;
    @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2048) appLogo?: string;
    @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2048) appSignature?: string;
    @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2048) appLink?: string;
    @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2048) companyLink?: string;
    @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) companyName?: string;
}

/** `POST /api/account-deletion/verify` — inspect a link without using it. */
export class VerifyAccountDeletionDto {
    @ApiProperty({ description: 'The token from the link fragment.' })
    @IsString()
    @MaxLength(256)
    token: string;
}

/** `POST /api/account-deletion/confirm` — use the link and delete. */
export class ConfirmAccountDeletionDto {
    @ApiProperty({ description: 'The token from the link fragment.' })
    @IsString()
    @MaxLength(256)
    token: string;

    @ApiProperty({ description: 'Must be `true`: deletion runs only on an explicit confirm.' })
    @IsBoolean()
    @Equals(true)
    confirm: boolean;
}

/** `POST /api/account-deletion/me` — the signed-in delete. */
export class DeleteMyAccountDto {
    @ApiProperty({ description: 'The account email, typed by the user as the confirmation.' })
    @IsString()
    @MaxLength(320)
    confirmEmail: string;
}

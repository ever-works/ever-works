import {
    ArrayNotEmpty,
    IsArray,
    IsEmail,
    IsNotEmpty,
    IsString,
    MaxLength,
    MinLength,
    Matches,
    IsOptional,
    IsUUID,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One legal document the signup form says it displayed next to the terms
 * checkbox.
 *
 * These values arrive from a browser, so they are a *claim*, not evidence. The
 * checks here only reject obvious rubbish; what makes a claim true is
 * `TermsAcceptanceService`, which re-checks every field against the published
 * `@ever-co/legal` corpus before a row is written. A digest the corpus never
 * published is refused — recording it would produce evidence pointing at
 * nothing.
 */
export class TermsAcceptanceClaimDto {
    @ApiProperty({ description: 'Stable document id', example: 'tos:ever-works' })
    @IsNotEmpty()
    @IsString()
    @MaxLength(255)
    documentId: string;

    @ApiProperty({ description: 'Published document version', example: '1.0.0' })
    @IsNotEmpty()
    @IsString()
    @MaxLength(64)
    version: string;

    @ApiProperty({ description: 'Lowercase hex sha256 of the document source' })
    @Matches(/^[0-9a-f]{64}$/, {
        message: 'sha256 must be a 64-character lowercase hex digest',
    })
    sha256: string;

    @ApiProperty({ description: 'BCP-47 locale of the text that was shown', example: 'en' })
    @IsNotEmpty()
    @IsString()
    @MaxLength(35)
    locale: string;
}

export class RegisterDto {
    @ApiProperty({ description: 'Username for the new account', example: 'johndoe', minLength: 3 })
    @IsNotEmpty()
    @IsString()
    @MinLength(3)
    username: string;

    @ApiProperty({ description: 'Email address', example: 'john@example.com' })
    @IsEmail()
    @IsNotEmpty()
    email: string;

    // H-02: regex previously was /^[^.\n](?=.*[a-z])(?=.*[\d\w]).*$/, which
    // looked like "lowercase + digit/special" but `\w` includes letters so
    // the second lookahead is satisfied by any letter. "abcdef" passed at
    // length 6. Use explicit lowercase + (digit or non-word) lookaheads,
    // and raise the global minimum to 8 to match Better Auth's runtime
    // setting (auth-runtime.instance.ts).
    @ApiProperty({
        description:
            'Password (min 8 chars, must contain lowercase letter and number or special char)',
        example: 'MySecure123!',
        minLength: 8,
    })
    @IsString()
    @IsNotEmpty()
    @MinLength(8)
    @Matches(/^(?=.*[a-z])(?=.*[\d\W_]).{8,}$/, {
        message:
            'Password must be at least 8 chars and contain at least 1 lowercase letter and 1 number or special character',
    })
    password: string;

    @ApiPropertyOptional({ description: 'Callback URL for email verification redirect' })
    @IsString()
    @IsOptional()
    emailVerificationCallbackUrl?: string;

    /**
     * The legal documents the user ticked the box for, exactly as the form
     * displayed them.
     *
     * This is the field the signup checkbox was missing. It was uncontrolled
     * (`<input id="terms" type="checkbox" required>`), never entered `formData`,
     * and never reached the API: HTML5 `required` blocked the submit and nothing
     * was recorded.
     *
     * Optional at the DTO layer so machine-driven registration paths that never
     * showed a checkbox are not forced to invent one; the interactive signup
     * form always sends it, and `AuthController.register` rejects a claim the
     * corpus never published.
     */
    @ApiPropertyOptional({ type: () => [TermsAcceptanceClaimDto] })
    @IsOptional()
    @IsArray()
    @ArrayNotEmpty({ message: 'Terms acceptance, when supplied, must list at least one document' })
    @ValidateNested({ each: true })
    @Type(() => TermsAcceptanceClaimDto)
    terms?: TermsAcceptanceClaimDto[];
}

export class LoginDto {
    @ApiProperty({ description: 'Email address', example: 'john@example.com' })
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @ApiProperty({ description: 'Account password', example: 'MySecure123!' })
    @IsString()
    @IsNotEmpty()
    password: string;
}

export class UpdatePasswordDto {
    @ApiProperty({ description: 'Current password for verification', example: 'OldPassword123!' })
    @IsString()
    @IsNotEmpty()
    currentPassword: string;

    @ApiProperty({
        description:
            'New password (min 8 chars, must contain lowercase letter and number or special char)',
        example: 'NewSecure456!',
        minLength: 8,
    })
    @IsString()
    @IsNotEmpty()
    @MinLength(8)
    @Matches(/^(?=.*[a-z])(?=.*[\d\W_]).{8,}$/, {
        message:
            'Password must be at least 8 chars and contain at least 1 lowercase letter and 1 number or special character',
    })
    newPassword: string;
}

/**
 * EW-617 G3: payload for `POST /api/auth/claim`. Anonymous users send
 * this with their anon session bearer token to convert into a regular
 * account; reuses the same password rules as `RegisterDto`.
 */
export class ClaimAccountDto {
    @ApiProperty({ description: 'Email address to attach', example: 'john@example.com' })
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @ApiProperty({
        description:
            'Password (min 8 chars, must contain lowercase letter and number or special char)',
        example: 'MySecure123!',
        minLength: 8,
    })
    @IsString()
    @IsNotEmpty()
    @MinLength(8)
    @Matches(/^(?=.*[a-z])(?=.*[\d\W_]).{8,}$/, {
        message:
            'Password must be at least 8 chars and contain at least 1 lowercase letter and 1 number or special character',
    })
    password: string;

    @ApiPropertyOptional({
        description: 'Username to use after claim (defaults to current anon username)',
    })
    @IsString()
    @IsOptional()
    @MinLength(3)
    username?: string;

    @ApiPropertyOptional({ description: 'Callback URL for email verification redirect' })
    @IsString()
    @IsOptional()
    emailVerificationCallbackUrl?: string;

    @ApiPropertyOptional({
        description:
            'Optional UUID v4 minted at funnel entry (landing page → wizard). Threaded into the zero-friction telemetry funnel; ignored when absent.',
    })
    // Security: M-06 — enforce UUID v4 format to prevent arbitrary string injection into PostHog telemetry,
    // matching the constraint already applied to CreateAnonymousDto.correlationId (the issuance side).
    @IsUUID('4')
    @IsOptional()
    correlationId?: string;
}

export class OAuthCallbackDto {
    @ApiProperty({ description: 'Authorization code from OAuth provider' })
    @IsString()
    @IsNotEmpty()
    code: string;

    @ApiPropertyOptional({ description: 'State parameter for CSRF protection' })
    @IsString()
    @IsOptional()
    state?: string;
}

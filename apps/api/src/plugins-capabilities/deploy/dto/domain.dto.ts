import { IsString, IsNotEmpty, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AddDomainDto {
    @ApiProperty({ description: 'Domain name to add (e.g., example.com)', example: 'example.com' })
    @IsString()
    @IsNotEmpty()
    @Matches(
        /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/,
        {
            message: 'Invalid domain format. Example: example.com',
        },
    )
    domain: string;
}

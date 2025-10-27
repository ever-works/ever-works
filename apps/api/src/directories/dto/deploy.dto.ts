import { IsString } from 'class-validator';

export class VercelTokenDto {
    @IsString()
    token: string;
}

import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { TimestampColumn } from './_types';

@Entity({ name: 'accounts' })
@Index(['providerId', 'accountId'], { unique: true })
@Index(['userId', 'providerId'], { unique: true })
export class AuthAccount {
    @PrimaryColumn({ type: 'varchar' })
    id: string;

    @Column({ type: 'varchar' })
    userId: string;

    @Column({ type: 'varchar' })
    accountId: string;

    @Column({ type: 'varchar' })
    providerId: string;

    @Column({ type: 'text', nullable: true })
    accessToken?: string | null;

    @Column({ type: 'text', nullable: true })
    refreshToken?: string | null;

    @TimestampColumn({ nullable: true })
    accessTokenExpiresAt?: Date | null;

    @TimestampColumn({ nullable: true })
    refreshTokenExpiresAt?: Date | null;

    @Column({ type: 'text', nullable: true })
    scope?: string | null;

    @Column({ type: 'text', nullable: true })
    idToken?: string | null;

    @Column({ type: 'text', nullable: true })
    password?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}

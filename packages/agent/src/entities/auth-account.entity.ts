import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

@Entity({ name: 'account' })
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

    @Column({ type: 'varchar', nullable: true })
    username?: string | null;

    @Column({ type: 'varchar', nullable: true })
    email?: string | null;

    @Column({ type: 'varchar', nullable: true })
    tokenType?: string | null;

    @PortableDateColumn({ nullable: true })
    accessTokenExpiresAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    refreshTokenExpiresAt?: Date | null;

    @Column({ type: 'text', nullable: true })
    scope?: string | null;

    @Column({ type: 'text', nullable: true })
    idToken?: string | null;

    @Column({ type: 'text', nullable: true })
    password?: string | null;

    @Column({ type: 'simple-json', nullable: true })
    metadata?: Record<string, any> | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}

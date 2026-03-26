import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import { BaUser } from './ba-user.entity';

@Entity({ name: 'ba_account' })
export class BaAccount {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    userId: string;

    @ManyToOne(() => BaUser, { onDelete: 'CASCADE' })
    user: BaUser;

    @Column()
    accountId: string;

    @Column()
    providerId: string;

    @Column({ type: 'text', nullable: true })
    accessToken: string;

    @Column({ type: 'text', nullable: true })
    refreshToken: string;

    @Column({ nullable: true })
    expiresAt: Date;

    @Column({ nullable: true })
    scope: string;

    @Column({ type: 'text', nullable: true })
    password: string;

    @Column({ type: 'text', nullable: true })
    idToken: string;

    @Column({ nullable: true })
    tokenType: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}

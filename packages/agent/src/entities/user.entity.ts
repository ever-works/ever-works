import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    OneToMany,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    JoinColumn,
} from 'typeorm';
import type { ClassToObject } from './types';
import { Directory } from './directory.entity';
import { DirectoryGenerationHistory } from './directory-generation-history.entity';
import { UserSubscription } from './user-subscription.entity';
import { SubscriptionPlan } from './subscription-plan.entity';
import { DirectorySchedule } from './directory-schedule.entity';
import { DirectoryMember } from './directory-member.entity';

@Entity({ name: 'users', synchronize: false })
export class User {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    username: string;

    @Column({ unique: true })
    email: string;

    @Column()
    password: string;

    @Column({ default: 'local' })
    registrationProvider: string; // 'local', 'github', 'google' - how user initially signed up

    @Column({ nullable: true })
    avatar: string;

    // Email verification
    @Column({ default: false })
    emailVerified: boolean;

    @Column({ nullable: true })
    emailVerificationToken: string;

    @Column({ nullable: true })
    emailVerificationExpires: Date;

    // User status
    @Column({ default: true })
    isActive: boolean;

    @Column({ nullable: true })
    lastLoginAt: Date;

    @Column({ nullable: true })
    lastLoginIp: string;

    // Password reset
    @Column({ nullable: true })
    passwordResetToken: string;

    @Column({ nullable: true })
    passwordResetExpires: Date;

    // Git committer overrides (optional — fallback to username/email if not set)
    @Column({ type: 'varchar', nullable: true })
    committerName?: string | null;

    @Column({ type: 'varchar', nullable: true })
    committerEmail?: string | null;

    // Timestamps
    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    @OneToMany(() => Directory, (directory) => directory.user, { lazy: true })
    directories: Promise<ClassToObject<Directory>[]>;

    @OneToMany(() => DirectoryGenerationHistory, (history) => history.user, { lazy: true })
    generationHistory?: Promise<ClassToObject<DirectoryGenerationHistory>[]>;

    @OneToMany(() => UserSubscription, (subscription) => subscription.user, { lazy: true })
    subscriptions?: Promise<ClassToObject<UserSubscription>[]>;

    @OneToMany(() => DirectorySchedule, (schedule) => schedule.user, { lazy: true })
    directorySchedules?: Promise<ClassToObject<DirectorySchedule>[]>;

    @OneToMany(() => DirectoryMember, (member) => member.user, { lazy: true })
    directoryMemberships?: Promise<ClassToObject<DirectoryMember>[]>;

    @Column({ nullable: true })
    defaultPlanId?: string | null;

    @ManyToOne(() => SubscriptionPlan, { nullable: true, eager: true })
    @JoinColumn({ name: 'defaultPlanId' })
    defaultPlan?: ClassToObject<SubscriptionPlan> | null;

    local: boolean = false;

    asCommitter(): { name: string; email: string } {
        return {
            name: this.committerName || this.username,
            email: this.committerEmail || this.email,
        };
    }
}

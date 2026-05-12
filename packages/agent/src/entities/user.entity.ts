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
import { TimestampColumn } from './_types';
import { Work } from './work.entity';
import { WorkGenerationHistory } from './work-generation-history.entity';
import { UserSubscription } from './user-subscription.entity';
import { SubscriptionPlan } from './subscription-plan.entity';
import { WorkSchedule } from './work-schedule.entity';
import { WorkMember } from './work-member.entity';
import type { OnboardingWizardStateV2 } from '@ever-works/contracts/api';

@Entity({ name: 'users' })
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

    // Onboarding wizard v2 — server-side state (so progress survives device
    // switches). `TimestampColumn` stores as `bigint` so the schema is
    // identical on Postgres + SQLite (the `internal-cli` test driver).
    @TimestampColumn({ nullable: true })
    onboardingCompletedAt?: Date | null;

    @TimestampColumn({ nullable: true })
    onboardingDismissedAt?: Date | null;

    @Column('simple-json', { nullable: true })
    onboardingState?: OnboardingWizardStateV2 | null;

    // Timestamps
    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    @OneToMany(() => Work, (work) => work.user, { lazy: true })
    works: Promise<ClassToObject<Work>[]>;

    @OneToMany(() => WorkGenerationHistory, (history) => history.user, { lazy: true })
    generationHistory?: Promise<ClassToObject<WorkGenerationHistory>[]>;

    @OneToMany(() => UserSubscription, (subscription) => subscription.user, { lazy: true })
    subscriptions?: Promise<ClassToObject<UserSubscription>[]>;

    @OneToMany(() => WorkSchedule, (schedule) => schedule.user, { lazy: true })
    workSchedules?: Promise<ClassToObject<WorkSchedule>[]>;

    @OneToMany(() => WorkMember, (member) => member.user, { lazy: true })
    workMemberships?: Promise<ClassToObject<WorkMember>[]>;

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

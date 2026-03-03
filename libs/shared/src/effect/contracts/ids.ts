import { Schema } from "effect";

const BrandedIdBaseSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty()
);

const makeBrandedIdSchema = <TBrand extends string>(brandName: TBrand) =>
  BrandedIdBaseSchema.pipe(Schema.brand(brandName));

export const TenantIdSchema = makeBrandedIdSchema("TenantId");
export const ProjectIdSchema = makeBrandedIdSchema("ProjectId");
export const RoleIdSchema = makeBrandedIdSchema("RoleId");
export const UserIdSchema = makeBrandedIdSchema("UserId");
export const AgentIdSchema = makeBrandedIdSchema("AgentId");
export const ConversationIdSchema = makeBrandedIdSchema("ConversationId");
export const MessageIdSchema = makeBrandedIdSchema("MessageId");
export const SourceIdSchema = makeBrandedIdSchema("SourceId");
export const BatchIdSchema = makeBrandedIdSchema("BatchId");
export const SpaceIdSchema = makeBrandedIdSchema("SpaceId");
export const ProfileIdSchema = makeBrandedIdSchema("ProfileId");
export const MemoryIdSchema = makeBrandedIdSchema("MemoryId");
export const EvidenceIdSchema = makeBrandedIdSchema("EvidenceId");

export type TenantId = Schema.Schema.Type<typeof TenantIdSchema>;
export type ProjectId = Schema.Schema.Type<typeof ProjectIdSchema>;
export type RoleId = Schema.Schema.Type<typeof RoleIdSchema>;
export type UserId = Schema.Schema.Type<typeof UserIdSchema>;
export type AgentId = Schema.Schema.Type<typeof AgentIdSchema>;
export type ConversationId = Schema.Schema.Type<typeof ConversationIdSchema>;
export type MessageId = Schema.Schema.Type<typeof MessageIdSchema>;
export type SourceId = Schema.Schema.Type<typeof SourceIdSchema>;
export type BatchId = Schema.Schema.Type<typeof BatchIdSchema>;
export type SpaceId = Schema.Schema.Type<typeof SpaceIdSchema>;
export type ProfileId = Schema.Schema.Type<typeof ProfileIdSchema>;
export type MemoryId = Schema.Schema.Type<typeof MemoryIdSchema>;
export type EvidenceId = Schema.Schema.Type<typeof EvidenceIdSchema>;

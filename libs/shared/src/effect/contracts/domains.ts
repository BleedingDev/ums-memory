import { Schema } from "effect";

import { ProjectIdSchema, RoleIdSchema, UserIdSchema } from "./ids.js";

export const ScopeLevelSchema = Schema.Literal("common", "project", "job_role", "user");

export const CommonScopeSchema = Schema.Struct({
  level: Schema.Literal("common"),
});

export const ProjectScopeSchema = Schema.Struct({
  level: Schema.Literal("project"),
  projectId: ProjectIdSchema,
});

export const JobRoleScopeSchema = Schema.Struct({
  level: Schema.Literal("job_role"),
  roleId: RoleIdSchema,
});

export const UserScopeSchema = Schema.Struct({
  level: Schema.Literal("user"),
  userId: UserIdSchema,
});

export const ScopeSchema = Schema.Union(
  CommonScopeSchema,
  ProjectScopeSchema,
  JobRoleScopeSchema,
  UserScopeSchema,
);

export const MemoryLayerSchema = Schema.Literal("episodic", "working", "procedural");

export const PolicyOutcomeSchema = Schema.Literal("allow", "review", "deny");

export interface DomainArray extends ReadonlyArray<DomainValue> {}

export interface DomainRecord {
  readonly [key: string]: DomainValue;
}

export type DomainValue = string | number | boolean | null | DomainArray | DomainRecord;

export const DomainValueSchema: Schema.Schema<DomainValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.String,
    Schema.Number,
    Schema.Boolean,
    Schema.Null,
    Schema.Array(DomainValueSchema),
    Schema.Record({
      key: Schema.String,
      value: DomainValueSchema,
    }),
  ),
);

export const DomainRecordSchema: Schema.Schema<DomainRecord> = Schema.Record({
  key: Schema.String,
  value: DomainValueSchema,
});

export const PolicyContextValueSchema = DomainValueSchema;
export const PolicyContextSchema = DomainRecordSchema;
export const IngestionRecordValueSchema = DomainValueSchema;
export const IngestionMetadataSchema = DomainRecordSchema;

export type ScopeLevel = Schema.Schema.Type<typeof ScopeLevelSchema>;
export type CommonScope = Schema.Schema.Type<typeof CommonScopeSchema>;
export type ProjectScope = Schema.Schema.Type<typeof ProjectScopeSchema>;
export type JobRoleScope = Schema.Schema.Type<typeof JobRoleScopeSchema>;
export type UserScope = Schema.Schema.Type<typeof UserScopeSchema>;
export type Scope = Schema.Schema.Type<typeof ScopeSchema>;
export type MemoryLayer = Schema.Schema.Type<typeof MemoryLayerSchema>;
export type PolicyOutcome = Schema.Schema.Type<typeof PolicyOutcomeSchema>;
export type PolicyContextValue = Schema.Schema.Type<typeof PolicyContextValueSchema>;
export type PolicyContext = Schema.Schema.Type<typeof PolicyContextSchema>;
export type IngestionRecordValue = Schema.Schema.Type<typeof IngestionRecordValueSchema>;
export type IngestionMetadata = Schema.Schema.Type<typeof IngestionMetadataSchema>;

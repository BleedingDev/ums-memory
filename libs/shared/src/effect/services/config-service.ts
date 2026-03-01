import { Context, Layer, ParseResult, Schema } from "effect";

export const RuntimeEnvironmentSchema = Schema.Literal("development", "test", "production");
export type RuntimeEnvironment = Schema.Schema.Type<typeof RuntimeEnvironmentSchema>;

export const RuntimeLogLevelSchema = Schema.Literal("debug", "info", "warn", "error");
export type RuntimeLogLevel = Schema.Schema.Type<typeof RuntimeLogLevelSchema>;

export const RuntimeConfigSchema = Schema.Struct({
  environment: RuntimeEnvironmentSchema,
  serviceName: Schema.NonEmptyTrimmedString,
  logLevel: RuntimeLogLevelSchema,
});

export type RuntimeConfig = Schema.Schema.Type<typeof RuntimeConfigSchema>;
export type RuntimeConfigInput = Schema.Schema.Encoded<typeof RuntimeConfigSchema>;

export const runtimeConfigDefaults: RuntimeConfig = {
  environment: "development",
  serviceName: "ums-memory",
  logLevel: "info",
};

type SchemaWithoutContext<A, I = A> = Schema.Schema<A, I, never>;

const decodeUnknownSync = <A, I>(schema: SchemaWithoutContext<A, I>) =>
  Schema.decodeUnknownSync(schema);

const decodeUnknownEither = <A, I>(schema: SchemaWithoutContext<A, I>) =>
  Schema.decodeUnknownEither(schema);

const decodeUnknownEffect = <A, I>(schema: SchemaWithoutContext<A, I>) =>
  Schema.decodeUnknown(schema);

const validateUnknownSync = <A, I>(schema: SchemaWithoutContext<A, I>) =>
  Schema.validateSync(schema);

const validateUnknownEither = <A, I>(schema: SchemaWithoutContext<A, I>) =>
  Schema.validateEither(schema);

const validateUnknownEffect = <A, I>(schema: SchemaWithoutContext<A, I>) => Schema.validate(schema);

export const formatRuntimeConfigParseError = (error: ParseResult.ParseError): string =>
  ParseResult.TreeFormatter.formatErrorSync(error);

export const decodeRuntimeConfigSync = decodeUnknownSync(RuntimeConfigSchema);
export const decodeRuntimeConfigEither = decodeUnknownEither(RuntimeConfigSchema);
export const decodeRuntimeConfig = decodeUnknownEffect(RuntimeConfigSchema);

export const validateRuntimeConfigSync = validateUnknownSync(RuntimeConfigSchema);
export const validateRuntimeConfigEither = validateUnknownEither(RuntimeConfigSchema);
export const validateRuntimeConfig = validateUnknownEffect(RuntimeConfigSchema);

export interface RuntimeConfigEnvRecord {
  readonly [key: string]: string | undefined;
}

export interface RuntimeConfigEnvKeys {
  readonly environment: string;
  readonly fallbackEnvironment: string;
  readonly serviceName: string;
  readonly logLevel: string;
}

export const defaultRuntimeConfigEnvKeys: RuntimeConfigEnvKeys = {
  environment: "UMS_ENVIRONMENT",
  fallbackEnvironment: "NODE_ENV",
  serviceName: "UMS_SERVICE_NAME",
  logLevel: "UMS_LOG_LEVEL",
};

export interface RuntimeConfigFromEnvOptions {
  readonly defaults?: Partial<RuntimeConfigInput>;
  readonly keys?: Partial<RuntimeConfigEnvKeys>;
}

export interface RuntimeConfigEnvInput {
  readonly environment: string;
  readonly serviceName: string;
  readonly logLevel: string;
}

const normalizeEnvValue = (value: string | undefined): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const readEnvValue = (env: RuntimeConfigEnvRecord, key: string): string | undefined =>
  normalizeEnvValue(env[key]);

const resolveEnvKeys = (keys: Partial<RuntimeConfigEnvKeys> | undefined): RuntimeConfigEnvKeys => ({
  ...defaultRuntimeConfigEnvKeys,
  ...keys,
});

export const makeRuntimeConfigInputWithDefaults = (
  defaults: Partial<RuntimeConfigInput> | undefined,
): RuntimeConfigInput => ({
  ...runtimeConfigDefaults,
  ...defaults,
});

export const runtimeConfigInputFromEnv = (
  env: RuntimeConfigEnvRecord,
  options: RuntimeConfigFromEnvOptions = {},
): RuntimeConfigEnvInput => {
  const keys = resolveEnvKeys(options.keys);
  const base = makeRuntimeConfigInputWithDefaults(options.defaults);
  const environment =
    readEnvValue(env, keys.environment) ?? readEnvValue(env, keys.fallbackEnvironment);
  const serviceName = readEnvValue(env, keys.serviceName);
  const logLevel = readEnvValue(env, keys.logLevel);

  return {
    environment: environment ?? base.environment,
    serviceName: serviceName ?? base.serviceName,
    logLevel: logLevel ?? base.logLevel,
  };
};

export const decodeRuntimeConfigFromEnvSync = (
  env: RuntimeConfigEnvRecord,
  options: RuntimeConfigFromEnvOptions = {},
): RuntimeConfig => decodeRuntimeConfigSync(runtimeConfigInputFromEnv(env, options));

export const decodeRuntimeConfigFromEnvEither = (
  env: RuntimeConfigEnvRecord,
  options: RuntimeConfigFromEnvOptions = {},
) => decodeRuntimeConfigEither(runtimeConfigInputFromEnv(env, options));

export const decodeRuntimeConfigFromEnv = (
  env: RuntimeConfigEnvRecord,
  options: RuntimeConfigFromEnvOptions = {},
) => decodeRuntimeConfig(runtimeConfigInputFromEnv(env, options));

export const validateRuntimeConfigFromEnvSync = (
  env: RuntimeConfigEnvRecord,
  options: RuntimeConfigFromEnvOptions = {},
): RuntimeConfig => validateRuntimeConfigSync(runtimeConfigInputFromEnv(env, options));

export const validateRuntimeConfigFromEnvEither = (
  env: RuntimeConfigEnvRecord,
  options: RuntimeConfigFromEnvOptions = {},
) => validateRuntimeConfigEither(runtimeConfigInputFromEnv(env, options));

export const validateRuntimeConfigFromEnv = (
  env: RuntimeConfigEnvRecord,
  options: RuntimeConfigFromEnvOptions = {},
) => validateRuntimeConfig(runtimeConfigInputFromEnv(env, options));

export interface ConfigService {
  readonly get: <K extends keyof RuntimeConfig>(key: K) => RuntimeConfig[K];
  readonly getAll: () => RuntimeConfig;
}

export const ConfigServiceTag = Context.GenericTag<ConfigService>("@ums/effect/ConfigService");

export const makeConfigService = (config: RuntimeConfig): ConfigService => ({
  get: (key) => config[key],
  getAll: () => config,
});

export const makeConfigLayer = (config: RuntimeConfig): Layer.Layer<ConfigService> =>
  Layer.succeed(ConfigServiceTag, makeConfigService(config));

import { Schema } from "effect";

const MAX_SOURCE_CONTENT_LENGTH = 3_000;
const TEXT_KEY_HINT =
  /(content|text|message|prompt|response|summary|note|query|analysis|output|title|body)/i;
const SECRET_ASSIGNMENT_PATTERN =
  /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|passphrase|authorization|bearer)\b\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|([^\s,;'"`]+))/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{10,}/gi;
const JWT_PATTERN =
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const COMMON_SECRET_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g;

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const ContentItemSchema = Schema.Struct({
  text: Schema.String,
});
const ContentItemArraySchema = Schema.Array(ContentItemSchema);

const isString = Schema.is(Schema.String);
const isUnknownRecord = Schema.is(UnknownRecordSchema);
const isContentItemArray = Schema.is(ContentItemArraySchema);

const stripControlChars = (value: string): string =>
  [...value]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : char;
    })
    .join("");

const collectInterestingText = (
  value: unknown,
  depth = 0,
  keyHint = ""
): readonly string[] => {
  if (depth > 5) {
    return [];
  }
  if (isString(value)) {
    const normalized = value.trim();
    if (!normalized) {
      return [];
    }
    if (keyHint && !TEXT_KEY_HINT.test(keyHint) && depth > 1) {
      return [];
    }
    return [normalized];
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .flatMap((entry) => collectInterestingText(entry, depth + 1, keyHint))
      .slice(0, 8);
  }
  if (!isUnknownRecord(value)) {
    return [];
  }
  return Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .flatMap((key) => collectInterestingText(value[key], depth + 1, key))
    .slice(0, 8);
};

export const sanitizeSourceContent = (value: string): string => {
  const collapsed = stripControlChars(value)
    .replace(
      SECRET_ASSIGNMENT_PATTERN,
      (
        _match,
        prefix: string,
        doubleQuotedValue: string | undefined,
        singleQuotedValue: string | undefined
      ) => {
        if (doubleQuotedValue !== undefined) {
          return `${prefix}"[REDACTED_SECRET]"`;
        }
        if (singleQuotedValue !== undefined) {
          return `${prefix}'[REDACTED_SECRET]'`;
        }
        return `${prefix}[REDACTED_SECRET]`;
      }
    )
    .replace(BEARER_PATTERN, "Bearer [REDACTED_SECRET]")
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(COMMON_SECRET_TOKEN_PATTERN, "[REDACTED_SECRET]")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > MAX_SOURCE_CONTENT_LENGTH
    ? collapsed.slice(0, MAX_SOURCE_CONTENT_LENGTH)
    : collapsed;
};

export const extractSanitizedSourceContent = (value: unknown): string =>
  isString(value)
    ? sanitizeSourceContent(value)
    : isContentItemArray(value)
      ? sanitizeSourceContent(value.map((entry) => entry.text).join(" | "))
      : sanitizeSourceContent(collectInterestingText(value).join(" | "));

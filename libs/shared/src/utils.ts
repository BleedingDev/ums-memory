import { createHash } from "node:crypto";

type PlainObject = Record<string, unknown>;

export function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (isPlainObject(value)) {
    const sorted: PlainObject = {};
    const objectValue = value as PlainObject;
    for (const key of Object.keys(objectValue).sort()) {
      sorted[key] = sortValue(objectValue[key]);
    }
    return sorted;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

const canStructuredClone = typeof globalThis.structuredClone === "function";

export function deepClone<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  if (canStructuredClone) {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(stableStringify(value)) as T;
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  const mutableValue = value as Record<string, unknown>;
  for (const key of Object.keys(mutableValue)) {
    deepFreeze(mutableValue[key]);
  }
  return Object.freeze(value);
}

export function asSortedUniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return [
    ...new Set(
      values
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ].sort();
}

export function deterministicId(prefix: string, payload: unknown): string {
  const hash = createHash("sha256")
    .update(stableStringify(payload))
    .digest("hex");
  return `${prefix}_${hash.slice(0, 16)}`;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export function toIsoTimestamp(
  value: unknown,
  fallback: unknown = null
): string {
  if (value === undefined || value === null || value === "") {
    if (fallback === null) {
      return new Date().toISOString();
    }
    return toIsoTimestamp(fallback, null);
  }
  const date = new Date(value as string | number | Date);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${String(value)}`);
  }
  return date.toISOString();
}

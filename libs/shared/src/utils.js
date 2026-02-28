import { createHash } from "node:crypto";

export function isPlainObject(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (isPlainObject(value)) {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortValue(value[key]);
    }
    return sorted;
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

const canStructuredClone = typeof globalThis.structuredClone === "function";

export function deepClone(value) {
  if (value === undefined) {
    return undefined;
  }
  if (canStructuredClone) {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(stableStringify(value));
}

export function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

export function asSortedUniqueStrings(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(
    new Set(
      values
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).sort();
}

export function deterministicId(prefix, payload) {
  const hash = createHash("sha256").update(stableStringify(payload)).digest("hex");
  return `${prefix}_${hash.slice(0, 16)}`;
}

export function clamp(value, min, max) {
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

export function toIsoTimestamp(value, fallback = null) {
  if (value === undefined || value === null || value === "") {
    if (fallback === null) {
      return new Date().toISOString();
    }
    return toIsoTimestamp(fallback, null);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${String(value)}`);
  }
  return date.toISOString();
}

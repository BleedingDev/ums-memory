import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_EXPORT_NAME = "createUmsEngine";
let cached;

function toModuleSpecifier(modulePath) {
  if (modulePath.startsWith(".") || modulePath.startsWith("/") || isAbsolute(modulePath)) {
    const absolutePath = isAbsolute(modulePath) ? modulePath : resolve(process.cwd(), modulePath);
    return pathToFileURL(absolutePath).href;
  }
  return modulePath;
}

async function loadEngineFactory() {
  const modulePath = process.env.UMS_IMPL_MODULE;
  const exportName = process.env.UMS_IMPL_EXPORT || DEFAULT_EXPORT_NAME;

  if (!modulePath) {
    try {
      const mod = await import(toModuleSpecifier("./apps/api/src/ums/engine.mjs"));
      if (typeof mod.createUmsEngine === "function") {
        return {
          factory: mod.createUmsEngine,
          source: "./apps/api/src/ums/engine.mjs",
          exportName: "createUmsEngine",
        };
      }
    } catch {
      // Fall back to the local reference engine in test-only contexts.
    }
    const fallback = await import("./reference-ums-engine.mjs");
    return {
      factory: fallback.createUmsEngine,
      source: "tests/support/reference-ums-engine.mjs",
      exportName: "createUmsEngine",
    };
  }

  const mod = await import(toModuleSpecifier(modulePath));
  const factory = mod[exportName];
  if (typeof factory !== "function") {
    throw new TypeError(
      `Module '${modulePath}' must export function '${exportName}' to satisfy UMS tests.`
    );
  }

  return { factory, source: modulePath, exportName };
}

export async function getEngineFactory() {
  if (!cached) {
    cached = await loadEngineFactory();
  }
  return cached;
}

export function clearEngineFactoryCache() {
  cached = undefined;
}

export async function getEngineInfo() {
  const { source, exportName } = await getEngineFactory();
  return { source, exportName };
}

export async function createEngine(options = {}) {
  const { factory } = await getEngineFactory();
  const engine = await factory(options);

  if (!engine || typeof engine !== "object") {
    throw new TypeError("Engine factory must return an object.");
  }
  if (typeof engine.ingest !== "function") {
    throw new TypeError("Engine must expose an ingest() function.");
  }
  if (typeof engine.recall !== "function") {
    throw new TypeError("Engine must expose a recall() function.");
  }

  return engine;
}

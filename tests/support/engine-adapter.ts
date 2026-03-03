import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_EXPORT_NAME = "createUmsEngine";

type EngineFactory = (
  options?: Record<string, unknown>
) => unknown | Promise<unknown>;

interface LoadedEngineFactory {
  readonly factory: EngineFactory;
  readonly source: string;
  readonly exportName: string;
}

interface EngineLike {
  readonly ingest: (input: unknown) => Promise<any>;
  readonly recall: (input: unknown) => Promise<any>;
  readonly getEventCount: (...args: any[]) => number;
  readonly exportState: () => any;
  readonly stateDigest: () => string;
}

let cached: LoadedEngineFactory | undefined;

function toModuleSpecifier(modulePath: string): string {
  if (
    modulePath.startsWith(".") ||
    modulePath.startsWith("/") ||
    isAbsolute(modulePath)
  ) {
    const absolutePath = isAbsolute(modulePath)
      ? modulePath
      : resolve(process.cwd(), modulePath);
    return pathToFileURL(absolutePath).href;
  }
  return modulePath;
}

async function loadEngineFactory(): Promise<LoadedEngineFactory> {
  const modulePath = process.env["UMS_IMPL_MODULE"];
  const exportName = process.env["UMS_IMPL_EXPORT"] || DEFAULT_EXPORT_NAME;

  if (!modulePath) {
    try {
      const mod = (await import(
        toModuleSpecifier("./apps/api/src/ums/engine.ts")
      )) as { createUmsEngine?: EngineFactory };
      if (typeof mod.createUmsEngine === "function") {
        return {
          factory: mod.createUmsEngine,
          source: "./apps/api/src/ums/engine.ts",
          exportName: "createUmsEngine",
        };
      }
    } catch {
      // Fall back to the local reference engine in test-only contexts.
    }
    const fallback = (await import("./reference-ums-engine.ts")) as {
      createUmsEngine: EngineFactory;
    };
    return {
      factory: fallback.createUmsEngine,
      source: "tests/support/reference-ums-engine.ts",
      exportName: "createUmsEngine",
    };
  }

  const mod = (await import(toModuleSpecifier(modulePath))) as Record<
    string,
    unknown
  >;
  const factory = mod[exportName];
  if (typeof factory !== "function") {
    throw new TypeError(
      `Module '${modulePath}' must export function '${exportName}' to satisfy UMS tests.`
    );
  }

  const typedFactory = factory as EngineFactory;
  return { factory: typedFactory, source: modulePath, exportName };
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
  const candidate = engine as Partial<EngineLike>;
  if (typeof candidate.ingest !== "function") {
    throw new TypeError("Engine must expose an ingest() function.");
  }
  if (typeof candidate.recall !== "function") {
    throw new TypeError("Engine must expose a recall() function.");
  }
  if (typeof candidate.getEventCount !== "function") {
    throw new TypeError("Engine must expose a getEventCount() function.");
  }
  if (typeof candidate.exportState !== "function") {
    throw new TypeError("Engine must expose an exportState() function.");
  }
  if (typeof candidate.stateDigest !== "function") {
    throw new TypeError("Engine must expose a stateDigest() function.");
  }

  return candidate as EngineLike;
}

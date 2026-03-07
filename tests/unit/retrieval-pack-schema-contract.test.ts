import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { test } from "@effect-native/bun-test";
import { Schema } from "effect";
import ts from "typescript";

const effectModuleDirectory = new URL(
  "../../libs/shared/src/effect/",
  import.meta.url
);

const transpileEffectModule = (sourceFilename: any, tempDirectory: any) => {
  const sourceFileUrl = new URL(sourceFilename, effectModuleDirectory);
  const source = readFileSync(sourceFileUrl, "utf8");
  const transpiled = ts.transpileModule(source, {
    fileName: sourceFileUrl.pathname,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const diagnostics = transpiled.diagnostics ?? [];
  if (diagnostics.length > 0) {
    const diagnosticMessage = diagnostics
      .map((diagnostic) => {
        const messageText = ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          "\n"
        );
        const position =
          diagnostic.file === undefined || diagnostic.start === undefined
            ? sourceFilename
            : `${sourceFilename}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
        return `${position} - ${messageText}`;
      })
      .join("\n");
    throw new Error(
      `TypeScript transpile diagnostics for ${sourceFilename}:\n${diagnosticMessage}`
    );
  }

  const outputFilename = join(
    tempDirectory,
    sourceFilename.replace(/\.ts$/, ".js")
  );
  mkdirSync(dirname(outputFilename), { recursive: true });
  writeFileSync(outputFilename, transpiled.outputText, "utf8");
};

const transpileManifest = Object.freeze([
  "contracts/ids.ts",
  "contracts/domains.ts",
  "contracts/services.ts",
]);

let contractsModulePromise: any;
let transpiledDirectoryPath: any;

const loadContractsModule = async () => {
  if (!contractsModulePromise) {
    const tempRootDirectory = join(process.cwd(), "dist", "tmp");
    mkdirSync(tempRootDirectory, { recursive: true });
    transpiledDirectoryPath = mkdtempSync(
      join(tempRootDirectory, "ums-memory-retrieval-pack-")
    );

    for (const modulePath of transpileManifest) {
      transpileEffectModule(modulePath, transpiledDirectoryPath);
    }

    const contractsModuleUrl = pathToFileURL(
      join(transpiledDirectoryPath, "contracts/services.js")
    ).href;
    contractsModulePromise = import(contractsModuleUrl);
  }

  return contractsModulePromise;
};

process.on("exit", () => {
  if (transpiledDirectoryPath) {
    rmSync(transpiledDirectoryPath, { recursive: true, force: true });
  }
});

const toErrorMessage = (error: any) =>
  error instanceof Error ? error.message : String(error);

const decodeActionablePack = (contractsModule: any, input: any) =>
  Schema.decodeUnknownSync(contractsModule.ActionableRetrievalPackSchema)(
    input
  );

const makeValidPackPayload = () => ({
  do: ["Confirm tenant isolation before retrieval."],
  dont: ["Do not bypass idempotency guards when replaying ingest tasks."],
  examples: [
    "When replaying events, derive idempotencyKey from deterministic source digest.",
  ],
  risks: ["Cross-space retrieval can leak memory between tenants."],
  sources: [
    {
      memoryId: "memory-source-1",
      excerpt: "Deterministic replay requires stable idempotency keys.",
      metadata: {
        score: 0.91,
        layer: "procedural",
      },
    },
  ],
  warnings: [
    "Evidence pointer may be stale and should be revalidated before promotion.",
  ],
});

test("ums-memory-8as.1: actionable retrieval pack schema decodes valid payload", async () => {
  const contractsModule = await loadContractsModule();
  const payload = makeValidPackPayload();

  const decoded = decodeActionablePack(contractsModule, payload);

  assert.deepEqual(decoded, payload);
});

test("ums-memory-8as.1: actionable retrieval pack schema rejects missing required category", async () => {
  const contractsModule = await loadContractsModule();
  const { dont: _ignoredDont, ...payloadWithoutDont } = makeValidPackPayload();

  assert.throws(
    () => decodeActionablePack(contractsModule, payloadWithoutDont),
    (error) => /dont/i.test(toErrorMessage(error))
  );
});

test("ums-memory-8as.1: actionable retrieval pack schema rejects invalid source metadata", async () => {
  const contractsModule = await loadContractsModule();
  const payload = makeValidPackPayload();
  const firstSource = payload.sources.at(0);
  assert.ok(firstSource);
  firstSource.metadata.score = 1.25;

  assert.throws(
    () => decodeActionablePack(contractsModule, payload),
    (error) => /score/i.test(toErrorMessage(error))
  );
});

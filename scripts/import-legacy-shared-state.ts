import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Effect, Schema } from "effect";

import {
  exportStoreSnapshot,
  importStoreSnapshot,
  resetStore,
} from "../apps/api/src/core.ts";
import { DEFAULT_SHARED_STATE_FILE } from "../apps/api/src/persistence.ts";

const ERROR_WITH_MESSAGE_SCHEMA = Schema.Struct({
  message: Schema.String,
});
const isErrorWithMessage = Schema.is(ERROR_WITH_MESSAGE_SCHEMA);

interface ParsedArgs {
  readonly sourceFile: string;
  readonly stateFile: string;
}

const toErrorMessage = (error: unknown): string =>
  isErrorWithMessage(error) ? error.message : String(error);

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const args = [...argv];
  let sourceFile: string | null = null;
  let stateFile = DEFAULT_SHARED_STATE_FILE;

  while (args.length > 0) {
    const token = args.shift();
    if (token === "--source-file") {
      sourceFile = args.shift() ?? "";
      continue;
    }
    if (token === "--state-file") {
      stateFile = args.shift() ?? "";
      continue;
    }
    if (token === "--help" || token === "-h") {
      throw new Error(
        "Usage: bun scripts/import-legacy-shared-state.ts --source-file <snapshot.json> [--state-file .ums-state.json]"
      );
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!sourceFile?.trim()) {
    throw new Error("--source-file is required.");
  }
  if (!stateFile.trim()) {
    throw new Error("--state-file must be a non-empty string.");
  }

  return {
    sourceFile: resolve(sourceFile),
    stateFile: resolve(stateFile),
  };
};

const main = (argv: readonly string[]) =>
  Effect.gen(function* () {
    const args = parseArgs(argv);
    const sourceRaw = yield* Effect.tryPromise({
      try: () => readFile(args.sourceFile, "utf8"),
      catch: (cause) =>
        new Error(
          `Failed to read legacy snapshot '${args.sourceFile}': ${toErrorMessage(cause)}`
        ),
    });
    const sourceSnapshot = yield* Effect.try({
      try: () => JSON.parse(sourceRaw),
      catch: (cause) =>
        new Error(
          `Failed to parse legacy snapshot '${args.sourceFile}': ${toErrorMessage(cause)}`
        ),
    });
    yield* Effect.sync(resetStore);
    const canonicalSnapshot = yield* Effect.try({
      try: () => {
        importStoreSnapshot(sourceSnapshot);
        return exportStoreSnapshot();
      },
      catch: (cause) =>
        new Error(
          `Failed to normalize legacy snapshot '${args.sourceFile}': ${toErrorMessage(cause)}`
        ),
    });
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(args.stateFile), { recursive: true }),
      catch: (cause) =>
        new Error(
          `Failed to create directory for '${args.stateFile}': ${toErrorMessage(cause)}`
        ),
    });
    yield* Effect.tryPromise({
      try: () =>
        writeFile(
          args.stateFile,
          `${JSON.stringify(canonicalSnapshot, null, 2)}\n`,
          "utf8"
        ),
      catch: (cause) =>
        new Error(
          `Failed to write compatibility state '${args.stateFile}': ${toErrorMessage(cause)}`
        ),
    });
    yield* Effect.sync(() => {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            sourceFile: args.sourceFile,
            stateFile: args.stateFile,
          },
          null,
          2
        )}\n`
      );
    });
  }).pipe(Effect.ensuring(Effect.sync(resetStore)));

void Effect.runPromise(main(process.argv.slice(2))).catch((error) => {
  process.stderr.write(`${toErrorMessage(error)}\n`);
  process.exitCode = 1;
});

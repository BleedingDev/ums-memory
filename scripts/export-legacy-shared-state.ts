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
  readonly stateFile: string;
  readonly outputFile: string;
}

const toErrorMessage = (error: unknown): string =>
  isErrorWithMessage(error) ? error.message : String(error);

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const args = [...argv];
  let stateFile = DEFAULT_SHARED_STATE_FILE;
  let outputFile: string | null = null;

  while (args.length > 0) {
    const token = args.shift();
    if (token === "--state-file") {
      stateFile = args.shift() ?? "";
      continue;
    }
    if (token === "--output-file") {
      outputFile = args.shift() ?? "";
      continue;
    }
    if (token === "--help" || token === "-h") {
      throw new Error(
        "Usage: bun scripts/export-legacy-shared-state.ts [--state-file .ums-state.json] --output-file <snapshot.json>"
      );
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!stateFile.trim()) {
    throw new Error("--state-file must be a non-empty string.");
  }
  if (!outputFile?.trim()) {
    throw new Error("--output-file is required.");
  }

  return {
    stateFile: resolve(stateFile),
    outputFile: resolve(outputFile),
  };
};

const main = (argv: readonly string[]) =>
  Effect.gen(function* () {
    const args = parseArgs(argv);
    const rawSnapshot = yield* Effect.tryPromise({
      try: () => readFile(args.stateFile, "utf8"),
      catch: (cause) =>
        new Error(
          `Failed to read compatibility state '${args.stateFile}': ${toErrorMessage(cause)}`
        ),
    });
    const parsedSnapshot = yield* Effect.try({
      try: () => JSON.parse(rawSnapshot),
      catch: (cause) =>
        new Error(
          `Failed to parse compatibility state '${args.stateFile}': ${toErrorMessage(cause)}`
        ),
    });
    yield* Effect.sync(resetStore);
    const canonicalSnapshot = yield* Effect.try({
      try: () => {
        importStoreSnapshot(parsedSnapshot);
        return exportStoreSnapshot();
      },
      catch: (cause) =>
        new Error(
          `Failed to normalize compatibility state '${args.stateFile}': ${toErrorMessage(cause)}`
        ),
    });
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(args.outputFile), { recursive: true }),
      catch: (cause) =>
        new Error(
          `Failed to create directory for '${args.outputFile}': ${toErrorMessage(cause)}`
        ),
    });
    yield* Effect.tryPromise({
      try: () =>
        writeFile(
          args.outputFile,
          `${JSON.stringify(canonicalSnapshot, null, 2)}\n`,
          "utf8"
        ),
      catch: (cause) =>
        new Error(
          `Failed to write exported snapshot '${args.outputFile}': ${toErrorMessage(cause)}`
        ),
    });
    yield* Effect.sync(() => {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            stateFile: args.stateFile,
            outputFile: args.outputFile,
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

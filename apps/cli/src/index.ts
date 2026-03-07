import { Cause, Effect, Exit, Schema } from "effect";

import { main } from "./program.ts";

const importMeta = import.meta as ImportMeta & { main?: boolean };
const isBoolean = Schema.is(Schema.Boolean);
const isMainModule =
  (isBoolean(importMeta.main) && importMeta.main) ||
  importMeta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  void (async () => {
    const exit = await Effect.runPromiseExit(Effect.promise(() => main()));
    if (Exit.isSuccess(exit)) {
      process.exitCode = exit.value;
      return;
    }
    process.stderr.write(
      `${JSON.stringify(
        {
          ok: false,
          error: {
            code: "CLI_ERROR",
            message: Cause.pretty(exit.cause),
          },
        },
        null,
        2
      )}\n`
    );
    process.exitCode = 1;
  })();
}

export { main };

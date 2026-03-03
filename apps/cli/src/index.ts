import { main } from "./program.ts";

const importMeta = import.meta as ImportMeta & { main?: boolean };
const isMainModule =
  (typeof importMeta.main === "boolean" && importMeta.main) ||
  importMeta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  void (async () => {
    try {
      const code = await main();
      process.exitCode = code;
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify(
          {
            ok: false,
            error: {
              code: "CLI_ERROR",
              message: error instanceof Error ? error.message : String(error),
            },
          },
          null,
          2
        )}\n`
      );
      process.exitCode = 1;
    }
  })();
}

export { main };

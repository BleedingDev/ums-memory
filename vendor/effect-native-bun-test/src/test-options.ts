import type {
  Test as BunTestGeneric,
  TestOptions as BunTestOptions,
} from "bun:test";

type BunTestFunction<T extends ReadonlyArray<unknown>> =
  BunTestGeneric<T> extends (
    label: string,
    fn: infer Fn,
    options?: number | BunTestOptions
  ) => void
    ? Fn
    : never;

declare module "bun:test" {
  interface TestOptions extends BunTestOptions {
    /**
     * Skip running the test when `true`.
     */
    readonly skip?: boolean;
  }

  interface Test<T extends ReadonlyArray<unknown>> {
    (label: string, options: TestOptions, fn: BunTestFunction<T>): void;
  }
}

export {};

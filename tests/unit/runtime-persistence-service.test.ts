import assert from "node:assert/strict";

import { test } from "@effect-native/bun-test";
import { Effect } from "effect";

import {
  ContractValidationError,
  RuntimePersistenceExecutionError,
} from "../../libs/shared/src/effect/errors.ts";
import type {
  RuntimePersistenceExecutionRequest,
  RuntimePersistenceRepository,
} from "../../libs/shared/src/effect/services/runtime-persistence-service.ts";
import {
  RuntimePersistenceServiceTag,
  deterministicTestRuntimePersistenceLayer,
  makeNoopRuntimePersistenceService,
  makeRuntimePersistenceServiceFromRepository,
} from "../../libs/shared/src/effect/services/runtime-persistence-service.ts";

const runEither = <T, E>(effect: Effect.Effect<T, E>) =>
  Effect.runPromise(
    Effect.result(effect).pipe(
      Effect.map((result) =>
        result._tag === "Failure"
          ? { _tag: "Left" as const, left: result.failure }
          : { _tag: "Right" as const, right: result.success }
      )
    )
  );

test("noop runtime persistence executes validated operation request", async () => {
  const service = makeNoopRuntimePersistenceService();

  const response = await Effect.runPromise(
    service.execute({
      operation: "Context",
      requestBody: { query: "recall deterministic profile guidance" },
      scopeKey: "tenant-2dc-runtime",
      execute: () => ({
        ok: true,
        operation: "context",
      }),
    })
  );

  assert.deepEqual(response, {
    ok: true,
    operation: "context",
  });
});

test("runtime persistence can delegate to repository implementation", async () => {
  const capturedRequests: RuntimePersistenceExecutionRequest[] = [];
  const repository: RuntimePersistenceRepository = {
    execute: <TResponse>(
      request: RuntimePersistenceExecutionRequest<TResponse>
    ) => {
      capturedRequests.push(request);
      return Effect.succeed({
        delegated: true,
        operation: request.operation,
      } as unknown as TResponse);
    },
  };

  const service = makeRuntimePersistenceServiceFromRepository(repository);
  const response = await Effect.runPromise(
    service.execute({
      operation: " InGeSt ",
      requestBody: { profile: "delegate-test" },
      scopeKey: "tenant-2dc-repository",
      execute: () => ({ delegated: false }),
    })
  );

  assert.deepEqual(response, {
    delegated: true,
    operation: "ingest",
  });
  assert.equal(capturedRequests.length, 1);
  assert.equal(capturedRequests[0]?.operation, "ingest");
  assert.equal(capturedRequests[0]?.scopeKey, "tenant-2dc-repository");

  const invalidResult = await runEither(
    service.execute({
      operation: " ",
      execute: () => ({ delegated: false }),
    })
  );
  assert.equal(invalidResult._tag, "Left");
  assert.ok(invalidResult.left instanceof ContractValidationError);
  assert.equal(capturedRequests.length, 1);
});

test("repository-backed runtime persistence surfaces execution errors", async () => {
  const repository: RuntimePersistenceRepository = {
    execute: () =>
      Effect.fail(
        new RuntimePersistenceExecutionError({
          operation: "context",
          message: "Runtime persistence executor failed.",
          details: "sqlite write timeout",
        })
      ),
  };
  const service = makeRuntimePersistenceServiceFromRepository(repository);

  const result = await runEither(
    service.execute({
      operation: "context",
      execute: () => ({ ok: true }),
    })
  );

  assert.equal(result._tag, "Left");
  assert.ok(result.left instanceof RuntimePersistenceExecutionError);
  assert.equal(result.left.operation, "context");
  assert.match(result.left.details, /sqlite write timeout/);
});

test("runtime persistence rejects empty operation names", async () => {
  const service = makeNoopRuntimePersistenceService();

  const result = await runEither(
    service.execute({
      operation: "  ",
      execute: () => ({ ok: true }),
    })
  );

  assert.equal(result._tag, "Left");
  assert.ok(result.left instanceof ContractValidationError);
  assert.equal(result.left.contract, "RuntimePersistenceExecutionRequest");
  assert.match(result.left.message, /non-empty string/i);
});

test("runtime persistence rejects requests without executor function", async () => {
  const service = makeNoopRuntimePersistenceService();

  const result = await runEither(
    service.execute({
      operation: "context",
    } as unknown as RuntimePersistenceExecutionRequest)
  );

  assert.equal(result._tag, "Left");
  assert.ok(result.left instanceof ContractValidationError);
  assert.equal(result.left.contract, "RuntimePersistenceExecutionRequest");
  assert.match(result.left.message, /executor function/i);
});

test("runtime persistence surfaces executor failures as execution errors", async () => {
  const service = makeNoopRuntimePersistenceService();

  const result = await runEither(
    service.execute({
      operation: "context",
      execute: () => {
        throw new Error("executor blew up");
      },
    })
  );

  assert.equal(result._tag, "Left");
  assert.ok(result.left instanceof RuntimePersistenceExecutionError);
  assert.equal(result.left.operation, "context");
  assert.match(result.left.details, /executor blew up/);
});

test("runtime persistence preserves tagged executor failures", async () => {
  const service = makeNoopRuntimePersistenceService();

  const result = await runEither(
    service.execute({
      operation: "context",
      execute: () =>
        Promise.reject(
          new RuntimePersistenceExecutionError({
            operation: "context",
            message: "Runtime persistence executor failed.",
            details: "sqlite write timeout",
          })
        ),
    })
  );

  assert.equal(result._tag, "Left");
  assert.ok(result.left instanceof RuntimePersistenceExecutionError);
  assert.equal(result.left.operation, "context");
  assert.match(result.left.details, /sqlite write timeout/);
});

test("deterministic runtime persistence layer wires RuntimePersistenceServiceTag", async () => {
  const response = await Effect.runPromise(
    Effect.gen(function* () {
      const runtimePersistenceService = yield* RuntimePersistenceServiceTag;
      return yield* runtimePersistenceService.execute({
        operation: "doctor",
        execute: () => ({ status: "ok" }),
      });
    }).pipe(Effect.provide(deterministicTestRuntimePersistenceLayer))
  );

  assert.deepEqual(response, { status: "ok" });
});

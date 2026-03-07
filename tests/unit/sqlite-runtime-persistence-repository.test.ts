import assert from "node:assert/strict";

import { test } from "@effect-native/bun-test";
import { Effect } from "effect";

import {
  ContractValidationError,
  RuntimePersistenceExecutionError,
} from "../../libs/shared/src/effect/errors.ts";
import { DatabaseSync } from "../../libs/shared/src/effect/storage/sqlite/database.ts";
import {
  makeSqliteRuntimePersistenceRepository,
  type SqliteRuntimePersistenceRepository,
} from "../../libs/shared/src/effect/storage/sqlite/index.ts";

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

const createDeterministicClock = (startAt = 1_700_000_000_000) => {
  let currentMillis = startAt;
  return () => {
    const nextMillis = currentMillis;
    currentMillis += 1;
    return nextMillis;
  };
};

const createSignal = () => {
  const state: { resolve: (() => void) | undefined } = {
    resolve: undefined,
  };

  return {
    promise: new Promise<void>((resolve) => {
      state.resolve = resolve;
    }),
    resolve: () => {
      state.resolve?.();
    },
  };
};

test("ums-memory-2dc.2: sqlite runtime persistence replays identical requests from the persisted ledger", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = makeSqliteRuntimePersistenceRepository(database, {
    now: createDeterministicClock(),
  });

  let executionCount = 0;
  const request = {
    operation: " Context ",
    requestBody: {
      limit: 3,
      query: "deterministic replay",
    },
    scopeKey: "tenant-a/profile-1",
    execute: () => {
      executionCount += 1;
      return {
        executionCount,
        items: ["alpha", "beta"],
        ok: true,
      };
    },
  };

  const firstResponse = await Effect.runPromise(repository.execute(request));
  const secondResponse = await Effect.runPromise(
    repository.execute({
      ...request,
      execute: () => {
        executionCount += 1;
        return {
          executionCount,
          items: ["unexpected"],
          ok: false,
        };
      },
    })
  );

  assert.deepEqual(firstResponse, {
    executionCount: 1,
    items: ["alpha", "beta"],
    ok: true,
  });
  assert.deepEqual(secondResponse, firstResponse);
  assert.equal(executionCount, 1);

  const persistedRows = await Effect.runPromise(
    repository.listPersistedExecutions()
  );
  assert.equal(persistedRows.length, 1);
  assert.equal(persistedRows[0]?.operation, "context");
  assert.equal(persistedRows[0]?.scopeKey, "tenant-a/profile-1");
  assert.deepEqual(persistedRows[0]?.requestBody, {
    limit: 3,
    query: "deterministic replay",
  });
  assert.deepEqual(persistedRows[0]?.response, firstResponse);
});

test("ums-memory-2dc.2: sqlite runtime persistence reads persisted entries with explicit deterministic ordering", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = makeSqliteRuntimePersistenceRepository(database, {
    now: createDeterministicClock(10),
  });

  await Effect.runPromise(
    repository.execute({
      operation: "reflect",
      requestBody: { candidateId: "candidate-c" },
      scopeKey: "tenant-b/profile-9",
      execute: () => ({ candidateId: "candidate-c", ok: true }),
    })
  );
  await Effect.runPromise(
    repository.execute({
      operation: "ingest",
      requestBody: { eventId: "event-a" },
      scopeKey: "tenant-a/profile-1",
      execute: () => ({ eventId: "event-a", ok: true }),
    })
  );
  await Effect.runPromise(
    repository.execute({
      operation: "context",
      requestBody: { query: "profile guidance" },
      scopeKey: "tenant-a/profile-1",
      execute: () => ({ ok: true, query: "profile guidance" }),
    })
  );

  const persistedRows = await Effect.runPromise(
    repository.listPersistedExecutions()
  );
  assert.deepEqual(
    persistedRows.map((entry) => [
      entry.scopeKey,
      entry.operation,
      entry.persistedAtMillis,
    ]),
    [
      ["tenant-a/profile-1", "context", 12],
      ["tenant-a/profile-1", "ingest", 11],
      ["tenant-b/profile-9", "reflect", 10],
    ]
  );
});

test("ums-memory-2dc.2: sqlite runtime persistence maps executor failures into RuntimePersistenceExecutionError without persisting a row", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = makeSqliteRuntimePersistenceRepository(database, {
    now: createDeterministicClock(),
  });

  const result = await runEither(
    repository.execute({
      operation: "doctor",
      requestBody: { check: "storage" },
      scopeKey: "tenant-a/profile-1",
      execute: () => {
        throw new Error("executor blew up");
      },
    })
  );

  assert.equal(result._tag, "Left");
  assert.ok(result.left instanceof RuntimePersistenceExecutionError);
  assert.equal(result.left.operation, "doctor");
  assert.match(result.left.details, /executor blew up/);

  const persistedRows = await Effect.runPromise(
    repository.listPersistedExecutions()
  );
  assert.equal(persistedRows.length, 0);
});

test("ums-memory-2dc.2: sqlite runtime persistence validates direct repository requests", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = makeSqliteRuntimePersistenceRepository(database);

  const result = await runEither(
    repository.execute({
      operation: "   ",
      execute: () => ({ ok: true }),
    })
  );

  assert.equal(result._tag, "Left");
  assert.ok(result.left instanceof ContractValidationError);
  assert.equal(result.left.contract, "RuntimePersistenceExecutionRequest");
});

test("ums-memory-2dc.2: sqlite runtime persistence treats null operation filter as unfiltered", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = makeSqliteRuntimePersistenceRepository(database, {
    now: createDeterministicClock(),
  });

  await Effect.runPromise(
    repository.execute({
      operation: "context",
      requestBody: { query: "route explain" },
      scopeKey: "tenant-c/profile-2",
      execute: () => ({ ok: true }),
    })
  );

  const persistedRows = await Effect.runPromise(
    repository.listPersistedExecutions({
      operation: null,
      scopeKey: "tenant-c/profile-2",
    })
  );

  assert.equal(persistedRows.length, 1);
  assert.equal(persistedRows[0]?.operation, "context");
});

test("ums-memory-2dc.2: sqlite runtime persistence treats null scopeKey filter as unfiltered", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = makeSqliteRuntimePersistenceRepository(database, {
    now: createDeterministicClock(),
  });

  await Effect.runPromise(
    repository.execute({
      operation: "context",
      requestBody: { query: "route explain" },
      scopeKey: "tenant-c/profile-2",
      execute: () => ({ ok: true }),
    })
  );
  await Effect.runPromise(
    repository.execute({
      operation: "reflect",
      requestBody: { query: "other scope" },
      scopeKey: "tenant-d/profile-3",
      execute: () => ({ ok: true }),
    })
  );

  const persistedRows = await Effect.runPromise(
    repository.listPersistedExecutions({
      operation: null,
      scopeKey: null,
    })
  );

  assert.equal(persistedRows.length, 2);
});

test("ums-memory-2dc.2: sqlite runtime persistence deduplicates identical parallel executions", async () => {
  const database = new DatabaseSync(":memory:");
  const repository = makeSqliteRuntimePersistenceRepository(database, {
    now: createDeterministicClock(),
  });

  let executionCount = 0;
  const executionStarted = createSignal();
  const releaseExecution = createSignal();

  const firstExecution = Effect.runPromise(
    repository.execute({
      operation: "context",
      requestBody: { query: "shared duplicate request" },
      scopeKey: "tenant-d/profile-7",
      execute: async () => {
        executionCount += 1;
        executionStarted.resolve();
        await releaseExecution.promise;
        return {
          executionCount,
          ok: true,
          source: "leader",
        };
      },
    })
  );

  await executionStarted.promise;

  const followerExecutions = Array.from({ length: 24 }, (_, index) =>
    Effect.runPromise(
      repository.execute({
        operation: "context",
        requestBody: { query: "shared duplicate request" },
        scopeKey: "tenant-d/profile-7",
        execute: () => {
          executionCount += 1;
          throw new Error(`follower-${index} should not execute`);
        },
      })
    )
  );

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  releaseExecution.resolve();

  const responses = await Promise.all([firstExecution, ...followerExecutions]);

  assert.deepEqual(
    responses,
    Array.from({ length: 25 }, () => ({
      executionCount: 1,
      ok: true,
      source: "leader",
    }))
  );
  assert.equal(executionCount, 1);

  const persistedRows = await Effect.runPromise(
    repository.listPersistedExecutions({
      operation: "context",
      scopeKey: "tenant-d/profile-7",
    })
  );
  assert.equal(persistedRows.length, 1);
  assert.deepEqual(persistedRows[0]?.response, {
    executionCount: 1,
    ok: true,
    source: "leader",
  });
});

test("ums-memory-2dc.5: sqlite runtime persistence stores and reloads deterministic snapshots", async () => {
  const database = new DatabaseSync(":memory:");
  const repository: SqliteRuntimePersistenceRepository =
    makeSqliteRuntimePersistenceRepository(database, {
      now: createDeterministicClock(500),
    });

  const initialSnapshot = await Effect.runPromise(
    repository.loadPersistedSnapshot()
  );
  assert.equal(initialSnapshot, null);

  const snapshot = {
    stores: {
      "coding-agent": {
        profiles: {
          "profile-a": {
            events: [
              {
                content: "persisted snapshot event",
                id: "evt-1",
                source: "test",
                type: "note",
              },
            ],
            rules: [],
          },
        },
      },
    },
  };

  await Effect.runPromise(repository.persistSnapshot(snapshot));

  const loadedSnapshot = await Effect.runPromise(
    repository.loadPersistedSnapshot()
  );
  assert.deepEqual(loadedSnapshot, snapshot);
});

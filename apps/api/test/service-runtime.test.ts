import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";

import { test } from "@effect-native/bun-test";

import {
  createSupervisedApiService,
  startSupervisedApiService,
} from "../src/service-runtime.ts";

function waitForPhase(service: any, expectedPhase: any, timeoutMs = 5000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const snapshot = service.status();
      if (snapshot.phase === expectedPhase) {
        clearInterval(interval);
        resolvePromise(snapshot);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        rejectPromise(
          new Error(
            `Timed out waiting for phase ${expectedPhase}. Current phase: ${snapshot.phase}`
          )
        );
      }
    }, 20);
    if (typeof interval.unref === "function") {
      interval.unref();
    }
  });
}

function listenOnEphemeralPort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createNetServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        rejectPromise(new Error("Failed to resolve occupied test port."));
        return;
      }
      resolvePromise({ server, port: address.port });
    });
  });
}

function closeNetServer(server: any) {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error: any) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    });
  });
}

function createMockServer({
  failAfterMs,
}: { readonly failAfterMs?: number } = {}) {
  const server = {
    listening: true,
    closeIdleConnections() {},
    closeAllConnections() {},
    unref() {},
    close(callback: any) {
      this.listening = false;
      if (typeof callback === "function") {
        callback(null);
      }
    },
  };
  if (
    typeof failAfterMs === "number" &&
    Number.isFinite(failAfterMs) &&
    failAfterMs >= 0
  ) {
    const timer = setTimeout(() => {
      server.listening = false;
    }, failAfterMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }
  return server;
}

test("supervised runtime starts, exposes status, and stops cleanly", async () => {
  const { service, host, port } = await startSupervisedApiService({
    host: "127.0.0.1",
    port: 0,
    stateFile: null,
    monitorIntervalMs: 20,
    restartDelayMs: 20,
    restartLimit: 0,
    captureProcessSignals: false,
  });

  try {
    assert.equal(host, "127.0.0.1");
    assert.equal(typeof port, "number");
    assert.ok(port > 0);
    const running = service.status();
    assert.equal(running.phase, "running");
    assert.equal(running.host, "127.0.0.1");
    assert.equal(running.port, port);
  } finally {
    await service.stop();
  }

  const stopped = service.status();
  assert.equal(stopped.phase, "stopped");
  assert.ok(stopped.stoppedAt);
});

test("supervised runtime fails fast before first bind when port is unavailable", async () => {
  const occupied = await listenOnEphemeralPort();
  const service = createSupervisedApiService({
    host: "127.0.0.1",
    port: (occupied as any).port,
    stateFile: null,
    monitorIntervalMs: 20,
    restartDelayMs: 20,
    restartLimit: 0,
    captureProcessSignals: false,
  });

  try {
    await service.start();
    await assert.rejects(service.ready(), /Failed to start API server/);
    const failed = await waitForPhase(service, "failed");
    assert.equal((failed as any).phase, "failed");
    assert.match((failed as any).lastError ?? "", /Failed to start API server/);
  } finally {
    await service.stop();
    await closeNetServer((occupied as any).server);
  }
});

test("supervised runtime cannot restart after a completed stop", async () => {
  let startCallCount = 0;
  const service = createSupervisedApiService({
    host: "127.0.0.1",
    port: 8787,
    stateFile: null,
    monitorIntervalMs: 20,
    restartDelayMs: 20,
    restartLimit: 0,
    captureProcessSignals: false,
    startServer: async ({ host, port }) => {
      startCallCount += 1;
      return {
        server: createMockServer(),
        host,
        port,
      };
    },
  });

  try {
    await service.start();
    await service.ready();
    assert.equal(startCallCount, 1);
    await service.stop();
    const stopped = service.status();
    assert.equal(stopped.phase, "stopped");
    await assert.rejects(service.start(), /cannot be restarted/);
  } finally {
    await service.stop();
  }
});

test("supervised runtime reports monitor failure after readiness without deferred completion errors", async () => {
  let startCallCount = 0;
  const service = createSupervisedApiService({
    host: "127.0.0.1",
    port: 8788,
    stateFile: null,
    monitorIntervalMs: 20,
    restartDelayMs: 20,
    restartLimit: 0,
    captureProcessSignals: false,
    startServer: async ({ host, port }) => {
      startCallCount += 1;
      return {
        server: createMockServer({ failAfterMs: 30 }),
        host,
        port,
      };
    },
  });

  try {
    await service.start();
    await service.ready();
    const failed = await waitForPhase(service, "failed");
    assert.equal(startCallCount, 1);
    assert.equal((failed as any).restartCount, 1);
    assert.match(
      (failed as any).lastError ?? "",
      /API server listener stopped unexpectedly/
    );
    assert.doesNotMatch(
      (failed as any).lastError ?? "",
      /Deferred already completed/
    );
  } finally {
    await service.stop();
  }
});

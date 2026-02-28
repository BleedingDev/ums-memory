import { executeOperation, resetStore } from "../src/core.mjs";

const ITERATIONS = Number.parseInt(process.env.UMS_BENCH_ITERATIONS ?? "5000", 10);
const PROFILE = "bench";

function bench(name, fn) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i += 1) {
    fn(i);
  }
  const elapsedNs = process.hrtime.bigint() - start;
  const elapsedMs = Number(elapsedNs) / 1e6;
  const opsPerSec = (ITERATIONS / elapsedMs) * 1000;
  return {
    operation: name,
    iterations: ITERATIONS,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    opsPerSec: Number(opsPerSec.toFixed(2))
  };
}

resetStore();
executeOperation("ingest", {
  profile: PROFILE,
  events: Array.from({ length: 50 }, (_, index) => ({
    type: "note",
    source: "bench",
    content: `seed event ${index}`
  }))
});

const results = [
  bench("context", (i) => {
    executeOperation("context", {
      profile: PROFILE,
      query: i % 2 === 0 ? "seed" : "event",
      limit: 5
    });
  }),
  bench("reflect", () => {
    executeOperation("reflect", {
      profile: PROFILE,
      maxCandidates: 3
    });
  }),
  bench("doctor", () => {
    executeOperation("doctor", {
      profile: PROFILE
    });
  })
];

process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);


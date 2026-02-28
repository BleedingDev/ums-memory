import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const REQUIRED_EPIC_IDS = Object.freeze([
  "ums-memory-k0x",
  "ums-memory-k0x.3",
  "ums-memory-k0x.4",
  "ums-memory-k0x.5",
  "ums-memory-k0x.6",
  "ums-memory-k0x.7",
  "ums-memory-k0x.8",
  "ums-memory-k0x.9",
  "ums-memory-k0x.10",
  "ums-memory-k0x.11",
  "ums-memory-k0x.12",
  "ums-memory-k0x.13",
  "ums-memory-k0x.14",
  "ums-memory-k0x.15",
  "ums-memory-k0x.16",
  "ums-memory-k0x.17",
  "ums-memory-k0x.18",
  "ums-memory-rkf",
  "ums-memory-rkf.2",
  "ums-memory-rkf.3",
  "ums-memory-rkf.4",
  "ums-memory-rkf.5",
  "ums-memory-rkf.6",
  "ums-memory-rkf.7",
  "ums-memory-rkf.8",
  "ums-memory-rkf.9",
  "ums-memory-rkf.10",
  "ums-memory-rkf.11",
  "ums-memory-rkf.12",
  "ums-memory-rkf.13",
  "ums-memory-rkf.14",
  "ums-memory-rkf.15",
  "ums-memory-rkf.16",
  "ums-memory-rkf.17",
]);

test("ADR-0001 maps all Phase 1/2 epic IDs and hard constraints", () => {
  const adrPath = new URL("../../docs/adr/0001-phase1-phase2-baseline-constraints.md", import.meta.url);
  const adr = readFileSync(adrPath, "utf8");

  for (const epicId of REQUIRED_EPIC_IDS) {
    assert.match(adr, new RegExp(`\\b${epicId.replaceAll(".", "\\.")}\\b`));
  }

  assert.match(adr, /backend-only/i);
  assert.match(adr, /local-first/i);
  assert.match(adr, /security defaults/i);
  assert.match(adr, /bounded recall/i);
  assert.match(adr, /no frontend/i);
});

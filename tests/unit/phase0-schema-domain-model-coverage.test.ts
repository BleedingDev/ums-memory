import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const RUNBOOK_PATH = path.resolve(
  process.cwd(),
  "docs/runbooks/phase0-effect-schema-domain-model.md"
);

const REQUIRED_SECTIONS = Object.freeze([
  "## SCH-01 Canonical Entity Inventory",
  "## SCH-02 Canonical IDs and Provenance Primitives",
  "## SCH-03 Normalized Adapter Session Envelope",
  "## SCH-04 Memory Candidate and Persisted Memory Contracts",
  "## SCH-05 Deterministic Dedupe Decision Artifacts",
  "## SCH-06 Retrieval Hits and Grounded Citations",
  "## SCH-07 Schema Evolution and Compatibility",
  "## SCH-08 Decoder Corpus and Property Coverage",
  "## SCH-09 Schema-Only Boundary Enforcement",
  "## SCH-10 Package Usage and Integration Examples",
]);

const REQUIRED_REFERENCES = Object.freeze([
  "AdapterSessionEnvelopeSchema",
  "DeterministicDedupeDecisionSchema",
  "GroundedAnswerCitationSchema",
  "SchemaEvolutionPolicySchema",
  "validate-schema-boundaries",
  "effect-schema-domain-model-contract.test.ts",
]);

test("phase0 effect schema domain model runbook covers SCH-01..SCH-10 sections", () => {
  const content = readFileSync(RUNBOOK_PATH, "utf8");

  for (const section of REQUIRED_SECTIONS) {
    assert.match(
      content,
      new RegExp(section.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
      `Missing required runbook section: ${section}`
    );
  }
});

test("phase0 effect schema domain model runbook references required contracts and validation evidence", () => {
  const content = readFileSync(RUNBOOK_PATH, "utf8");

  for (const reference of REQUIRED_REFERENCES) {
    assert.match(
      content,
      new RegExp(reference.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"),
      `Missing required runbook reference: ${reference}`
    );
  }
});

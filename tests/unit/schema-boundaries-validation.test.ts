import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  main,
  validateSchemaBoundaries,
} from "../../scripts/validate-schema-boundaries.ts";

async function writeBoundaryFile(
  projectRoot: string,
  relativePath: string,
  source: string
) {
  const absolutePath = resolve(projectRoot, relativePath);
  await mkdir(resolve(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, source, "utf8");
}

test("schema boundary validation passes for current repository", async () => {
  const result = await validateSchemaBoundaries();
  assert.equal(result.ok, true);
  assert.ok(result.checkedFiles > 0);
  assert.deepEqual(result.violations, []);
});

test("schema boundary validation rejects zod imports in adapter edge files", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "schema-boundaries-zod-")
  );

  try {
    await writeBoundaryFile(
      projectRoot,
      "apps/api/src/handler.ts",
      'import { z } from "zod";\nexport const handler = () => z.string();\n'
    );

    const result = await validateSchemaBoundaries({ projectRoot });
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]?.ruleId, "no-zod-imports");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("schema boundary validation rejects direct decodeUnknown at edge files", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "schema-boundaries-decode-")
  );

  try {
    await writeBoundaryFile(
      projectRoot,
      "apps/cli/src/program.ts",
      'import { Schema } from "effect";\nexport const parse = (input: unknown) => Schema.decodeUnknownSync(Schema.String)(input);\n'
    );

    const result = await validateSchemaBoundaries({ projectRoot });
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]?.ruleId, "no-direct-schema-decoding");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("schema boundary validation scans mts boundary files", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "schema-boundaries-mts-")
  );

  try {
    await writeBoundaryFile(
      projectRoot,
      "apps/ums/src/index.mts",
      'import { z } from "zod";\nexport const broken = z.string();\n'
    );

    const result = await validateSchemaBoundaries({ projectRoot });
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]?.ruleId, "no-zod-imports");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("schema boundary validation CLI main returns failure on any arguments", async () => {
  const code = await main(["--does-not-exist"]);
  assert.equal(code, 1);
});

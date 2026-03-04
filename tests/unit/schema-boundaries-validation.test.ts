import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("ums-memory-y9m.9: schema boundary validation passes for current repository", async () => {
  const result = await validateSchemaBoundaries();
  assert.equal(result.ok, true);
  assert.ok(result.checkedFiles > 0);
  assert.deepEqual(result.violations, []);
});

test("ums-memory-y9m.9: schema boundary validator scans all default edge directories", async () => {
  const projectRoot = await mkdtemp(
    resolve(tmpdir(), "schema-boundaries-default-roots-")
  );

  try {
    await writeBoundaryFile(
      projectRoot,
      "apps/api/src/handler.ts",
      'import { z } from "zod";\nexport const api = () => z.string();\n'
    );
    await writeBoundaryFile(
      projectRoot,
      "apps/cli/src/program.ts",
      'import { Schema } from "effect";\nexport const cli = (input: unknown) => Schema.decodeUnknownSync(Schema.String)(input);\n'
    );
    await writeBoundaryFile(
      projectRoot,
      "apps/ums/src/server.ts",
      'import { z } from "zod";\nexport const ums = () => z.string();\n'
    );

    const result = await validateSchemaBoundaries({ projectRoot });
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 3);
    assert.equal(
      result.violations
        .map((violation) => violation.file)
        .sort()
        .join(","),
      [
        "apps/api/src/handler.ts",
        "apps/cli/src/program.ts",
        "apps/ums/src/server.ts",
      ].join(",")
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
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

test("ums-memory-y9m.9: schema boundary validation CLI supports json output mode", async () => {
  const code = await main(["--json"]);
  assert.equal(code, 0);
});

test("ums-memory-y9m.9: schema boundary validation CLI --json emits parseable validation payload", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/validate-schema-boundaries.ts", "--json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as {
    readonly schemaVersion?: string;
    readonly ok?: boolean;
    readonly checkedFiles?: number;
    readonly violations?: readonly unknown[];
  };
  assert.equal(parsed.schemaVersion, "schema_boundaries_validation.v1");
  assert.equal(typeof parsed.ok, "boolean");
  assert.equal(Array.isArray(parsed.violations), true);
  assert.ok((parsed.checkedFiles ?? 0) > 0);
});

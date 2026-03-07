import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { test } from "@effect-native/bun-test";
import { Schema } from "effect";

import {
  canonicalizeDaemonConfig,
  explainDaemonRouteResolution,
  parseJsonc,
  readDaemonConfig,
  serializeDaemonConfig,
  writeDaemonConfig,
} from "../../ums/src/daemon-config.ts";

const isDaemonConfigError = Schema.is(
  Schema.Struct({
    _tag: Schema.Literal("DaemonConfigError"),
    code: Schema.String,
    message: Schema.String,
    issues: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        message: Schema.String,
      })
    ),
  })
);

test("daemon config loader accepts JSONC comments and trailing commas", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-daemon-config-"));
  const configFile = resolve(tempDir, "config.jsonc");
  try {
    const written = await writeDaemonConfig(
      configFile,
      parseJsonc(`{
        // comment
        "version": 1,
        "accounts": {
          "company": {
            "type": "http",
            "apiBaseUrl": "https://ums.company.internal/",
            "auth": {
              "mode": "oauth-device",
              "credentialRef": "keychain://ums/company",
            },
          },
          "local": {
            "type": "local",
          },
        },
        "memories": {
          "personal": {
            "account": "local",
            "storeId": "personal",
            "profile": "main",
          },
          "company-new-engine": {
            "account": "company",
            "storeId": "coding-agent",
            "profile": "developer-main",
            "project": "new-engine",
          },
        },
        "routes": [
          {
            "match": {
              "repoRoot": "./new-engine/",
              "source": "cursor",
            },
            "memory": "company-new-engine",
            "priority": 10,
          },
          {
            "match": {
              "pathPrefix": "./",
            },
            "memory": "personal",
          },
        ],
        "sources": {
          "cursor": {
            "roots": ["./cursor"],
          },
          "opencode": {
            "roots": ["./opencode"],
          },
        },
        "defaults": {
          "memory": "personal",
          "onAmbiguous": "review",
        },
      }`)
    );

    const companyAccount = written.config.accounts["company"];
    assert.ok(companyAccount);
    assert.equal(companyAccount.type, "http");
    if (companyAccount.type !== "http") {
      throw new Error("Expected http account.");
    }
    assert.equal(companyAccount.apiBaseUrl, "https://ums.company.internal");
    assert.deepEqual(written.config.sources.cursor?.roots, [
      resolve(tempDir, "cursor"),
    ]);
    assert.deepEqual(written.config.sources.opencode?.roots, [
      resolve(tempDir, "opencode"),
    ]);
    assert.equal(written.config.routes[0]?.match.source, "cursor");
    assert.equal(
      written.config.routes[0]?.match.repoRoot,
      resolve(tempDir, "new-engine")
    );
    assert.equal(written.config.routes[1]?.match.pathPrefix, resolve(tempDir));

    const loaded = await readDaemonConfig(configFile);
    assert.deepEqual(loaded.config, written.config);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("daemon config validator rejects broken cross references", () => {
  assert.throws(
    () =>
      canonicalizeDaemonConfig({
        version: 1,
        accounts: {
          local: {
            type: "local",
          },
        },
        memories: {
          personal: {
            account: "missing",
            storeId: "personal",
            profile: "main",
          },
        },
        routes: [
          {
            match: {
              pathPrefix: "/tmp/project",
            },
            memory: "other",
          },
        ],
        defaults: {
          memory: "other",
          onAmbiguous: "review",
        },
      }),
    (error: unknown) => {
      const daemonConfigError = isDaemonConfigError(error) ? error : null;
      assert.ok(daemonConfigError);
      if (!daemonConfigError) {
        return false;
      }
      assert.equal(daemonConfigError.code, "DAEMON_CONFIG_VALIDATION_ERROR");
      assert.match(daemonConfigError.message, /validation failed/i);
      assert.equal(daemonConfigError.issues.length >= 3, true);
      return true;
    }
  );
});

test("daemon config writer canonicalizes ordering and emits stable JSON", async () => {
  const tempDir = await mkdtemp(resolve(tmpdir(), "ums-daemon-config-"));
  const configFile = resolve(tempDir, "config.jsonc");
  try {
    const config = canonicalizeDaemonConfig({
      version: 1,
      accounts: {
        zlocal: {
          type: "local",
        },
        company: {
          type: "http",
          apiBaseUrl: "https://ums.company.internal",
          auth: {
            mode: "token-env",
            env: "UMS_COMPANY_TOKEN",
          },
        },
      },
      memories: {
        zmemory: {
          account: "zlocal",
          storeId: "personal",
          profile: "main",
        },
        company: {
          account: "company",
          storeId: "coding-agent",
          profile: "developer-main",
        },
      },
      routes: [
        {
          match: {
            pathPrefix: "/tmp",
          },
          memory: "zmemory",
        },
        {
          match: {
            repoRoot: "/tmp/company",
          },
          memory: "company",
          priority: 5,
        },
      ],
      defaults: {
        memory: "zmemory",
        onAmbiguous: "default",
      },
      policy: {
        allowEnvTokenFallback: true,
      },
    });

    const first = serializeDaemonConfig(config);
    await writeDaemonConfig(configFile, config);
    const second = await readFile(configFile, "utf8");

    assert.equal(second, first);
    assert.match(
      second,
      /"accounts": \{\n {4}"company": \{\n      "type": "http"/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("daemon route resolution prefers higher-priority specific matches and review fallback", () => {
  const config = canonicalizeDaemonConfig({
    version: 1,
    accounts: {
      local: { type: "local" },
    },
    memories: {
      personal: {
        account: "local",
        storeId: "personal",
        profile: "main",
      },
      company: {
        account: "local",
        storeId: "company",
        profile: "main",
      },
    },
    routes: [
      {
        match: {
          pathPrefix: "/tmp/projects",
        },
        memory: "personal",
        priority: 0,
      },
      {
        match: {
          pathPrefix: "/tmp/projects/new-engine",
          source: "cursor",
        },
        memory: "company",
        priority: 20,
      },
    ],
    defaults: {
      memory: "personal",
      onAmbiguous: "review",
    },
  });

  const matched = explainDaemonRouteResolution(config, {
    path: "/tmp/projects/new-engine/src/index.ts",
    source: "cursor",
  });
  assert.equal(matched.status, "matched");
  assert.equal(matched.memory, "company");
  assert.equal(matched.candidates.length, 2);
  assert.equal(matched.candidates[0]?.route.match.source, "cursor");

  const unmatched = explainDaemonRouteResolution(config, {
    path: "/var/tmp/elsewhere.ts",
  });
  assert.equal(unmatched.status, "review");
  assert.equal(unmatched.memory, null);
});

test("daemon route resolution matches windows-style path prefixes deterministically", () => {
  const config = canonicalizeDaemonConfig({
    version: 1,
    accounts: {
      local: { type: "local" },
    },
    memories: {
      personal: {
        account: "local",
        storeId: "personal",
        profile: "main",
      },
      company: {
        account: "local",
        storeId: "company",
        profile: "main",
      },
    },
    routes: [
      {
        match: {
          pathPrefix: "C:\\Users\\satan\\Developer",
        },
        memory: "personal",
        priority: 0,
      },
      {
        match: {
          pathPrefix: "C:\\Users\\satan\\Developer\\new-engine",
        },
        memory: "company",
        priority: 20,
      },
    ],
    defaults: {
      memory: "personal",
      onAmbiguous: "review",
    },
  });

  const matched = explainDaemonRouteResolution(config, {
    path: "C:\\Users\\satan\\Developer\\new-engine\\src\\index.ts",
  });
  assert.equal(matched.status, "matched");
  assert.equal(matched.memory, "company");
  assert.equal(matched.candidates.length, 2);
});

test("daemon config canonicalizes source bindings with generated ids", () => {
  const configRoot = resolve(tmpdir(), "ums-daemon-source-bindings");
  const config = canonicalizeDaemonConfig(
    {
      version: 1,
      accounts: {
        local: { type: "local" },
      },
      memories: {
        personal: {
          account: "local",
          storeId: "personal",
          profile: "main",
        },
      },
      sources: {
        bindings: [
          {
            source: "plan",
            path: "./PLAN.md",
            status: "pending",
            label: "Repo plan",
            health: "ready",
            lastSeenAt: "2026-03-07T00:00:00.000Z",
          },
          {
            source: "codex",
            path: "./codex-history",
          },
        ],
      },
      routes: [
        {
          match: {
            pathPrefix: "./",
          },
          memory: "personal",
        },
      ],
      defaults: {
        memory: "personal",
        onAmbiguous: "default",
      },
    },
    {
      configFile: resolve(configRoot, "config.jsonc"),
    }
  );

  const codexBinding = config.sources.bindings.find(
    (binding) => binding.source === "codex"
  );
  assert.ok(codexBinding);
  assert.equal(codexBinding?.kind, "directory");
  assert.equal(codexBinding?.status, "approved");
  assert.equal(codexBinding?.path, resolve(configRoot, "codex-history"));
  assert.match(codexBinding?.id ?? "", /^src_[a-f0-9]{16}$/);

  const planBinding = config.sources.bindings.find(
    (binding) => binding.source === "plan"
  );
  assert.ok(planBinding);
  assert.equal(planBinding?.kind, "file");
  assert.equal(planBinding?.status, "pending");
  assert.equal(planBinding?.label, "Repo plan");
  assert.equal(planBinding?.health, "ready");
  assert.equal(planBinding?.lastSeenAt, "2026-03-07T00:00:00.000Z");
  assert.equal(planBinding?.path, resolve(configRoot, "PLAN.md"));
});

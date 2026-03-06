import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  DaemonConfigError,
  canonicalizeDaemonConfig,
  explainDaemonRouteResolution,
  parseJsonc,
  readDaemonConfig,
  serializeDaemonConfig,
  writeDaemonConfig,
} from "../../ums/src/daemon-config.ts";

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
              "pathPrefix": "./",
            },
            "memory": "personal",
          },
          {
            "match": {
              "repoRoot": "./new-engine/",
            },
            "memory": "company-new-engine",
            "priority": 10,
          },
        ],
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
    assert.equal(
      companyAccount.apiBaseUrl,
      "https://ums.company.internal"
    );
    assert.equal(
      written.config.routes[0]?.match.repoRoot,
      resolve(process.cwd(), "new-engine")
    );
    assert.equal(
      written.config.routes[1]?.match.pathPrefix,
      resolve(process.cwd())
    );

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
      const daemonConfigError =
        error instanceof DaemonConfigError ? error : null;
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
      /"accounts": \{\n    "company": \{\n      "type": "http"/
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
  });
  assert.equal(matched.status, "matched");
  assert.equal(matched.memory, "company");
  assert.equal(matched.candidates.length, 2);

  const unmatched = explainDaemonRouteResolution(config, {
    path: "/var/tmp/elsewhere.ts",
  });
  assert.equal(unmatched.status, "review");
  assert.equal(unmatched.memory, null);
});

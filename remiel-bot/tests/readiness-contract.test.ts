import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isMainModule } from "../src/index.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const botRoot = resolve(testDir, "..");
const root = resolve(botRoot, "..");
const readinessContract = JSON.parse(
  readFileSync(resolve(root, "readiness-contract.json"), "utf8"),
) as {
  schema_version: string;
  service: string;
  marker: string;
  ready: string;
};

function runBootstrapProbe(suppressMarker = false) {
  const entryUrl = pathToFileURL(resolve(botRoot, "src/index.ts")).href;
  const probe = `
    import { main, READINESS_MARKER, HANIEL_READY_CONDITION } from ${JSON.stringify(entryUrl)};
    const productLog = console.log.bind(console);
    if (${JSON.stringify(suppressMarker)}) {
      console.log = (...values) => {
        if (values[0] !== READINESS_MARKER) productLog(...values);
      };
    }
    await main({
      createSlackApp: async () => {
        console.log("HANDLERS_REGISTERED");
        return {
          client: {},
          start: async () => console.log("SOCKET_CONNECTED"),
        };
      },
    });
    console.log("READINESS_CONTRACT=" + JSON.stringify({
      markerHex: Buffer.from(READINESS_MARKER, "utf8").toString("hex"),
      conditionHex: Buffer.from(HANIEL_READY_CONDITION, "utf8").toString("hex"),
    }));
    setTimeout(() => process.exit(0), 0);
  `;
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", probe],
    {
      cwd: botRoot,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        SLACK_BOT_TOKEN: "xoxb-readiness-contract",
        SLACK_APP_TOKEN: "xapp-readiness-contract",
        WORKSPACE_DIR: mkdtempSync(join(tmpdir(), "remiel-readiness-")),
        RESPONSE_ENABLED: "false",
      },
    },
  );
}

function assertBootstrapContract(result: ReturnType<typeof runBootstrapProbe>) {
  const observed = `${result.stdout}${result.stderr}`;
  expect(result.status, observed).toBe(0);
  const contractMatch = /^READINESS_CONTRACT=(.*)$/m.exec(result.stdout);
  expect(contractMatch, observed).not.toBeNull();
  const encoded = JSON.parse(contractMatch![1]) as {
    markerHex: string;
    conditionHex: string;
  };
  const marker = Buffer.from(encoded.markerHex, "hex").toString("utf8");
  const condition = Buffer.from(encoded.conditionHex, "hex").toString("utf8");
  expect(condition.startsWith("log:")).toBe(true);
  expect(new RegExp(condition.slice(4)).test(marker)).toBe(true);
  expect(observed).toContain(marker);
  expect(result.stdout.indexOf("HANDLERS_REGISTERED")).toBeLessThan(
    result.stdout.indexOf("SOCKET_CONNECTED"),
  );
  expect(result.stdout.indexOf("SOCKET_CONNECTED")).toBeLessThan(
    result.stdout.indexOf(marker),
  );
  expect(result.stderr).not.toContain("Fatal error");
}

describe("Haniel readiness marker contract", () => {
  it("publishes a machine-readable contract independent of source constants", async () => {
    const { READINESS_MARKER, HANIEL_READY_CONDITION } = await import(
      "../src/readiness.js"
    );
    expect(readinessContract).toEqual({
      schema_version: "haniel.readiness-contract.v1",
      service: "remiel",
      marker: READINESS_MARKER,
      ready: HANIEL_READY_CONDITION,
    });
  });

  it("observes the product bootstrap after handlers and Socket Mode start", () => {
    assertBootstrapContract(runBootstrapProbe());
  });

  it("fails the contract when product marker emission is suppressed", () => {
    expect(() => assertBootstrapContract(runBootstrapProbe(true))).toThrow();
  });

  it("recognizes a symlink argv path as the ESM entrypoint", () => {
    const directory = mkdtempSync(join(tmpdir(), "remiel-entrypoint-"));
    const link = join(directory, "remiel.ts");
    symlinkSync(resolve(botRoot, "src/index.ts"), link, "file");
    expect(isMainModule(link)).toBe(true);
  });

  it("runs CI for every readiness contract input with minimum permissions", () => {
    const workflow = readFileSync(
      resolve(root, ".github/workflows/readiness-contract.yml"),
      "utf8",
    );
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("schedule:");
    for (const path of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "remiel-bot/package.json",
      "remiel-bot/src/index.ts",
      "remiel-bot/src/readiness.ts",
      "remiel-bot/tests/readiness-contract.test.ts",
      ".github/workflows/readiness-contract.yml",
      "readiness-contract.json",
    ]) {
      expect(workflow).toContain(path);
    }
  });
});

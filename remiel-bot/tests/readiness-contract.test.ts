import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const botRoot = resolve(testDir, "..");
const root = resolve(botRoot, "..");

function runBootstrapProbe() {
  const entryUrl = pathToFileURL(resolve(botRoot, "src/index.ts")).href;
  const probe = `
    import { main, READINESS_MARKER, HANIEL_READY_CONDITION } from ${JSON.stringify(entryUrl)};
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
      marker: READINESS_MARKER,
      condition: HANIEL_READY_CONDITION,
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

describe("Haniel readiness marker contract", () => {
  it("observes the product bootstrap after handlers and Socket Mode start", () => {
    const result = runBootstrapProbe();
    const observed = `${result.stdout}${result.stderr}`;

    expect(result.status, observed).toBe(0);
    const contractMatch = /^READINESS_CONTRACT=(.*)$/m.exec(result.stdout);
    expect(contractMatch, observed).not.toBeNull();
    const contract = JSON.parse(contractMatch![1]) as {
      marker: string;
      condition: string;
    };
    expect(contract.condition.startsWith("log:")).toBe(true);
    expect(new RegExp(contract.condition.slice(4)).test(contract.marker)).toBe(true);
    expect(observed).toContain(contract.marker);
    expect(result.stdout.indexOf("HANDLERS_REGISTERED")).toBeLessThan(
      result.stdout.indexOf("SOCKET_CONNECTED"),
    );
    expect(result.stdout.indexOf("SOCKET_CONNECTED")).toBeLessThan(
      result.stdout.indexOf(contract.marker),
    );
    expect(result.stderr).not.toContain("Fatal error");
  });

  it("runs CI for every readiness contract input with minimum permissions", () => {
    const workflow = readFileSync(
      resolve(root, ".github/workflows/readiness-contract.yml"),
      "utf8",
    );
    expect(workflow).toContain("permissions:\n  contents: read");
    for (const path of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "remiel-bot/package.json",
      "remiel-bot/src/index.ts",
      "remiel-bot/src/readiness.ts",
      "remiel-bot/tests/readiness-contract.test.ts",
      ".github/workflows/readiness-contract.yml",
    ]) {
      expect(workflow).toContain(path);
    }
  });
});

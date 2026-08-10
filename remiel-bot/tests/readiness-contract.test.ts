import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const botRoot = resolve(testDir, "..");
const root = resolve(botRoot, "..");

describe("Haniel readiness marker contract", () => {
  it("emits the application marker only after Slack Bolt start resolves", () => {
    const source = readFileSync(resolve(botRoot, "src/index.ts"), "utf8");
    const start = source.indexOf("await app.start();");
    const marker = source.indexOf("console.log(`[Remiel] Bot is running!`);");

    expect(start).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(start);
    expect(source.indexOf("main().catch", marker)).toBeGreaterThan(marker);
  });

  it("binds the marker to the declared and locked Slack Bolt SDK", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(botRoot, "package.json"), "utf8"),
    );
    const lock = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");

    expect(manifest.dependencies["@slack/bolt"]).toBe("^4.6.0");
    expect(lock).toContain("'@slack/bolt@4.7.0'");
  });

  it("runs CI for every readiness contract input", () => {
    const workflow = readFileSync(
      resolve(root, ".github/workflows/readiness-contract.yml"),
      "utf8",
    );
    for (const path of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "remiel-bot/package.json",
      "remiel-bot/src/index.ts",
      "remiel-bot/src/slack.ts",
      "remiel-bot/tests/readiness-contract.test.ts",
      ".github/workflows/readiness-contract.yml",
    ]) {
      expect(workflow).toContain(path);
    }
  });
});

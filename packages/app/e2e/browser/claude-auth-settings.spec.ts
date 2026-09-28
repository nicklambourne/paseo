import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { openSettingsHost, openSettingsHostSection } from "../support/helpers/settings";

const fixtureDir = mkdtempSync(join(tmpdir(), "paseo-claude-auth-browser-"));
const authMarker = join(fixtureDir, "connected");
writeFileSync(
  join(fixtureDir, "claude"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const command = process.argv.slice(2).join(" ");
if (command === "auth status") process.exit(fs.existsSync(process.env.CLAUDE_TEST_AUTH_MARKER) ? 0 : 1);
if (command === "auth login --claudeai") {
  process.stdout.write("Visit https://claude.com/oauth/authorize?test=1\\nPaste code here if prompted > ");
  process.stdin.once("data", (chunk) => {
    if (chunk.toString().trim() === "valid") {
      fs.writeFileSync(process.env.CLAUDE_TEST_AUTH_MARKER, "yes");
      process.exit(0);
    }
    process.exit(1);
  });
  return;
}
if (command === "--version") {
  process.stdout.write("2.1.223 (Claude Code)\\n");
  process.exit(0);
}
process.exit(1);
`,
  { mode: 0o755 },
);
if (process.platform === "win32") {
  writeFileSync(join(fixtureDir, "claude.cmd"), '@node "%~dp0claude" %*\r\n');
}
process.on("exit", () => rmSync(fixtureDir, { recursive: true, force: true }));

test.use({
  e2eDaemonEnvironment: {
    PATH: `${fixtureDir}${delimiter}${process.env.PATH ?? ""}`,
    CLAUDE_TEST_AUTH_MARKER: authMarker,
  },
});

async function openClaudeSettings(page: Page) {
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, getServerId());
  await openSettingsHostSection(page, getServerId(), "providers");
  await page.getByRole("button", { name: "Claude provider details" }).click();
  await expect(page.getByTestId("claude-auth-panel")).toBeVisible();
}

test.beforeEach(({ e2eDaemonEnvironment }) =>
  rmSync(e2eDaemonEnvironment.CLAUDE_TEST_AUTH_MARKER, { force: true }),
);

test("connects Claude Code from provider settings", async ({ page }) => {
  await openClaudeSettings(page);
  await page.getByRole("button", { name: "Connect Claude Code" }).click();
  await expect(page.getByTestId("claude-auth-url")).toContainText(
    "https://claude.com/oauth/authorize?test=1",
  );
  await page.getByTestId("claude-auth-code").fill("valid");
  await page.getByRole("button", { name: "Submit code" }).click();
  await expect(page.getByText("Claude Code is connected on this host")).toBeVisible();
});

test("shows a retry action when Claude rejects the code", async ({ page }) => {
  await openClaudeSettings(page);
  await page.getByRole("button", { name: "Connect Claude Code" }).click();
  await expect(page.getByTestId("claude-auth-url")).toBeVisible();
  await page.getByTestId("claude-auth-code").fill("invalid");
  await page.getByRole("button", { name: "Submit code" }).click();
  await expect(page.getByText("Claude sign-in did not complete. Try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Claude Code" })).toBeEnabled();
});

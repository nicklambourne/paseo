import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { openSettingsHost, openSettingsHostSection } from "../support/helpers/settings";

const fixtureDir = mkdtempSync(join(tmpdir(), "paseo-codex-auth-browser-"));
const authMarker = join(fixtureDir, "connected");
writeFileSync(
  join(fixtureDir, "codex"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const command = process.argv.slice(2).join(" ");
if (command === "login status") process.exit(fs.existsSync(process.env.CODEX_TEST_AUTH_MARKER) ? 0 : 1);
if (command === "login --device-auth") {
  process.stdout.write("Open this link in your browser\\nhttps://auth.openai.com/codex/device\\nEnter this one-time code\\nABCD-EFGH\\n");
  const timer = setInterval(() => {
    if (fs.existsSync(process.env.CODEX_TEST_AUTH_MARKER)) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 20);
  return;
}
if (command === "--version") {
  process.stdout.write("codex-cli 0.146.0\\n");
  process.exit(0);
}
process.exit(1);
`,
  { mode: 0o755 },
);
if (process.platform === "win32") {
  writeFileSync(join(fixtureDir, "codex.cmd"), '@node "%~dp0codex" %*\r\n');
}
process.on("exit", () => rmSync(fixtureDir, { recursive: true, force: true }));

test.use({
  e2eDaemonEnvironment: {
    PATH: `${fixtureDir}${delimiter}${process.env.PATH ?? ""}`,
    CODEX_TEST_AUTH_MARKER: authMarker,
  },
});

async function openCodexSettings(page: Page) {
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHost(page, getServerId());
  await openSettingsHostSection(page, getServerId(), "providers");
  await page.getByRole("button", { name: "Codex provider details" }).click();
  await expect(page.getByTestId("codex-auth-panel")).toBeVisible();
}

test.beforeEach(({ e2eDaemonEnvironment }) =>
  rmSync(e2eDaemonEnvironment.CODEX_TEST_AUTH_MARKER, { force: true }),
);

test("connects Codex from provider settings", async ({ page }) => {
  await openCodexSettings(page);
  await page.getByRole("button", { name: "Connect Codex" }).click();
  await expect(page.getByTestId("codex-auth-url")).toContainText(
    "https://auth.openai.com/codex/device",
  );
  await expect(page.getByTestId("codex-auth-code")).toContainText("ABCD-EFGH");
  writeFileSync(authMarker, "yes");
  await expect(page.getByText("Codex is connected on this host")).toBeVisible();
});

test("cancels an unfinished Codex sign-in", async ({ page }) => {
  await openCodexSettings(page);
  await page.getByRole("button", { name: "Connect Codex" }).click();
  await expect(page.getByTestId("codex-auth-code")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Connect Codex" })).toBeVisible();
});

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "../support/fixtures";
import {
  addProjectFlow,
  chooseAddProjectMethod,
  openAddProjectFlow,
} from "../support/helpers/add-project-flow";
import { gotoAppShell } from "../support/helpers/app";

const ghConfigDir = path.join(tmpdir(), `paseo-e2e-gh-device-auth-${process.pid}`);

test.use({
  e2eDaemonEnvironment: {
    PASEO_E2E_GH_UNAUTHENTICATED: "1",
    GH_CONFIG_DIR: ghConfigDir,
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
  },
  channel: process.env.E2E_USE_SYSTEM_CHROME === "1" ? "chrome" : undefined,
});

test.afterAll(async () => {
  await rm(ghConfigDir, { recursive: true, force: true });
});

test("offers GitHub sign-in in the repository picker when the host is unauthenticated", async ({
  page,
}) => {
  await gotoAppShell(page);
  await openAddProjectFlow(page);
  await chooseAddProjectMethod(page, "github");

  const prompt = addProjectFlow(page).getByTestId("github-device-auth-prompt");
  await expect(prompt).toBeVisible();
  await expect(prompt.getByTestId("github-device-auth-connect")).toBeVisible();
  await expect(addProjectFlow(page)).not.toContainText("Run gh auth login on the host");

  await prompt.getByTestId("github-device-auth-connect").click();
  await expect(prompt.getByTestId("github-device-auth-code")).toHaveText("ABCD-1234");
  await expect(prompt.getByTestId("github-device-auth-open")).toBeVisible();
  await prompt.getByTestId("github-device-auth-cancel").click();
  await expect(prompt.getByTestId("github-device-auth-connect")).toBeVisible();
});

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createCodexAuth } from "./codex-auth.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paseo-codex-auth-"));
  await writeFile(
    join(directory, "login.cjs"),
    `process.stdout.write('Follow these steps to sign in with ChatGPT using device code authorization:\\n1. Open this link in your browser\\nhttps://auth.openai.com/codex/device\\n2. Enter this one-time code\\nABCD-EFGH\\n');
const timer = setInterval(() => {
  if (require('node:fs').existsSync(process.argv[2])) {
    clearInterval(timer);
    process.exit(0);
  }
}, 10);`,
  );
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function auth() {
  const marker = join(directory, "connected");
  return createCodexAuth({
    checkAuth: async () => {
      try {
        return (await readFile(marker, "utf8")) === "connected";
      } catch {
        return false;
      }
    },
    spawnLogin: () => spawn(process.execPath, [join(directory, "login.cjs"), marker]),
  });
}

async function waitForStatus(service: ReturnType<typeof auth>, status: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = await service.handle("status");
    if (state.status === status) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Codex auth never reached ${status}`);
}

it("shows the device link and code, then detects completed login", async () => {
  const service = auth();
  try {
    expect(await service.handle("start")).toEqual({ status: "starting" });
    expect(await waitForStatus(service, "pending")).toEqual({
      status: "pending",
      url: "https://auth.openai.com/codex/device",
      code: "ABCD-EFGH",
    });
    const marker = join(directory, "connected");
    await writeFile(marker, "connected");
    expect(await waitForStatus(service, "connected")).toEqual({ status: "connected" });
  } finally {
    service.cancel();
  }
});

it("cancels an unfinished login", async () => {
  const service = auth();
  await service.handle("start");
  await waitForStatus(service, "pending");
  expect(await service.handle("cancel")).toEqual({ status: "disconnected" });
  expect(await service.handle("status")).toEqual({ status: "disconnected" });
});

it("does not let an older status check replace a newly started login", async () => {
  const pendingChecks: Array<(signedIn: boolean) => void> = [];
  const service = createCodexAuth({
    checkAuth: () => new Promise<boolean>((resolve) => pendingChecks.push(resolve)),
    spawnLogin: () =>
      spawn(process.execPath, [join(directory, "login.cjs"), join(directory, "connected")]),
  });
  const status = service.handle("status");
  const start = service.handle("start");
  pendingChecks[0]!(false);
  expect(await status).toEqual({ status: "starting" });
  pendingChecks[1]!(false);
  expect(await start).toEqual({ status: "starting" });
  service.cancel();
});

it("shows an actionable error when device login is unavailable", async () => {
  const service = createCodexAuth({
    checkAuth: async () => false,
    spawnLogin: () => spawn(process.execPath, ["-e", "process.exit(1)"]),
  });
  try {
    await service.handle("start");
    expect(await waitForStatus(service, "error")).toEqual({
      status: "error",
      message:
        "Codex sign-in did not complete. Check that device login is enabled for your ChatGPT account, then try again.",
    });
  } finally {
    service.cancel();
  }
});

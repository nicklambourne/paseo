import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createClaudeAuth } from "./claude-auth.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paseo-claude-auth-"));
  await writeFile(
    join(directory, "login.cjs"),
    `process.stdout.write('Visit https://claude.com/oauth/authorize?test=1\\nPaste code here if prompted > ');
process.stdin.once('data', (chunk) => {
  require('node:fs').writeFileSync(process.argv[2], chunk.toString());
  process.exit(chunk.toString().trim() === 'valid' ? 0 : 1);
});`,
  );
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function auth() {
  const codePath = join(directory, "submitted-code");
  return createClaudeAuth({
    checkAuth: async () => {
      try {
        return (await readFile(codePath, "utf8")).trim() === "valid";
      } catch {
        return false;
      }
    },
    spawnLogin: () => spawn(process.execPath, [join(directory, "login.cjs"), codePath]),
  });
}

async function waitForStatus(service: ReturnType<typeof auth>, status: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = await service.handle("status");
    if (state.status === status) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Claude auth never reached ${status}`);
}

it("shows the Claude link, accepts a one-time code, and checks the resulting login", async () => {
  const service = auth();
  try {
    expect(await service.handle("start")).toEqual({ status: "starting" });
    expect(await waitForStatus(service, "pending")).toEqual({
      status: "pending",
      url: "https://claude.com/oauth/authorize?test=1",
    });
    expect(await service.handle("submit", "valid")).toEqual({ status: "checking" });
    expect(await waitForStatus(service, "connected")).toEqual({ status: "connected" });
  } finally {
    service.cancel();
  }
});

it("keeps an actionable error when Claude rejects the code", async () => {
  const service = auth();
  try {
    await service.handle("start");
    await waitForStatus(service, "pending");
    expect(await service.handle("submit", "invalid")).toEqual({ status: "checking" });
    expect(await waitForStatus(service, "error")).toEqual({
      status: "error",
      message: "Claude sign-in did not complete. Try again.",
    });
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

it("keeps starting state when a status request overlaps the initial auth check", async () => {
  let finishCheck: ((signedIn: boolean) => void) | null = null;
  const service = createClaudeAuth({
    checkAuth: () =>
      new Promise<boolean>((resolve) => {
        finishCheck = resolve;
      }),
    spawnLogin: () =>
      spawn(process.execPath, [join(directory, "login.cjs"), join(directory, "submitted-code")]),
  });
  const starting = service.handle("start");
  expect(await service.handle("status")).toEqual({ status: "starting" });
  expect(finishCheck).not.toBeNull();
  finishCheck!(false);
  await starting;
  service.cancel();
});

it("does not let an older status check replace a newly started login", async () => {
  const pendingChecks: Array<(signedIn: boolean) => void> = [];
  const service = createClaudeAuth({
    checkAuth: () =>
      new Promise<boolean>((resolve) => {
        pendingChecks.push(resolve);
      }),
    spawnLogin: () =>
      spawn(process.execPath, [join(directory, "login.cjs"), join(directory, "submitted-code")]),
  });
  const status = service.handle("status");
  const start = service.handle("start");
  pendingChecks[0]!(false);
  expect(await status).toEqual({ status: "starting" });
  pendingChecks[1]!(false);
  expect(await start).toEqual({ status: "starting" });
  service.cancel();
});

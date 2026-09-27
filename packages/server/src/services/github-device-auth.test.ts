import type * as pty from "node-pty";
import { describe, expect, it, vi } from "vitest";
import { createGitHubDeviceAuth } from "./github-device-auth.js";

class FakePty {
  private onDataListener: ((data: string) => void) | null = null;
  private onExitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  readonly write = vi.fn();
  readonly kill = vi.fn();

  onData(listener: (data: string) => void) {
    this.onDataListener = listener;
    return { dispose() {} };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.onExitListener = listener;
    return { dispose() {} };
  }

  emitData(data: string) {
    this.onDataListener?.(data);
  }

  emitExit(exitCode: number) {
    this.onExitListener?.({ exitCode });
  }
}

function createHarness() {
  const child = new FakePty();
  const spawn = vi.fn(() => child as unknown as pty.IPty);
  const auth = createGitHubDeviceAuth({
    resolveGhPath: async () => "/usr/bin/gh",
    spawn: spawn as unknown as typeof pty.spawn,
  });
  return { auth, child, spawn };
}

describe("GitHub device authorization", () => {
  it("returns only the device code, then reports successful CLI authentication", async () => {
    const { auth, child, spawn } = createHarness();
    const started = auth.start();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/gh",
      ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https"],
      expect.objectContaining({ name: "xterm-256color" }),
    );

    child.emitData("? Authenticate Git with your GitHub credentials? (Y/n)");
    expect(child.write).toHaveBeenCalledWith("Y\r");
    child.emitData("! First copy your one-time code: AB12-");
    child.emitData("CD34\r\n");
    expect(await started).toEqual({
      status: "pending",
      userCode: "AB12-CD34",
      verificationUrl: "https://github.com/login/device",
    });
    expect(child.write).toHaveBeenCalledWith("\r");

    child.emitData("gho_never_send_this_to_the_client");
    child.emitExit(0);
    expect(auth.status()).toEqual({ status: "authenticated" });
  });

  it("cancels a pending login without letting a late process exit change state", async () => {
    const { auth, child, spawn } = createHarness();
    const started = auth.start();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.emitData("First copy your one-time code: ABCD-1234");
    await started;

    expect(auth.cancel()).toEqual({ status: "idle" });
    expect(child.kill).toHaveBeenCalledOnce();
    child.emitExit(1);
    expect(auth.status()).toEqual({ status: "idle" });
  });

  it("reports expired authorization without exposing gh output", async () => {
    const { auth, child, spawn } = createHarness();
    const started = auth.start();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.emitData("First copy your one-time code: ABCD-1234");
    await started;

    child.emitData("gho_secret_token");
    child.emitExit(1);
    expect(auth.status()).toEqual({
      status: "error",
      message: "GitHub authorization failed or expired. Try again.",
    });
  });

  it("keeps a canceled login idle if locating gh later fails", async () => {
    let rejectPath: ((reason: Error) => void) | undefined;
    const auth = createGitHubDeviceAuth({
      resolveGhPath: () =>
        new Promise<string>((_resolve, reject) => {
          rejectPath = reject;
        }),
    });
    const started = auth.start();
    expect(auth.cancel()).toEqual({ status: "idle" });
    rejectPath?.(new Error("path lookup failed"));
    await expect(started).resolves.toEqual({ status: "idle" });
    expect(auth.status()).toEqual({ status: "idle" });
  });

  it("explains when the GitHub CLI is unavailable", async () => {
    const auth = createGitHubDeviceAuth({ resolveGhPath: async () => null });
    expect(await auth.start()).toEqual({
      status: "error",
      message: "GitHub CLI (gh) is not installed on this host.",
    });
  });
});

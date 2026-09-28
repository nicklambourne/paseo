import * as pty from "node-pty";
import stripAnsi from "strip-ansi";
import { ensureNodePtySpawnHelperExecutableForCurrentPlatform } from "../terminal/terminal.js";

export const GITHUB_DEVICE_VERIFICATION_URL = "https://github.com/login/device";

export type GitHubDeviceAuthState =
  | { status: "idle" | "starting" | "authenticated" }
  | { status: "pending"; userCode: string; verificationUrl: typeof GITHUB_DEVICE_VERIFICATION_URL }
  | { status: "error"; message: string };

export interface GitHubDeviceAuth {
  start(): Promise<GitHubDeviceAuthState>;
  status(): GitHubDeviceAuthState;
  cancel(): GitHubDeviceAuthState;
}

interface GitHubDeviceAuthOptions {
  resolveGhPath: () => Promise<string | null>;
  spawn?: typeof pty.spawn;
}

const START_TIMEOUT_MS = 45_000;
const AUTH_TIMEOUT_MS = 20 * 60_000;

/**
 * Drive gh's own OAuth device flow. The CLI keeps the credential in its normal
 * store; only the one-time code and the result ever cross the daemon socket.
 */
export function createGitHubDeviceAuth(options: GitHubDeviceAuthOptions): GitHubDeviceAuth {
  let state: GitHubDeviceAuthState = { status: "idle" };
  let childProcess: pty.IPty | null = null;
  let startupTimer: NodeJS.Timeout | null = null;
  let authTimer: NodeJS.Timeout | null = null;
  let startPromise: Promise<GitHubDeviceAuthState> | null = null;
  let resolveStart: ((state: GitHubDeviceAuthState) => void) | null = null;
  let generation = 0;

  function settleStart(next: GitHubDeviceAuthState): void {
    resolveStart?.(next);
    resolveStart = null;
  }

  async function begin(): Promise<GitHubDeviceAuthState> {
    const currentGeneration = ++generation;
    state = { status: "starting" };
    let ghPath: string | null;
    try {
      ghPath = await options.resolveGhPath();
    } catch {
      if (currentGeneration !== generation) return state;
      state = { status: "error", message: "Unable to locate GitHub CLI (gh) on this host." };
      return state;
    }
    if (currentGeneration !== generation) return state;
    if (!ghPath) {
      state = { status: "error", message: "GitHub CLI (gh) is not installed on this host." };
      return state;
    }

    return new Promise<GitHubDeviceAuthState>((resolve) => {
      resolveStart = resolve;
      let output = "";
      let answeredGitPrompt = false;
      let receivedCode = false;
      let finished = false;

      function finish(next: GitHubDeviceAuthState): void {
        if (finished || currentGeneration !== generation) return;
        finished = true;
        if (startupTimer) clearTimeout(startupTimer);
        if (authTimer) clearTimeout(authTimer);
        childProcess = null;
        state = next;
        settleStart(next);
      }

      try {
        ensureNodePtySpawnHelperExecutableForCurrentPlatform();
        const child = (options.spawn ?? pty.spawn)(
          ghPath,
          ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https"],
          {
            name: "xterm-256color",
            cols: 100,
            rows: 24,
            cwd: process.cwd(),
            env: process.env as Record<string, string>,
          },
        );
        childProcess = child;
        child.onData((data) => {
          if (finished || currentGeneration !== generation || receivedCode) return;
          output = (output + stripAnsi(data)).slice(-4096);
          if (
            !answeredGitPrompt &&
            /(?:Authenticate Git with your GitHub credentials|Do you want to re-authenticate)\?/i.test(
              output,
            )
          ) {
            answeredGitPrompt = true;
            child.write("Y\r");
            output = "";
            return;
          }
          const code = /First copy your one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(output);
          if (!code) return;
          receivedCode = true;
          output = "";
          if (startupTimer) clearTimeout(startupTimer);
          state = {
            status: "pending",
            userCode: code[1]!.toUpperCase(),
            verificationUrl: GITHUB_DEVICE_VERIFICATION_URL,
          };
          settleStart(state);
          // settleStart clears its resolver and finish ignores stale exits.
          // eslint-disable-next-line promise/no-multiple-resolved
          authTimer = setTimeout(() => {
            finish({ status: "error", message: "GitHub authorization expired. Try again." });
            child.kill();
          }, AUTH_TIMEOUT_MS);
          child.write("\r");
        });
        child.onExit(({ exitCode }) => {
          finish(
            exitCode === 0 && receivedCode
              ? { status: "authenticated" }
              : {
                  status: "error",
                  message: receivedCode
                    ? "GitHub authorization failed or expired. Try again."
                    : "GitHub sign-in could not start. Check gh and try again.",
                },
          );
        });
        startupTimer = setTimeout(() => {
          finish({ status: "error", message: "GitHub sign-in timed out. Try again." });
          child.kill();
        }, START_TIMEOUT_MS);
      } catch {
        finish({
          status: "error",
          message: "GitHub sign-in could not start. Check gh and try again.",
        });
      }
    });
  }

  return {
    start() {
      if (startPromise) return startPromise;
      if (childProcess) return Promise.resolve(state);
      startPromise = begin().finally(() => {
        startPromise = null;
      });
      return startPromise;
    },
    status() {
      return state;
    },
    cancel() {
      generation += 1;
      const child = childProcess;
      childProcess = null;
      if (startupTimer) clearTimeout(startupTimer);
      if (authTimer) clearTimeout(authTimer);
      state = { status: "idle" };
      settleStart(state);
      child?.kill();
      return state;
    },
  };
}

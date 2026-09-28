import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import stripAnsi from "strip-ansi";

export type ClaudeAuthState =
  | { status: "disconnected" | "starting" | "checking" | "connected" }
  | { status: "pending"; url: string }
  | { status: "error"; message: string };

const START_TIMEOUT_MS = 30_000;
const AUTH_TIMEOUT_MS = 15 * 60_000;
const STATUS_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_LENGTH = 32_000;

function extractLoginUrl(output: string): string | null {
  for (const match of stripAnsi(output).matchAll(/https:\/\/[^\s]+/g)) {
    try {
      const url = new URL(match[0].replace(/[),.]+$/, ""));
      if (url.hostname === "claude.com" || url.hostname.endsWith(".claude.com")) {
        return url.toString();
      }
    } catch {
      // Ignore unrelated CLI output.
    }
  }
  return null;
}

function checkClaudeAuth(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["auth", "status"], {
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    let settled = false;
    const finish = (signedIn: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // eslint-disable-next-line promise/no-multiple-resolved
      resolve(signedIn);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, STATUS_TIMEOUT_MS);
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  });
}

/** Runs Claude's own login in the daemon environment, where Claude Code agents run. */
export function createClaudeAuth(
  options: {
    checkAuth?: () => Promise<boolean>;
    spawnLogin?: () => ChildProcessWithoutNullStreams;
  } = {},
) {
  const checkAuth = options.checkAuth ?? checkClaudeAuth;
  const spawnLogin =
    options.spawnLogin ??
    (() =>
      spawn("claude", ["auth", "login", "--claudeai"], {
        stdio: "pipe",
        shell: process.platform === "win32",
      }));
  let state: ClaudeAuthState = { status: "disconnected" };
  let child: ChildProcessWithoutNullStreams | null = null;
  let startTimer: NodeJS.Timeout | null = null;
  let authTimer: NodeJS.Timeout | null = null;
  let startPromise: Promise<ClaudeAuthState> | null = null;
  let generation = 0;

  function clearTimers() {
    if (startTimer) clearTimeout(startTimer);
    if (authTimer) clearTimeout(authTimer);
    startTimer = null;
    authTimer = null;
  }

  function cancel(): ClaudeAuthState {
    generation += 1;
    clearTimers();
    child?.kill();
    child = null;
    state = { status: "disconnected" };
    return state;
  }

  async function begin(): Promise<ClaudeAuthState> {
    const currentGeneration = ++generation;
    state = { status: "starting" };
    if (await checkAuth()) {
      if (currentGeneration === generation) state = { status: "connected" };
      return state;
    }
    if (currentGeneration !== generation) return state;
    let loginProcess: ChildProcessWithoutNullStreams;
    try {
      loginProcess = spawnLogin();
    } catch {
      state = { status: "error", message: "Claude sign-in could not start on this host." };
      return state;
    }
    child = loginProcess;
    let output = "";
    let url: string | null = null;
    let promptCount = 0;

    function onOutput(chunk: Buffer) {
      if (currentGeneration !== generation) return;
      output = (output + chunk.toString()).slice(-MAX_OUTPUT_LENGTH);
      url ??= extractLoginUrl(output);
      const nextPromptCount = output.split("Paste code here if prompted").length - 1;
      if (url && (state.status === "starting" || nextPromptCount > promptCount)) {
        state = { status: "pending", url };
        if (startTimer) clearTimeout(startTimer);
        startTimer = null;
      }
      promptCount = nextPromptCount;
    }

    loginProcess.stdout.on("data", onOutput);
    loginProcess.stderr.on("data", onOutput);
    loginProcess.on("error", () => {
      if (currentGeneration !== generation) return;
      clearTimers();
      child = null;
      state = { status: "error", message: "Claude sign-in could not start on this host." };
    });
    loginProcess.on("exit", () => {
      if (currentGeneration !== generation) return;
      clearTimers();
      child = null;
      if (state.status === "error") return;
      void (async () => {
        const signedIn = await checkAuth();
        if (currentGeneration !== generation) return;
        state = signedIn
          ? { status: "connected" }
          : { status: "error", message: "Claude sign-in did not complete. Try again." };
      })();
    });
    startTimer = setTimeout(() => {
      if (currentGeneration !== generation || url) return;
      clearTimers();
      loginProcess.kill();
      state = { status: "error", message: "Claude did not provide a sign-in link." };
    }, START_TIMEOUT_MS);
    authTimer = setTimeout(() => {
      if (currentGeneration !== generation) return;
      clearTimers();
      loginProcess.kill();
      state = { status: "error", message: "Claude sign-in timed out. Try again." };
    }, AUTH_TIMEOUT_MS);
    return state;
  }

  async function handle(action: "start" | "status" | "submit" | "cancel", code?: string) {
    if (action === "cancel") return cancel();
    if (action === "start") {
      if (child) return state;
      startPromise ??= begin().finally(() => {
        startPromise = null;
      });
      return startPromise;
    }
    if (action === "submit") {
      if (!child || state.status !== "pending" || !code?.trim()) {
        return {
          status: "error",
          message: "Start Claude sign-in and enter the code first.",
        } as const;
      }
      child.stdin.write(`${code.trim()}\n`);
      state = { status: "checking" };
      return state;
    }
    if (child || startPromise) return state;
    const observedGeneration = generation;
    const signedIn = await checkAuth();
    if (observedGeneration !== generation || child || startPromise) return state;
    if (signedIn) state = { status: "connected" };
    else if (state.status !== "error") state = { status: "disconnected" };
    return state;
  }

  return { handle, cancel };
}

export const claudeAuth = createClaudeAuth();

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import stripAnsi from "strip-ansi";

export type CodexAuthState =
  | { status: "disconnected" | "starting" | "connected" }
  | { status: "pending"; url: string; code: string }
  | { status: "error"; message: string };

const START_TIMEOUT_MS = 30_000;
const AUTH_TIMEOUT_MS = 16 * 60_000;
const STATUS_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_LENGTH = 32_000;

function extractDevicePrompt(output: string): { url: string; code: string } | null {
  const plain = stripAnsi(output);
  const url = plain.match(/https:\/\/auth\.openai\.com\/codex\/device\b[^\s]*/)?.[0];
  const code = plain.match(/(?:^|\n)\s*([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+)\s*(?:\n|$)/)?.[1];
  return url && code ? { url, code } : null;
}

function checkCodexAuth(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("codex", ["login", "status"], {
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

/** Runs Codex device login in the daemon environment, where Codex agents run. */
export function createCodexAuth(
  options: {
    checkAuth?: () => Promise<boolean>;
    spawnLogin?: () => ChildProcessWithoutNullStreams;
  } = {},
) {
  const checkAuth = options.checkAuth ?? checkCodexAuth;
  const spawnLogin =
    options.spawnLogin ??
    (() =>
      spawn("codex", ["login", "--device-auth"], {
        stdio: "pipe",
        shell: process.platform === "win32",
      }));
  let state: CodexAuthState = { status: "disconnected" };
  let child: ChildProcessWithoutNullStreams | null = null;
  let startTimer: NodeJS.Timeout | null = null;
  let authTimer: NodeJS.Timeout | null = null;
  let startPromise: Promise<CodexAuthState> | null = null;
  let generation = 0;

  function clearTimers() {
    if (startTimer) clearTimeout(startTimer);
    if (authTimer) clearTimeout(authTimer);
    startTimer = null;
    authTimer = null;
  }

  function cancel(): CodexAuthState {
    generation += 1;
    clearTimers();
    child?.kill();
    child = null;
    state = { status: "disconnected" };
    return state;
  }

  async function begin(): Promise<CodexAuthState> {
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
      state = { status: "error", message: "Codex sign-in could not start on this host." };
      return state;
    }
    child = loginProcess;
    let output = "";

    function onOutput(chunk: Buffer) {
      if (currentGeneration !== generation) return;
      output = (output + chunk.toString()).slice(-MAX_OUTPUT_LENGTH);
      const prompt = extractDevicePrompt(output);
      if (prompt && state.status === "starting") {
        state = { status: "pending", ...prompt };
        if (startTimer) clearTimeout(startTimer);
        startTimer = null;
      }
    }

    loginProcess.stdout.on("data", onOutput);
    loginProcess.stderr.on("data", onOutput);
    loginProcess.on("error", () => {
      if (currentGeneration !== generation) return;
      clearTimers();
      child = null;
      state = { status: "error", message: "Codex sign-in could not start on this host." };
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
          : {
              status: "error",
              message:
                "Codex sign-in did not complete. Check that device login is enabled for your ChatGPT account, then try again.",
            };
      })();
    });
    startTimer = setTimeout(() => {
      if (currentGeneration !== generation || state.status === "pending") return;
      clearTimers();
      loginProcess.kill();
      state = { status: "error", message: "Codex did not provide a device sign-in code." };
    }, START_TIMEOUT_MS);
    authTimer = setTimeout(() => {
      if (currentGeneration !== generation) return;
      clearTimers();
      loginProcess.kill();
      state = { status: "error", message: "Codex sign-in timed out. Try again." };
    }, AUTH_TIMEOUT_MS);
    return state;
  }

  async function handle(action: "start" | "status" | "cancel") {
    if (action === "cancel") return cancel();
    if (action === "start") {
      if (child) return state;
      startPromise ??= begin().finally(() => {
        startPromise = null;
      });
      return startPromise;
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

export const codexAuth = createCodexAuth();

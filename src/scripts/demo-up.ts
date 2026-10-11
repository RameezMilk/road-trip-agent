/**
 * `npm run demo:up` — the demo stack in one command: a public HTTPS tunnel, then the agent with
 * PUBLIC_BASE_URL pointed at it. Ctrl-C (or SIGTERM) stops both — the agent finishes in-flight work first.
 *
 * Tunnel: a Cloudflare quick tunnel first (free, no account, and no "You are about to visit…" page in front
 * of the dashboard, unlike free ngrok). Its URL changes every run; cards always use the current one. If
 * Cloudflare can't create one (some networks block trycloudflare.com), it falls back to ngrok on the
 * PUBLIC_BASE_URL from .env; the dashboard's own requests send `ngrok-skip-browser-warning`, and each phone
 * taps "Visit Site" once (ngrok then remembers it for 7 days). TUNNEL=ngrok (env or .env) skips Cloudflare.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT ?? 8787);
const root = fileURLToPath(new URL("../..", import.meta.url));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));

let dotenv = "";
try {
  dotenv = readFileSync(new URL(".env", `file://${root}`), "utf8");
} catch {
  // no .env
}
const fromDotenv = (key: string) => dotenv.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() || undefined;

/** Starts a tunnel process and resolves with its public URL (the first match in its output). */
function startTunnel(
  command: string,
  args: string[],
  pattern: RegExp,
  timeoutMs: number,
): Promise<{ url: string; process: ChildProcess }> {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let settled = false;
  return new Promise((resolve, reject) => {
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      reject(new Error(`${reason}\n${output.slice(-600)}`));
    };
    const timer = setTimeout(() => fail(`${command}: no tunnel URL within ${timeoutMs / 1000} s`), timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(pattern);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: match[1] ?? match[0], process: child });
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => fail(`${command} failed to start: ${error}`));
    child.on("exit", (code) => fail(`${command} exited (${code})`));
  });
}

function cloudflare() {
  // The tunnel's own hostname is words-joined-by-hyphens (cloudflared also logs api.trycloudflare.com).
  return startTunnel(
    "cloudflared",
    ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"],
    /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/,
    30_000,
  );
}

function ngrok() {
  const domain = fromDotenv("PUBLIC_BASE_URL") ?? process.env.PUBLIC_BASE_URL;
  if (!domain?.includes("ngrok")) throw new Error("no ngrok PUBLIC_BASE_URL in .env to fall back to");
  return startTunnel(
    "ngrok",
    ["http", String(port), `--url=${domain.replace(/\/+$/, "")}`, "--log=stdout", "--log-format=json"],
    /"msg":"started tunnel".*?"url":"(https:\/\/[^"]+)"/,
    20_000,
  );
}

let tunnel: { url: string; process: ChildProcess };
if ((process.env.TUNNEL ?? fromDotenv("TUNNEL")) === "ngrok") tunnel = await ngrok();
else {
  try {
    tunnel = await cloudflare();
  } catch (error) {
    log("cloudflare_tunnel_unavailable", { error: String(error).split("\n").slice(0, 3).join(" | ") });
    tunnel = await ngrok();
  }
}
const { url } = tunnel;
log("tunnel_up", { url, via: url.includes("ngrok") ? "ngrok" : "cloudflare" });

// The environment wins over .env (Node --env-file semantics), so the agent uses the tunnel URL.
const agent = spawn(process.execPath, ["--import", "tsx", "--env-file-if-exists=.env", "src/index.ts"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PUBLIC_BASE_URL: url },
});

let stopping = false;
function stop(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  agent.once("exit", () => {
    tunnel.process.kill("SIGTERM");
    process.exit(0);
  });
  agent.kill(signal); // drains, then exits
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
agent.on("exit", (code) => {
  if (stopping) return;
  log("agent_exited", { code });
  tunnel.process.kill("SIGTERM");
  process.exit(code ?? 1);
});
tunnel.process.on("exit", (code) => {
  if (!stopping) log("tunnel_exited", { code, note: "cards won't open until the tunnel is back — restart demo:up" });
});

// Ready once the dashboard origin answers through the tunnel (DNS for a new tunnel takes a few seconds).
for (let i = 0; i < 90; i++) {
  try {
    const res = await fetch(`${url}/health`, {
      headers: { "ngrok-skip-browser-warning": "1" },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      log("demo_ready", { dashboardBase: `${url}/trip/` });
      break;
    }
  } catch {
    // not reachable yet
  }
  await sleep(1000);
}

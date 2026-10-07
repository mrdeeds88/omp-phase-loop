/**
 * Oh My Pi extension: /phase-loop
 *
 *   /phase-loop start <plan.md> [--from id] [--to id] [--only id] [--force] [--no-watch]
 *   /phase-loop <plan.md> ...          same as start
 *   /phase-loop run <plan.md> ...      same as start (runs in the background, watched live here)
 *   /phase-loop watch                  live panel above the editor + footer status
 *   /phase-loop unwatch                hide the panel (the loop keeps running)
 *   /phase-loop status | stop [--now] | list <plan.md> | init
 *
 * The loop runs as a detached background process (the phase-loop CLI), so it keeps going
 * if you close this omp session or the terminal. This command starts, watches and stops it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/phase-loop.ts", import.meta.url));
const BUN: string = (globalThis as any).Bun?.which?.("bun") ?? "bun";
const CLI_SUBCOMMANDS = ["start", "status", "stop", "list", "init"];
const USAGE =
  "Usage: /phase-loop start <plan.md> [--from id] [--to id] [--only id] [--force] [--no-watch] | watch | unwatch | status | stop [--now] | list <plan.md> | init";
const WIDGET = "phase-loop";
const OUTPUT_LINES = 8;

// ---------- helpers ----------
function splitArgs(s: string): string[] {
  const out: string[] = [];
  // plain words, "quoted words", and omp file-picker forms like @path and @"path with spaces"
  for (const m of (s ?? "").matchAll(/(@?)"([^"]*)"|(@?)'([^']*)'|(\S+)/g))
    out.push(m[5] ?? (m[2] !== undefined ? m[1] + m[2] : m[3] + m[4]));
  return out;
}
function show(ctx: any, text: string, level: "info" | "warning" | "error") {
  if (ctx?.ui?.notify) ctx.ui.notify(text, level);
  else console.log(text);
}
function readJson(p: string): any {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}
function runnerPid(cwd: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(cwd, ".loop", "runner.pid"), "utf8").trim());
    return pid && isAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}
function tailLines(p: string, n: number): string[] {
  try {
    const size = statSync(p).size;
    const len = Math.min(size, 32 * 1024);
    const buf = Buffer.alloc(len);
    const fd = openSync(p, "r");
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    return buf
      .toString("utf8")
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") // strip ANSI colors from agent output
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-n);
  } catch {
    return [];
  }
}

// ---------- live watcher ----------
type Watcher = { ctx: any; cwd: string; timer: any; lastKey?: string; sawRunner: boolean; startedAt: number };
let watcher: Watcher | null = null;

function clearTimerSafe(w: Watcher) {
  try {
    if (w.ctx?.clearTimer) w.ctx.clearTimer(w.timer);
    else clearInterval(w.timer);
  } catch {}
}

function stopWatch(final = false) {
  if (!watcher) return;
  const w = watcher;
  clearTimerSafe(w);
  watcher = null;
  try {
    w.ctx.ui?.setStatus?.(WIDGET, undefined);
    if (!final) w.ctx.ui?.setWidget?.(WIDGET, undefined);
  } catch {}
}

function render(w: Watcher) {
  const loop = join(w.cwd, ".loop");
  const s = readJson(join(loop, "state.json"));
  const pid = runnerPid(w.cwd);
  if (pid) w.sawRunner = true;

  if (!s) {
    w.ctx.ui?.setWidget?.(WIDGET, ["phase-loop: waiting for the runner to start…"]);
    if (!pid && Date.now() - w.startedAt > 15_000) stopWatch(true);
    return;
  }

  const sel: string[] = s.selected?.length ? s.selected : (s.phases ?? []).map((p: any) => p.id);
  const done = sel.filter((id) => s.completed?.[id]).length;
  const cur = pid ? s.current : undefined;
  const state = pid ? "running" : s.status === "running" ? "runner died — /phase-loop start to resume" : (s.status ?? "stopped");

  const lines = [`phase-loop · ${basename(s.plan)} · ${state} · ${done}/${sel.length} done`];
  if (cur) {
    const mins = Math.max(0, Math.round((Date.now() - Date.parse(cur.startedAt)) / 60000));
    lines.push(`▶ Phase ${cur.id}: ${cur.title} — attempt ${cur.attempt}/${cur.maxAttempts ?? "?"} · ${mins} min`);
  } else if (s.lastMessage) lines.push(s.lastMessage);
  const out = tailLines(join(loop, "runner.log"), OUTPUT_LINES).map((l) => "  " + (l.length > 140 ? l.slice(0, 139) + "…" : l));
  if (out.length) lines.push(...out);

  w.ctx.ui?.setWidget?.(WIDGET, lines);
  w.ctx.ui?.setStatus?.(WIDGET, cur ? `loop ▶ ${cur.id} · ${done}/${sel.length}` : pid ? `loop ${done}/${sel.length}` : undefined);

  // a toast whenever a phase starts or the run ends
  const key = cur ? `${cur.id}#${cur.attempt}` : pid ? "between" : `end:${s.status}`;
  if (w.lastKey !== undefined && key !== w.lastKey) {
    if (cur) show(w.ctx, `phase-loop: phase ${cur.id} started${cur.attempt > 1 ? ` (attempt ${cur.attempt})` : ""} — ${cur.title}`, "info");
    else if (!pid) {
      const level = s.status === "done" ? "info" : s.status === "stopped" ? "warning" : "error";
      show(w.ctx, `phase-loop ${s.status}: ${s.lastMessage ?? ""}`, level);
    }
  }
  w.lastKey = key;

  // runner finished: leave the final panel on screen, stop polling
  if (!pid && (w.sawRunner || Date.now() - w.startedAt > 15_000)) stopWatch(true);
}

function startWatch(ctx: any, announce: boolean) {
  const cwd = ctx?.cwd ?? process.cwd();
  if (!ctx?.ui?.setWidget) {
    show(ctx, "Live watch needs the interactive omp UI. In a terminal, run: phase-loop watch", "warning");
    return;
  }
  stopWatch();
  const w: Watcher = { ctx, cwd, timer: undefined, sawRunner: false, startedAt: Date.now() };
  const tick = () => {
    if (watcher === w) render(w);
  };
  w.timer = ctx.setInterval ? ctx.setInterval(tick, 2000) : setInterval(tick, 2000);
  watcher = w;
  render(w);
  if (announce)
    show(ctx, "Watching phase-loop above the editor. /phase-loop unwatch hides it (the loop keeps running). Full output: `phase-loop watch` in a terminal.", "info");
}

// ---------- command ----------
export default function phaseLoopExtension(pi: any) {
  pi.registerCommand("phase-loop", {
    description: "Run a plan phase-by-phase in fresh sessions, in the background, and watch it live (start | watch | status | stop | list | init)",
    handler: async (args: string, ctx: any) => {
      let argv = splitArgs(args);
      if (!argv.length) argv = ["status"];
      if (argv[0] === "run") argv[0] = "start"; // never block the TUI with a foreground run
      if (!CLI_SUBCOMMANDS.includes(argv[0]) && !["watch", "unwatch"].includes(argv[0]) && /\.(md|markdown)$/i.test(argv[0]))
        argv.unshift("start"); // `/phase-loop @plan.md --from 3` means start

      if (argv[0] === "watch") return startWatch(ctx, true);
      if (argv[0] === "unwatch") {
        stopWatch();
        return show(ctx, "Stopped watching. The loop (if running) keeps going; /phase-loop watch to see it again.", "info");
      }
      if (!CLI_SUBCOMMANDS.includes(argv[0])) return show(ctx, `Unknown subcommand "${argv[0]}". ${USAGE}`, "warning");

      const noWatch = argv.includes("--no-watch");
      argv = argv.filter((a) => a !== "--no-watch" && a !== "--watch");
      const r = spawnSync(BUN, [CLI, ...argv], {
        cwd: ctx?.cwd ?? process.cwd(),
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
      });
      const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/^\s*\n/, "").trimEnd() || r.error?.message || "(no output)";
      show(ctx, text, r.status === 0 ? "info" : "error");

      if (argv[0] === "start" && r.status === 0 && !noWatch && !argv.includes("--dry-run") && runnerPid(ctx?.cwd ?? process.cwd()))
        startWatch(ctx, false);
    },
  });
}

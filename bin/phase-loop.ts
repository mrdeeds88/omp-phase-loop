#!/usr/bin/env bun
/**
 * phase-loop — run a multi-phase plan with Oh My Pi (omp), one FRESH session per phase.
 * Run `phase-loop help` for usage.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, openSync, copyFileSync, statSync, readSync, closeSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const PKG = resolve(import.meta.dir, "..");
const CLI = join(PKG, "bin", "phase-loop.ts");
const TEMPLATES = join(PKG, "templates");
const isWin = process.platform === "win32";
const root = process.cwd();
const LOOP = join(root, ".loop");
const P = {
  state: join(LOOP, "state.json"),
  handoff: join(LOOP, "HANDOFF.md"),
  stop: join(LOOP, "STOP"),
  logs: join(LOOP, "logs"),
  prompts: join(LOOP, "prompts"),
  results: join(LOOP, "results"),
  pid: join(LOOP, "runner.pid"),
  runnerLog: join(LOOP, "runner.log"),
};

const USAGE = `phase-loop — run a plan phase by phase, one fresh omp session per phase

  phase-loop start <plan.md> [opts]   run in the background (survives closing the terminal or omp)
  phase-loop run <plan.md> [opts]     run in the foreground
  phase-loop watch                    follow a background run live (Ctrl+C stops watching, not the loop)
  phase-loop status                   progress, current phase, recent output
  phase-loop stop [--now]             stop after the current phase (--now: kill it immediately)
  phase-loop list <plan.md>           show the phases parsed from the plan
  phase-loop init [--with-prompt]     add loop.config.json (and an editable prompt) to this project
  phase-loop setup [--no-extension]   install the global \`phase-loop\` command and the omp /phase-loop command

Options: --from <id>  --to <id>  --only <id>  --force  --dry-run  --config <file>  --watch (with start)`;

// ---------- types & config ----------
type Config = {
  agentCmd: string[];
  phaseHeading: string;
  verify: string[];
  maxAttempts: number;
  phaseTimeoutMin: number;
  gitCommit: boolean;
  requireCleanTree: boolean;
  ntfyTopic?: string;
  promptTemplate?: string; // relative to the config file; default: the package template
  handoffMaxChars: number;
};
const DEFAULTS: Config = {
  agentCmd: ["omp", "-p", "--yolo", "--no-session"],
  phaseHeading:
    "^(?<hashes>#{2,4})\\s+(?:Phase|Task|Step|Giai đoạn|Bước)\\s+(?<id>\\d+(?:\\.\\d+)?[a-z]?)\\s*[:.\\-–—)]?\\s*(?<title>.*)$",
  verify: [],
  maxAttempts: 3,
  phaseTimeoutMin: 90,
  gitCommit: true,
  requireCleanTree: true,
  handoffMaxChars: 12000,
};
type Phase = { id: string; title: string; body: string };
type Status = "running" | "done" | "failed" | "blocked" | "stopped";
type State = {
  plan: string;
  status?: Status;
  updatedAt?: string;
  lastMessage?: string;
  phases?: { id: string; title: string }[];
  selected?: string[];
  current?: { id: string; title: string; attempt: number; maxAttempts?: number; startedAt: string; agentPid?: number };
  completed: Record<string, { at: string; commit?: string; summary: string }>;
};
type Ctx = { opts: Record<string, string | boolean>; planPath: string; planRel: string; configPath?: string; cfg: Config; templatePath: string; phases: Phase[] };

// ---------- small helpers ----------
function die(msg: string, code = 64): never {
  console.error(`✖ ${msg}`);
  process.exit(code);
}
const log = (msg: string) => console.log(`\n[phase-loop ${new Date().toLocaleTimeString()}] ${msg}`);
const tail = (s: string, n = 4000) => (s.length > n ? "…(truncated)…\n" + s.slice(-n) : s);
const rel = (p: string) => relative(root, p).replaceAll("\\", "/");
const shellArgv = (cmd: string) => (isWin ? ["powershell", "-NoProfile", "-Command", cmd] : ["sh", "-c", cmd]);

function parseArgs(a: string[]) {
  const opts: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith("--")) {
      const key = a[i].slice(2);
      if (["config", "from", "to", "only"].includes(key) && a[i + 1] !== undefined) opts[key] = a[++i];
      else opts[key] = true;
    } else positional.push(a[i]);
  }
  return { opts, positional };
}

function isAlive(pid?: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}
function runningPid(): number | undefined {
  if (!existsSync(P.pid)) return;
  const pid = Number(readFileSync(P.pid, "utf8").trim());
  return isAlive(pid) ? pid : undefined;
}
function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM") {
  if (isWin) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal); // whole process group (agent + its shells)
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}
function tailFile(p: string, lines = 10) {
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join("\n");
}
function readState(): State | null {
  return existsSync(P.state) ? JSON.parse(readFileSync(P.state, "utf8")) : null;
}
function writeState(s: State) {
  mkdirSync(LOOP, { recursive: true });
  s.updatedAt = new Date().toISOString();
  writeFileSync(P.state, JSON.stringify(s, null, 2));
}
async function run(cmd: string[]): Promise<{ code: number; out: string }> {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") + (r.error ? String(r.error) : "") };
}
const git = (...a: string[]) => run(["git", ...a]);

// ---------- plan & config ----------
function parsePhases(md: string, heading: string): Phase[] {
  const re = new RegExp(heading, "iu");
  const out: (Phase & { level: number; lines: string[] })[] = [];
  let cur: (typeof out)[number] | null = null;
  let inFence = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = inFence ? null : line.match(re);
    if (m?.groups) {
      cur = { id: m.groups.id, title: (m.groups.title ?? "").trim(), body: "", level: m.groups.hashes.length, lines: [line] };
      out.push(cur);
      continue;
    }
    const h = inFence ? null : line.match(/^(#{1,6})\s/);
    if (cur && h && h[1].length <= cur.level) cur = null; // a non-phase heading at same/higher level ends the phase
    if (cur) cur.lines.push(line);
  }
  return out.map(({ id, title, lines }) => ({ id, title, body: lines.join("\n").trim() }));
}

/**
 * Accepts the plan path as typed in a terminal or in omp. omp's file picker inserts `@path`
 * (and may wrap it in quotes); slash-command args arrive raw, so strip those before resolving.
 * A file whose real name starts with "@" still wins if it exists.
 */
function resolvePlanArg(raw: string): string {
  const cleaned = raw.trim().replace(/^(["'])(.*)\1$/, "$2");
  const candidates = [cleaned];
  if (cleaned.startsWith("@")) candidates.push(cleaned.slice(1).replace(/^(["'])(.*)\1$/, "$2"));
  for (const c of candidates) {
    const p = resolve(root, c);
    if (existsSync(p)) return p;
  }
  die(`Plan file not found: ${resolve(root, candidates.at(-1)!)}\n  (looked relative to ${root})`);
}

function loadCtx(args: string[]): Ctx {
  const { opts, positional } = parseArgs(args);
  if (!positional[0]) die(`Missing plan file.\n\n${USAGE}`);
  const planPath = resolvePlanArg(positional[0]);
  if (opts.config && !existsSync(resolve(opts.config as string))) die(`Config not found: ${opts.config}`);
  const configPath = [opts.config as string, join(root, "loop.config.json")].filter(Boolean).map((p) => resolve(p)).find((p) => existsSync(p));
  const cfg: Config = { ...DEFAULTS, ...(configPath ? JSON.parse(readFileSync(configPath, "utf8")) : {}) };
  const templatePath = cfg.promptTemplate ? resolve(dirname(configPath!), cfg.promptTemplate) : join(TEMPLATES, "phase-prompt.md");
  if (!existsSync(templatePath)) die(`Prompt template not found: ${templatePath}`);
  const phases = parsePhases(readFileSync(planPath, "utf8"), cfg.phaseHeading);
  if (!phases.length) die(`No phases found in ${rel(planPath)}. Headings must look like "## Phase 1: Title" (see phaseHeading).`);
  const ids = phases.map((p) => p.id);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupes.length) die(`Duplicate phase ids: ${dupes.join(", ")}`);
  return { opts, planPath, planRel: rel(planPath), configPath, cfg, templatePath, phases };
}

function loadStateFor(ctx: Ctx): State {
  const s = readState();
  if (s && s.plan !== ctx.planRel)
    die(`.loop/ belongs to another plan (${s.plan}). Finish or delete .loop/ before running ${ctx.planRel}.`);
  return s ?? { plan: ctx.planRel, completed: {} };
}

function selectPending(ctx: Ctx, state: State) {
  const { opts, phases } = ctx;
  const idx = (id: string) => {
    const i = phases.findIndex((p) => p.id === id);
    if (i < 0) die(`Unknown phase id "${id}". Known: ${phases.map((p) => p.id).join(", ")}`);
    return i;
  };
  const sel = opts.only
    ? [phases[idx(opts.only as string)]]
    : phases.slice(opts.from ? idx(opts.from as string) : 0, (opts.to ? idx(opts.to as string) : phases.length - 1) + 1);
  return sel.filter((p) => opts.force || !state.completed[p.id]);
}

async function preflight(cfg: Config) {
  if (!cfg.gitCommit && !cfg.requireCleanTree) return;
  if ((await git("rev-parse", "--is-inside-work-tree")).code !== 0) die("Not a git repository (needed for per-phase commits).");
  if (cfg.requireCleanTree && (await git("status", "--porcelain", "--", ".", ":!.loop")).out.trim())
    die("Working tree is not clean. Commit or stash first (or set requireCleanTree: false).");
}

function printPhases(ctx: Ctx, state: State, pending: Phase[]) {
  for (const p of ctx.phases) console.log(`${state.completed[p.id] ? "✔" : pending.includes(p) ? "•" : " "} ${p.id}: ${p.title}`);
}

// ---------- prompt ----------
function buildPrompt(ctx: Ctx, state: State, ph: Phase, resultPath: string, retryContext: string) {
  const handoffAll = existsSync(P.handoff) ? readFileSync(P.handoff, "utf8") : "";
  const vars: Record<string, string> = {
    PLAN_PATH: ctx.planRel,
    PHASE_ID: ph.id,
    PHASE_TITLE: ph.title,
    PHASE_BODY: ph.body,
    ALL_PHASES: ctx.phases
      .map((p) => `- ${p.id}: ${p.title}${state.completed[p.id] ? " (done)" : p.id === ph.id ? "  <-- YOU" : ""}`)
      .join("\n"),
    HANDOFF: handoffAll.trim() ? tail(handoffAll, ctx.cfg.handoffMaxChars) : "(none — this is the first phase run)",
    RESULT_PATH: rel(resultPath),
    VERIFY: ctx.cfg.verify.length ? ctx.cfg.verify.map((c) => `\`${c}\``).join(", ") : "(none configured)",
    RETRY_CONTEXT: retryContext,
  };
  return readFileSync(ctx.templatePath, "utf8").replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
}

// ---------- notifications ----------
async function notify(cfg: Config, title: string, message: string, priority: "low" | "default" | "high" = "default") {
  log(`${title} — ${message}`);
  if (!cfg.ntfyTopic) return;
  try {
    await fetch(`https://ntfy.sh/${cfg.ntfyTopic}`, {
      method: "POST",
      body: message,
      headers: { Title: title.replace(/[^\x20-\x7E]/g, ""), Priority: priority },
    });
  } catch {
    /* never let a notification failure stop the loop */
  }
}

// ---------- commands ----------
async function cmdRun(args: string[]) {
  const ctx = loadCtx(args);
  const { cfg } = ctx;
  for (const d of [LOOP, P.logs, P.prompts, P.results]) mkdirSync(d, { recursive: true });
  const state = loadStateFor(ctx);
  const pending = selectPending(ctx, state);

  if (ctx.opts["dry-run"]) {
    console.log(`Plan: ${ctx.planRel}\nConfig: ${ctx.configPath ? rel(ctx.configPath) : "(defaults)"}\n`);
    printPhases(ctx, state, pending);
    if (pending[0]) console.log(`\n----- prompt for phase ${pending[0].id} -----\n\n${buildPrompt(ctx, state, pending[0], join(P.results, `phase-${pending[0].id}.json`), "")}`);
    return;
  }

  const other = runningPid();
  if (other && other !== process.pid) die(`Already running (pid ${other}). Use \`phase-loop status\` or \`phase-loop stop\`.`);
  await preflight(cfg);

  writeFileSync(P.pid, String(process.pid));
  process.on("exit", () => {
    try {
      if (readFileSync(P.pid, "utf8").trim() === String(process.pid)) rmSync(P.pid, { force: true });
    } catch {}
  });
  rmSync(P.stop, { force: true });

  let child: ChildProcess | undefined;
  const finish = (status: Status, code: number, msg?: string): never => {
    state.status = status;
    state.lastMessage = msg;
    delete state.current;
    writeState(state);
    process.exit(code);
  };
  const onSignal = () => {
    if (child?.pid) killTree(child.pid);
    finish("stopped", 130, "Stopped by signal");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  state.phases = ctx.phases.map(({ id, title }) => ({ id, title }));
  state.selected = pending.map((p) => p.id);
  state.status = "running";
  state.lastMessage = undefined;
  writeState(state);

  const runAgent = (promptFile: string, logFile: string) =>
    new Promise<{ code: number; timedOut: boolean }>((done) => {
      const cmd = [...cfg.agentCmd, `@${rel(promptFile)}`, "Follow the instructions in the attached file exactly."];
      writeFileSync(logFile, `$ ${cmd.join(" ")}\n\n`);
      // detached on POSIX = own process group, so a timeout/stop kills the agent and every shell it started
      child = spawn(cmd[0], cmd.slice(1), { cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: !isWin, windowsHide: true });
      if (state.current) {
        state.current.agentPid = child.pid;
        writeState(state);
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child?.pid) killTree(child.pid);
      }, cfg.phaseTimeoutMin * 60_000);
      const pipe = (out: NodeJS.WriteStream) => (d: Buffer) => {
        out.write(d);
        appendFileSync(logFile, d);
      };
      child.stdout!.on("data", pipe(process.stdout));
      child.stderr!.on("data", pipe(process.stderr));
      child.on("error", (e) => {
        appendFileSync(logFile, `\n[spawn error] ${e.message}\n`);
        clearTimeout(timer);
        done({ code: 127, timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        child = undefined;
        done({ code: code ?? 1, timedOut });
      });
    });

  log(`${pending.length} phase(s) to run: ${pending.map((p) => p.id).join(", ") || "none"}`);
  await notify(cfg, "phase-loop started", `${ctx.planRel}: ${pending.length} phase(s) pending`, "low");

  for (const ph of pending) {
    if (existsSync(P.stop)) {
      rmSync(P.stop, { force: true });
      await notify(cfg, "phase-loop stopped", `Stop requested; next phase would have been ${ph.id}`);
      finish("stopped", 0, `Stopped before phase ${ph.id}`);
    }

    const resultPath = join(P.results, `phase-${ph.id}.json`);
    let retryContext = "";
    let result: { status: "done" | "blocked"; summary?: string; handoff?: string; blockedReason?: string } | null = null;

    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
      log(`Phase ${ph.id} "${ph.title}" — attempt ${attempt}/${cfg.maxAttempts} (fresh session)`);
      state.current = { id: ph.id, title: ph.title, attempt, maxAttempts: cfg.maxAttempts, startedAt: new Date().toISOString() };
      writeState(state);
      rmSync(resultPath, { force: true });
      const promptFile = join(P.prompts, `phase-${ph.id}.md`);
      writeFileSync(promptFile, buildPrompt(ctx, state, ph, resultPath, retryContext));
      const { code, timedOut } = await runAgent(promptFile, join(P.logs, `phase-${ph.id}-attempt-${attempt}.log`));

      try {
        const r = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null;
        result = r?.status === "done" || r?.status === "blocked" ? r : null;
      } catch {
        result = null;
      }
      if (timedOut || !result) {
        const why = timedOut
          ? `The previous attempt timed out after ${cfg.phaseTimeoutMin} minutes.`
          : `The previous attempt exited (code ${code}) without writing a valid result file.`;
        retryContext = `## RETRY NOTICE\n${why} The working tree still contains its changes; inspect them (\`git status\`, \`git diff\`) and continue from there instead of starting over.`;
        result = null;
        continue;
      }
      if (result.status === "blocked") {
        await notify(cfg, `Phase ${ph.id} BLOCKED`, result.blockedReason || result.summary || "no reason given", "high");
        finish("blocked", 2, `Phase ${ph.id} blocked: ${result.blockedReason || result.summary || "no reason given"}`);
      }

      // Verify independently — never trust the agent's self-report alone.
      let failed = "";
      for (const v of cfg.verify) {
        log(`verify: ${v}`);
        const r = await run(shellArgv(v));
        if (r.code !== 0) {
          failed = `\`${v}\` failed (exit ${r.code}):\n\n\`\`\`\n${tail(r.out)}\n\`\`\``;
          break;
        }
      }
      if (failed) {
        retryContext = `## RETRY NOTICE\nYou reported this phase as done, but the runner's verification failed:\n\n${failed}\n\nThe working tree still contains the previous attempt's changes. Fix the cause (do not weaken or delete tests to make them pass), re-run the checks, then write the result file again.`;
        result = null;
        continue;
      }
      break;
    }

    if (!result) {
      await notify(cfg, `Phase ${ph.id} FAILED`, `Gave up after ${cfg.maxAttempts} attempts. See .loop/logs/`, "high");
      finish("failed", 1, `Phase ${ph.id} failed after ${cfg.maxAttempts} attempts`);
    }

    appendFileSync(P.handoff, `\n## Phase ${ph.id} — ${ph.title} (${new Date().toISOString()})\n\n**Summary:** ${result.summary ?? ""}\n\n${result.handoff ?? ""}\n`);

    let commit: string | undefined;
    if (cfg.gitCommit) {
      await git("add", "-A", "--", ".", ":!.loop/logs", ":!.loop/prompts", ":!.loop/runner.*", ":!.loop/STOP", ":!.loop/state.json");
      const c = await git("commit", "-m", `phase ${ph.id}: ${ph.title}`, "-m", result.summary ?? "", "--no-verify");
      if (c.code === 0) commit = (await git("rev-parse", "--short", "HEAD")).out.trim();
      else log(`git commit skipped: ${c.out.trim().split("\n").pop()}`);
    }
    state.completed[ph.id] = { at: new Date().toISOString(), commit, summary: result.summary ?? "" };
    writeState(state);
    await notify(cfg, `Phase ${ph.id} done`, `${ph.title}${commit ? ` (${commit})` : ""}`, "low");
  }

  await notify(cfg, "phase-loop finished", `All selected phases complete for ${ctx.planRel}`);
  finish("done", 0, "All selected phases complete");
}

async function cmdStart(args: string[]) {
  const ctx = loadCtx(args);
  if (ctx.opts["dry-run"]) return cmdRun(args);
  const pid = runningPid();
  if (pid) die(`Already running (pid ${pid}). Use \`phase-loop status\` or \`phase-loop stop\`.`);
  const state = loadStateFor(ctx);
  const pending = selectPending(ctx, state);
  if (!pending.length) {
    console.log("Nothing to run: all selected phases are already complete (use --force to re-run).");
    return;
  }
  await preflight(ctx.cfg);

  mkdirSync(LOOP, { recursive: true });
  appendFileSync(P.runnerLog, `\n===== start ${new Date().toISOString()} =====\n`);
  const fd = openSync(P.runnerLog, "a");
  const child = spawn(process.execPath, [CLI, "run", ...args], { cwd: root, detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
  child.unref();
  await Bun.sleep(1500);
  if (!isAlive(child.pid)) die(`Runner exited right away. Last output:\n${tailFile(P.runnerLog, 15)}`, 1);
  console.log(
    `Started in the background (pid ${child.pid}): ${pending.length} phase(s) — ${pending.map((p) => p.id).join(", ")}\n` +
      `Watch: phase-loop watch · Status: phase-loop status · Stop: phase-loop stop [--now]`,
  );
  if (ctx.opts.watch) await cmdWatch();
}

/** Follow the background run live (Ctrl+C only stops watching; the loop keeps running). */
async function cmdWatch() {
  if (!existsSync(P.runnerLog)) return console.log("Nothing to watch yet: no background run in this folder (.loop/runner.log not found).");
  const initial = tailFile(P.runnerLog, 20);
  if (initial) console.log(initial);
  let pos = statSync(P.runnerLog).size;
  process.on("SIGINT", () => {
    console.log("\n(stopped watching — the loop keeps running; `phase-loop stop` to stop it)");
    process.exit(0);
  });
  const flush = () => {
    const size = statSync(P.runnerLog).size;
    if (size < pos) pos = 0; // log was truncated
    if (size === pos) return;
    const fd = openSync(P.runnerLog, "r");
    const buf = Buffer.alloc(size - pos);
    readSync(fd, buf, 0, buf.length, pos);
    closeSync(fd);
    pos = size;
    process.stdout.write(buf);
  };
  if (!runningPid()) {
    const s = readState();
    return console.log(`\n(runner is not running — last status: ${s?.status ?? "unknown"}${s?.lastMessage ? `, ${s.lastMessage}` : ""})`);
  }
  while (runningPid()) {
    flush();
    await Bun.sleep(500);
  }
  flush();
  const s = readState();
  console.log(`\n[phase-loop] runner exited — status: ${s?.status ?? "unknown"}${s?.lastMessage ? ` (${s.lastMessage})` : ""}`);
}

function cmdStatus() {
  const s = readState();
  if (!s) return console.log("No phase-loop run in this folder yet (.loop/state.json not found).");
  const pid = runningPid();
  const status = pid
    ? `running (pid ${pid})`
    : s.status === "running"
      ? "not running — the runner died; run `phase-loop start` again to resume"
      : (s.status ?? "unknown");
  const phases = s.phases ?? [];
  const sel = s.selected?.length ? s.selected : phases.map((p) => p.id);
  const done = sel.filter((id) => s.completed[id]).length;
  const out = [`Plan: ${s.plan}`, `Status: ${status}`, `Progress: ${done}/${sel.length} selected phases done`];
  for (const p of phases) {
    const c = s.completed[p.id];
    const mark = c ? "✔" : pid && s.current?.id === p.id ? "▶" : "•";
    out.push(`  ${mark} ${p.id}: ${p.title}${c?.commit ? ` (${c.commit})` : ""}`);
  }
  if (pid && s.current) {
    const mins = Math.round((Date.now() - Date.parse(s.current.startedAt)) / 60000);
    out.push(`Current: phase ${s.current.id}, attempt ${s.current.attempt}, running ${mins} min`);
  }
  if (s.lastMessage) out.push(`Last: ${s.lastMessage}`);
  if (existsSync(P.stop)) out.push("Stop requested: will stop after the current phase.");
  const t = tailFile(P.runnerLog, 8);
  if (t) out.push("", "Recent output:", t);
  console.log(out.join("\n"));
}

async function cmdStop(args: string[]) {
  const { opts } = parseArgs(args);
  const pid = runningPid();
  if (!pid) return console.log("Not running.");
  if (!opts.now) {
    writeFileSync(P.stop, new Date().toISOString());
    return console.log(`Stop requested: the runner (pid ${pid}) will stop after the current phase finishes.`);
  }
  const s = readState();
  if (!isWin) {
    process.kill(pid, "SIGTERM"); // runner kills its agent and records "stopped"
    for (let i = 0; i < 10 && isAlive(pid); i++) await Bun.sleep(300);
  }
  if (isAlive(pid)) killTree(pid, "SIGKILL"); // Windows always lands here: taskkill /T /F
  if (s?.current?.agentPid && isAlive(s.current.agentPid)) killTree(s.current.agentPid, "SIGKILL");
  const after = readState();
  if (after && after.status === "running") {
    after.status = "stopped";
    after.lastMessage = `Killed during phase ${after.current?.id ?? "?"}`;
    delete after.current;
    writeState(after);
  }
  rmSync(P.pid, { force: true });
  console.log(`Stopped now. Phase ${s?.current?.id ?? "?"} was interrupted; its partial changes are still in the working tree.`);
}

function cmdList(args: string[]) {
  const ctx = loadCtx(args);
  const s = readState();
  const state = s && s.plan === ctx.planRel ? s : { plan: ctx.planRel, completed: {} };
  printPhases(ctx, state, selectPending(ctx, state));
}

function cmdInit(args: string[]) {
  const { opts } = parseArgs(args);
  const cfgPath = join(root, "loop.config.json");
  if (existsSync(cfgPath)) console.log("loop.config.json already exists — left unchanged.");
  else {
    copyFileSync(join(TEMPLATES, "loop.config.json"), cfgPath);
    console.log("Created loop.config.json — set your `verify` commands and model in it.");
  }
  if (opts["with-prompt"]) {
    const dst = join(root, "phase-prompt.md");
    if (!existsSync(dst)) copyFileSync(join(TEMPLATES, "phase-prompt.md"), dst);
    const c = JSON.parse(readFileSync(cfgPath, "utf8"));
    c.promptTemplate = "phase-prompt.md";
    writeFileSync(cfgPath, JSON.stringify(c, null, 2) + "\n");
    console.log("Created phase-prompt.md (project-specific prompt) and pointed loop.config.json at it.");
  }
  const gi = join(root, ".gitignore");
  const want = [".loop/logs/", ".loop/prompts/", ".loop/runner.*", ".loop/STOP", ".loop/state.json"];
  const have = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const missing = want.filter((l) => !have.split(/\r?\n/).includes(l));
  if (missing.length) {
    appendFileSync(gi, `${have && !have.endsWith("\n") ? "\n" : ""}# phase-loop\n${missing.join("\n")}\n`);
    console.log(`Added to .gitignore: ${missing.join(" ")}`);
  }
}

function cmdSetup(args: string[]) {
  const { opts } = parseArgs(args);
  const cliPath = CLI.replaceAll("\\", "/");
  // 1. global command: a tiny shim in Bun's bin dir (already on PATH for Bun users)
  const binDir = join(process.env.BUN_INSTALL ?? join(homedir(), ".bun"), "bin");
  mkdirSync(binDir, { recursive: true });
  if (isWin) {
    const shim = join(binDir, "phase-loop.cmd");
    writeFileSync(shim, `@echo off\r\nbun "${CLI}" %*\r\n`);
    console.log(`Installed command: ${shim}`);
  } else {
    const shim = join(binDir, "phase-loop");
    writeFileSync(shim, `#!/bin/sh\nexec bun "${cliPath}" "$@"\n`, { mode: 0o755 });
    console.log(`Installed command: ${shim}`);
  }
  // 2. omp extension: a one-line loader in the global extensions folder
  if (!opts["no-extension"]) {
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
    const extDir = join(agentDir, "extensions");
    mkdirSync(extDir, { recursive: true });
    const target = join(PKG, "extension", "index.ts").replaceAll("\\", "/");
    const file = join(extDir, "phase-loop.ts");
    writeFileSync(file, `// Generated by \`phase-loop setup\`. Adds the /phase-loop command to Oh My Pi.\nexport { default } from ${JSON.stringify(target)};\n`);
    console.log(`Installed omp extension: ${file}`);
  }
  console.log(`\nDone. Keep this folder where it is (${PKG.replaceAll("\\", "/")}); the command and extension point to it.`);
  console.log("Restart omp to load /phase-loop. If `phase-loop` is not found, add Bun's bin folder to PATH.");
}

// ---------- dispatch ----------
const argv = process.argv.slice(2);
let [sub, ...rest] = argv;
if (sub && /\.(md|markdown)$/i.test(sub)) [sub, rest] = ["run", argv];
switch (sub) {
  case "run": await cmdRun(rest); break;
  case "start": await cmdStart(rest); break;
  case "status": cmdStatus(); break;
  case "watch": case "logs": await cmdWatch(); break;
  case "stop": await cmdStop(rest); break;
  case "list": cmdList(rest); break;
  case "init": cmdInit(rest); break;
  case "setup": cmdSetup(rest); break;
  default: console.log(USAGE); if (sub && !["help", "--help", "-h"].includes(sub)) process.exit(64);
}

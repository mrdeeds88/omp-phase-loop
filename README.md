# phase-loop

Run a multi-phase plan with **Oh My Pi**, unattended: every phase gets a **fresh `omp -p` session** (your manual "/clear, then do the next task"), the runner checks the work itself, commits, and moves on. It runs as a background process, so it keeps going after you close omp or the terminal.

## Install (once per machine)

Requires Bun (omp already needs it).

```sh
# put this folder somewhere permanent, e.g. ~/tools/phase-loop  (Windows: %USERPROFILE%\tools\phase-loop)
cd ~/tools/phase-loop
bun bin/phase-loop.ts setup
```

`setup` installs two small pointers back to this folder:
- the `phase-loop` command, in Bun's bin folder (`~/.bun/bin`, already on PATH for Bun users)
- the omp extension `~/.omp/agent/extensions/phase-loop.ts`, which adds `/phase-loop` (restart omp to load it)

Update = replace the folder's files. Don't move the folder without re-running `setup`.

## Set up a project (once per repo)

```sh
cd my-repo
phase-loop init        # creates loop.config.json + .gitignore entries
```

Edit `loop.config.json`:
- `verify` → the checks that gate every phase (`bun run typecheck`, `pnpm test`, …). **The most important setting.**
- `model` / `thinking` → the model every phase session uses (e.g. `anthropic/claude-opus-5-5`, thinking `high`).
  Leave `model` empty to use omp's default model role (whatever `/model` is set to in omp).
- `agentCmd` → the base command. Windows: if `omp` is a `.cmd` shim, use `["cmd", "/c", "omp", ...]`.
- `ntfyTopic` → a random string; subscribe to it in the ntfy phone app for done / failed / blocked pushes.
- `phaseTimeoutMin`, `maxAttempts` as needed.

Want a project-specific prompt? `phase-loop init --with-prompt` copies `phase-prompt.md` into the repo and points the config at it.

## Use

### Inside omp (live panel)

```
/phase-loop start @apps/ui/specs/plan.md --from 11 --to 15
```

The loop starts in the background and a **live panel** appears above the editor: one row per phase with a
progress bar, the current stage (agent working / verifying / committing), retries, the model, and the latest
output (refreshed every second), plus a footer status and a toast whenever a phase starts or the run ends.
You can keep using omp meanwhile.

- `/phase-loop watch` — show the panel again (e.g. after restarting omp) · `/phase-loop unwatch` — hide it
- `/phase-loop status` · `/phase-loop stop` · `/phase-loop stop --now` · `/phase-loop list <plan>` · `/phase-loop init`
- `/phase-loop <plan.md> …` and `/phase-loop run <plan.md> …` both mean `start`; add `--no-watch` to skip the panel

### In a terminal (full output, or over SSH from your phone)

```sh
phase-loop start plan.md --from 11 --to 15 --watch   # start in background and follow live
phase-loop watch                   # live dashboard: one row + bar per phase (Ctrl+C stops watching only)
phase-loop watch --raw             # plain log stream instead (also used when output isn't a terminal)
phase-loop status                  # progress, current phase, recent output
phase-loop stop                    # stop after the current phase
phase-loop stop --now              # kill the current phase immediately
phase-loop list plan.md            # check the phases were parsed
phase-loop run plan.md             # foreground run (Ctrl+C here stops the loop)
phase-loop run plan.md --dry-run   # print the prompt the first phase will get
```

Options for `start` / `run`: `--from 3`, `--to 5`, `--only 4`, `--force` (re-run completed phases), `--config file`.
Starting again after a stop or failure resumes from the first unfinished phase.

### About the progress bars

An agent can't report how far through a phase it is, so the bar is an **estimate**: elapsed time against the
average duration of the phases already finished in this run (capped at 95% until the phase really completes).
Until the first phase finishes there is no estimate, so the bar shows a moving block instead.
The stage label and done / retry / failed markers are exact.

## Which model runs each phase

Precedence, highest first:
1. a tag inside the phase in your plan: `<!-- model: anthropic/claude-sonnet-5-5 -->` (and optionally `<!-- thinking: low -->`)
2. `--model <provider/model>` / `--thinking <level>` on `start` / `run`
3. `model` / `thinking` in `loop.config.json`
4. omp's default model role

Good use: Opus for architecture-heavy phases, a tag on mechanical phases to run them on Sonnet.
You can always see it: `list` shows the model each pending phase will get, and the log line, `status`
and the omp panel show the model of the running phase; `status` also records it per completed phase.

## Plan format

Phase headings: `## Phase 1: Title`, `### Task 2 — Title`, `## Giai đoạn 3: …`, `## Bước 4: …`.
A phase runs until the next heading of the same or higher level. Headings inside code fences are ignored.
Best results: give each phase **Goal / Scope / Acceptance criteria**.

## What happens per phase

1. Writes `.loop/prompts/phase-N.md` (plan path, this phase's section, handoff notes) and runs `omp -p @that-file`.
2. The agent implements, self-checks, and writes `.loop/results/phase-N.json` (`done` / `blocked` + handoff notes).
3. The runner runs `verify`. On failure, a new fresh session gets the error output and fixes it (up to `maxAttempts`).
4. On success: appends to `.loop/HANDOFF.md`, commits `phase N: title`, continues.

Stops (and notifies) when a phase is **blocked** (needs a human), fails all attempts, or you run `stop`.

## Files

```
bin/phase-loop.ts        the CLI and loop engine
extension/index.ts       omp /phase-loop command (thin wrapper around the CLI)
templates/               default phase prompt + config used by `init`
```

Per project: `loop.config.json` and `.loop/` (state, handoff, logs; logs and state are git-ignored).

Tips: keep the machine awake (macOS `caffeinate -i phase-loop run plan.md`, or set Windows sleep to "Never"). Use omp ≥ 17.2.15 (older versions hang in `-p` mode when `plan.defaultOnStartup` is on).

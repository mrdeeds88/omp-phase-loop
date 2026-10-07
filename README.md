# phase-loop

**Run a long plan phase by phase, with no one watching.**

A big plan is too much for one agent session. The context fills up and the model loses track. So you split the plan into phases and do one per session: start a new session, paste in the next phase, wait, check the work, commit, and do it again. That's slow, and someone has to sit there the whole time.

phase-loop does those steps for you with **Oh My Pi**. Point it at your `plan.md` and it gives each phase its own fresh `omp -p` session. After each phase it runs your verify commands (typecheck, tests). If they fail, it opens a new session with the errors so the agent can fix them. When they pass, it commits and moves on to the next phase. Notes are carried from one phase to the next in `.loop/HANDOFF.md`, so each session knows what the earlier ones did.

It runs in the background, so you can close omp or the terminal and it keeps going. Follow it from a live `/phase-loop` panel in omp or with `phase-loop watch`, and get phone alerts through ntfy when the run finishes, fails, or needs a human.

```
/phase-loop start @specs/plan.md --from 1 --to 8
```

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
- `agentCmd` → add your model, e.g. `["omp", "-p", "--yolo", "--no-session", "--model", "anthropic/claude-opus-5-5"]`.
  Windows: if `omp` is a `.cmd` shim, use `["cmd", "/c", "omp", ...]`.
- `ntfyTopic` → a random string; subscribe to it in the ntfy phone app for done / failed / blocked pushes.
- `phaseTimeoutMin`, `maxAttempts` as needed.

Want a project-specific prompt? `phase-loop init --with-prompt` copies `phase-prompt.md` into the repo and points the config at it.

## Use

### Inside omp (live panel)

```
/phase-loop start @apps/ui/specs/plan.md --from 11 --to 15
```

The loop starts in the background and a **live panel** appears above the editor: progress, current phase,
attempt, elapsed time and the latest agent output (refreshed every 2 s), plus a footer status and a toast
whenever a phase starts or the run ends. You can keep using omp meanwhile.

- `/phase-loop watch` — show the panel again (e.g. after restarting omp) · `/phase-loop unwatch` — hide it
- `/phase-loop status` · `/phase-loop stop` · `/phase-loop stop --now` · `/phase-loop list <plan>` · `/phase-loop init`
- `/phase-loop <plan.md> …` and `/phase-loop run <plan.md> …` both mean `start`; add `--no-watch` to skip the panel

### In a terminal (full output, or over SSH from your phone)

```sh
phase-loop start plan.md --from 11 --to 15 --watch   # start in background and follow live
phase-loop watch                   # follow a run that's already going (Ctrl+C stops watching only)
phase-loop status                  # progress, current phase, recent output
phase-loop stop                    # stop after the current phase
phase-loop stop --now              # kill the current phase immediately
phase-loop list plan.md            # check the phases were parsed
phase-loop run plan.md             # foreground run (Ctrl+C here stops the loop)
phase-loop run plan.md --dry-run   # print the prompt the first phase will get
```

Options for `start` / `run`: `--from 3`, `--to 5`, `--only 4`, `--force` (re-run completed phases), `--config file`.
Starting again after a stop or failure resumes from the first unfinished phase.

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

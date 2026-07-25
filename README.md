# Local Tutor

An AI-powered, voice-enabled tutor for tech interview prep and learning frontend development (React, TypeScript, Node.js), Next.js, and building AI/LLM-powered applications. It simulates a live one-on-one class: the instructor speaks in short conversational turns, writes detail on a whiteboard, researches current material on the web, assigns runnable exercises with real test cases, runs mock interviews, pair-programs with you in your own editor, and tracks your progress — everything stored locally in SQLite.

Built with Electron + React + TypeScript, powered by the Claude API. Voice is fully local (whisper.cpp + macOS speech) — no cloud audio services.

## Setup

```sh
npm install
cp .env.example .env   # add your ANTHROPIC_API_KEY
npm run dev
```

An Anthropic API key is required (`.env`, exported in your shell, or an `ant auth login` profile).

## Install as an app

**Download:** grab the latest DMG from [Releases](https://github.com/shalakasurya/local-tutor/releases), open it, and drag **Local Tutor** to Applications (unsigned build — right-click → Open the first time). Apple Silicon only.

Or build it yourself:

```sh
npm run dist   # builds dist/Local Tutor-<version>-arm64.dmg (+ .zip)
```

Open the DMG and drag **Local Tutor** to Applications. The packaged app reads its config from `~/Library/Application Support/local-tutor/.env` (same keys as the dev `.env`) and shares that directory with dev builds — sessions, notes, and flashcards carry over. The whisper model belongs in `~/Library/Application Support/local-tutor/models/ggml-base.en.bin` for packaged use (or set `WHISPER_MODEL`). Builds are unsigned: on a different Mac, right-click → Open the first time to pass Gatekeeper.

Optional voice setup (speech-to-text):

```sh
npm run setup:voice   # installs whisper-cpp (Homebrew) + downloads the base.en model (~142MB)
```

## Features

### Live classroom
- **Conversational instructor** — streams short spoken-style replies; detail goes on a **whiteboard** (markdown, code, outlines) rather than into chat walls.
- **Whiteboard history** — every board is saved; page through them (◀ ▶), or **click any message in the transcript** to see the board as it stood at that moment.
- **Lesson plans** — the tutor researches current tutorials/docs with web search, then saves structured lesson plans you can continue later.
- **Session management** — sessions auto-title from your first message; rename (✎) or delete (🗑) from the sidebar. Everything restores on reopen: transcript, boards, exercises with your code.

### Exercises & REPL
- **Live editor** (CodeMirror) with per-language support: JS/TS run in Node; React (JSX/TSX), HTML, and CSS render in a sandboxed preview with console capture — all offline, no remote bundler.
- **Test cases** — JS/TS exercises come with tutor-authored tests: descriptions are visible ("What's tested"), assertions are hidden. ✓ Run tests shows a pass/fail checklist with real failure messages; per-case timeouts survive infinite loops. Submitting runs the tests, so grading is objective — and the tutor still reads your code, so hardcoding outputs earns coaching, not credit.
- **Autosave** — code persists as you type (debounced), across tab switches, exercise history paging (◀ ▶), and session switches.
- **Exercise history** — every assigned exercise in a session stays reachable with your solution intact.

### Voice
- **Three ways to talk**: click the 🎤 button; **⌥Space** (tap to toggle, hold for push-to-talk); or **🎙 Hands-free** — an open mic with voice-activity detection that transcribes and sends automatically when you pause (~1.2s).
- **Spoken replies** — sentence-streamed TTS starts speaking before the full reply is generated, with natural inter-sentence pacing. Toggle with 🔊; every past tutor message has a hover **replay** button.
- **Voice barge-in** — TTS plays through the app's own audio stack so Chrome's acoustic echo cancellation can subtract it from the mic: in hands-free mode you can **talk over the tutor** and it stops and listens, like a real person. (Best with decent speakers or headphones.)
- All voice is local: whisper.cpp for transcription, macOS `say` for speech. Background-noise hallucinations are filtered; ⌥Space mutes the open mic.

### Mock interviews
- Ask for a mock interview (behavioral, coding, frontend concepts, or system design; junior/mid/senior). The tutor switches to a realistic **interviewer persona**: one question at a time, probing follow-ups, hints only reluctantly, coding questions in the REPL.
- **Coach-like check-ins** — if you go silent (~25s), the interviewer speaks up naturally ("want to talk me through your approach?"), escalating toward a hint or moving on; working in the editor counts as activity, so it never interrupts real thinking.
- **Scored reports** — overall 0–100 plus per-dimension scores with written justification and per-question notes. The **Interviews tab** keeps every report (current session by default; all sessions one toggle away) so you can track improvement.

### Project mode (pair programming in your own editor)
- Attach a real project directory (Projects tab → "Attach folder…") or let the tutor create one — the native folder picker opens and **your choice of location is the consent**.
- Work in VS Code or any editor: the app watches the directory, shows changed files live, and the tutor reads your **actual code** (diffs since it last looked, individual files) before giving guidance. "Review changes" gets a full diff walkthrough.
- **Scaffolding with approval** — starter files go through a per-batch approve/reject dialog showing every file.
- **Pair-programming comments** (per-project toggle, off by default) — the tutor speaks up on its own ~45s after your edits settle, throttled to avoid chattiness.
- Change tracking uses a **shadow git repository** in app data: your project's own `.git` (or lack of one) is never touched; secrets, `node_modules`, and build output are never read or tracked.
- Switch a session's active project by clicking any project in the list.

### Library (your long-term study record)
- **Review** — a spaced-repetition queue built from the tutor's progress notes: struggling topics resurface after 1 day, learning after 3, solid after 7. One click asks the tutor to quiz you on what's due.
- **Lessons** — browse every saved lesson plan; "Continue this lesson" resumes with your progress in mind.
- **Progress** — per-topic mastery badges with the full history of the tutor's observations.

### Cost controls
- Conversation history and the system prompt are **prompt-cached** (repeat turns re-read history at ~10% of input price). Per-turn token usage is logged to the terminal.
- `.env` knobs: `TUTOR_MODEL` (default `claude-opus-4-8`; `claude-sonnet-5` is ~60% cheaper and snappier for voice) and `TUTOR_EFFORT` (`low` cuts the thinking pause before replies).
- Voice, the REPL, and project tracking are entirely local — zero API cost.

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Required — Claude API key |
| `TUTOR_MODEL` | Instructor model (default `claude-opus-4-8`) |
| `TUTOR_EFFORT` | Reasoning depth per reply: `low` / `medium` / `high` (default `medium`) |
| `WHISPER_BIN`, `WHISPER_MODEL` | Override speech-to-text binary/model paths |
| `SAY_VOICE`, `SAY_RATE` | TTS voice and speaking rate (premium voices via System Settings → Spoken Content sound much better, e.g. `SAY_VOICE=Zoe`) |

## Architecture

- `src/main/instructor.ts` — the Claude engine: streaming, tool loop, prompt caching, hidden-context injection (interview nudges, project awareness)
- `src/main/tools.ts` — instructor tools: whiteboard, lessons, exercises + tests, progress, interviews, projects, plus server-side web search/fetch
- `src/main/runner.ts` — exercise execution: Node child processes, esbuild bundling for React previews, the test harness
- `src/main/stt.ts` / `src/main/tts.ts` — local whisper transcription; TTS synthesis with renderer-side playback (echo-cancellation loop)
- `src/main/projects.ts` / `src/main/shadow.ts` — project watching, push-mode scheduling, shadow-git change tracking
- `src/main/db.ts` — SQLite persistence (sessions, transcripts, whiteboards, lessons, exercises, interviews, progress, projects)
- `src/renderer/` — React UI: sidebar, transcript, study panel (Whiteboard / Exercise / Interviews / Projects / Library), voice controls
- `src/shared/types.ts` — the shared domain + IPC contract

Data lives in the Electron `userData` directory (`local-tutor.db`, shadow repos under `shadow/`).

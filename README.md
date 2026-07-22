# Local Tutor

AI-powered tutor for tech interview prep and learning frontend development (React, TypeScript, Node.js), Next.js, and building AI/LLM-powered applications. Simulates a live one-on-one class: the instructor speaks in short conversational turns, writes detail on a whiteboard, generates lesson plans from current web material, assigns exercises, and tracks your progress — all stored locally in SQLite.

Built with Electron + React + TypeScript, powered by the Claude API.

## Setup

```sh
npm install
cp .env.example .env   # add your ANTHROPIC_API_KEY
npm run dev
```

An Anthropic API key is required (`.env`, or exported in your shell, or an `ant auth login` profile).

## Voice (optional)

```sh
npm run setup:voice   # installs whisper-cpp (Homebrew) + downloads the base.en model (~142MB)
```

Then in the app, three ways to talk:

- **Click** the 🎤 button (click again to stop, Esc to cancel)
- **⌥Space hotkey** — tap to start/stop recording, or hold it push-to-talk style (release to send)
- **🎙 Hands-free** toggle — the mic stays open; when you pause (~1.2s of silence) the segment is transcribed and sent automatically. Listening pauses itself while the tutor is speaking so it doesn't transcribe its own voice; ⌥Space mutes/unmutes.

Spoken replies use macOS's built-in `say`, streamed sentence-by-sentence as the instructor responds; toggle with "🔊 Voice replies". Speech stops instantly when you start talking, send a message, or interrupt.

Config (optional, in `.env`): `WHISPER_BIN`, `WHISPER_MODEL`, `SAY_VOICE`, `SAY_RATE`.

## Architecture (phase 1)

- `src/main/instructor.ts` — the Claude instructor engine: streaming responses, tool loop, prompt caching
- `src/main/tools.ts` — instructor tools: whiteboard, lesson plans, exercises, progress notes + server-side web search/fetch
- `src/main/db.ts` — SQLite persistence (sessions, transcripts, lessons, exercises, progress)
- `src/main/index.ts`, `src/main/ipc.ts`, `src/preload/index.ts` — Electron wiring
- `src/renderer/` — React UI: session sidebar, transcript, whiteboard, exercise pane
- `src/shared/types.ts` — the shared domain + IPC contract

Data lives in the Electron `userData` directory (`local-tutor.db`).

## Roadmap

1. ✅ Text tutor loop (this phase)
2. Live REPL (Monaco + Sandpack, run-code feedback to the instructor)
3. Richer curriculum generation and review/spaced-repetition UI
4. Voice: push-to-talk STT (whisper.cpp) + streaming TTS
5. Mock interview mode with scoring rubric

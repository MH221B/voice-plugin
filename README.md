# Voice plugin

A Windows-local, English-first speech plugin for completed OpenCode v2.2.6 TUI replies. The adapter selects an unambiguous final answer in the current session and sends it to a local Kokoro worker. It skips fenced code and non-answer content. Pi, streaming playback, and a hidden transcript transform are not provided.

The standard transcript may show raw voice tags. The plugin does not rewrite persisted text or make another model call. Kokoro has no direct emotion control; this plugin adjusts speed as a best-effort approximation, and emotions may not sound distinguishable.

## Install on Windows

You need OpenCode v2.2.6, Node.js and npm, Python 3.12, eSpeak NG, and a working audio output device. The worker uses the bundled eSpeak library when available on Windows without modifying PATH. Explicit `PHONEMIZER_ESPEAK_LIBRARY` and `PHONEMIZER_ESPEAK_DATA_PATH` settings are preserved. If bundled eSpeak is unavailable, install and configure eSpeak NG for phonemizer.

From the plugin directory in PowerShell:

```powershell
npm install
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
```

An npm peer warning under Node 22 is not a runtime blocker for the bundled OpenCode TUI. It is still worth inspecting other install errors.

Add the plugin to the TUI `cli.json` configuration, not the server plugin configuration. Replace both example paths with the actual absolute paths on your machine. JSON requires escaped backslashes:

```json
{
  "plugins": [
    {
      "package": "C:\\path\\to\\voice-plugin",
      "options": {
        "projectRoot": "C:\\path\\to\\voice-plugin",
        "python": "C:\\path\\to\\voice-plugin\\.venv\\Scripts\\python.exe",
        "voice": "af_heart",
        "speed": 1.0
      }
    }
  ]
}
```

The options are optional: the default root is the plugin root, Python is `<projectRoot>\.venv\Scripts\python.exe`, voice is `af_heart`, and speed is `1.0`. Paths must be absolute. Voice names must start with `af_`, `am_`, `bf_`, or `bm_`; speed must be a finite number between `0.7` and `1.3` inclusive.

Kokoro downloads model weights on first use, so the first request needs network access unless the weights are already cached. If model loading, phonemizer, or audio output fails, the written response remains intact and the plugin shows an error. Check network access and the model cache, eSpeak configuration, and the selected Windows audio device as appropriate. Fix the cause, then restart OpenCode if the worker failed; there is no automatic retry.

## Controls

In a session, `/voice-on` enables future speech, `/voice-off` disables it and cancels that session's current request, and `/voice-stop` cancels the current request without disabling future speech. The commands are also in the command palette. Speech starts enabled in each session and the setting is not persisted. A new answer cancels the previous request for that session. Synthesis already in progress cannot be forcibly interrupted, but its cancelled output is suppressed.

## Emotion markup

Opt in by asking the assistant, for example:

> When appropriate, mark emotional delivery with `[voice emotions="calm:0.3,reassuring:0.7"]Text[/voice]`. Use non-nested spans and weights from 0 to 1. Supported emotions are calm, excited, sad, reassuring, and serious. Leave ordinary prose untagged.

Untagged prose is neutral. Unknown names and invalid weights are ignored; a span with no valid weights is neutral. Tags can cover part of a sentence. Raw tags may remain visible in the transcript, but are removed from speech.

For each unit, the worker adds weighted adjustments to the configured baseline speed: `calm -0.12`, `excited +0.18`, `sad -0.16`, `reassuring -0.08`, and `serious -0.06`. It clamps the result to `0.7` through `1.3`. The configured voice and words do not change.

## Verification status

The standalone TUI plugin loaded, its commands appeared, and a home-screen command showed the no-session toast. Model weights downloaded and direct Kokoro synthesis succeeded. A real worker returned `ready` then `done`; a separate immediate cancellation returned `cancelled`. These observations do not establish audible playback or cancellation during playback. No OpenCode model turn or end-to-end audio has been verified. See [listening notes](docs/listening-check.md) and the [adapter contract](docs/adapter-contract.md).

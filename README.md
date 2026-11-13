# Voice plugin

A Windows-local, English-first speech plugin for completed OpenCode v2.2.6 TUI replies. The adapter selects an unambiguous final answer in the current session and sends it to a local Kokoro, Chatterbox Nano, or Chatterbox Turbo worker. It skips fenced code and non-answer content. Pi, streaming playback, and a hidden transcript transform are not provided.

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

For both backends, set `HF_TOKEN` in the environment before starting OpenCode to authenticate Hugging Face downloads. Blank or unset `HF_TOKEN` makes model downloads anonymous, even if a Hub login is cached. The worker overrides implicit-token and OIDC authentication settings for this purpose; it does not change your saved login or the parent environment. Already cached model files need no download. Restart OpenCode after changing the token.

## Optional Chatterbox setup

Kokoro remains the default. To isolate Chatterbox dependencies, run from the plugin directory in PowerShell:

```powershell
py -3.12 -m venv .venv-chatterbox
.\.venv-chatterbox\Scripts\python.exe -m pip install --upgrade pip
.\.venv-chatterbox\Scripts\python.exe -m pip install "git+https://github.com/resemble-ai/chatterbox.git@ab55923c27757c90cfcc407baa57dc25a7d25217" "sounddevice==0.5.6"
```

Git and network access are required. This pins the Chatterbox source revision, not every transitive dependency or model weight. Upstream pins PyTorch 2.6.0 and torchaudio 2.6.0 for Python 3.12; its tested environment is Python 3.11 on Debian, so Windows and alternative runtimes are not guaranteed. The upstream project is retired and unsupported. The separate environment does not install Kokoro; choose the matching executable for each backend.

Set `backend` to `chatterbox-nano` or `chatterbox-turbo` and `chatterboxPython` to the absolute path of that environment's `python.exe` in the existing plugin's `options`, for example:

```json
{
  "projectRoot": "C:\\path\\to\\voice-plugin",
  "backend": "chatterbox-nano",
  "chatterboxPython": "C:\\path\\to\\voice-plugin\\.venv-chatterbox\\Scripts\\python.exe",
  "referenceAudio": "C:\\path\\to\\voice-reference.wav"
}
```

`referenceAudio` is optional and must be an absolute path. Without it the selected model uses bundled conditioning, if available; otherwise supply a reference. Use a clean reference longer than five seconds; upstream examples use roughly ten seconds. Use only a voice you have permission to clone. `chatterboxPython` is optional and otherwise falls back to `python`. Existing `voice` and `speed` options are Kokoro-specific and do not alter Chatterbox output; emotion weights do not change Chatterbox speed or inject sounds.

The first use of a reference processes it and saves voice-derived conditioning in `.voice-cache` in the plugin directory. This directory is excluded from Git; its files still contain sensitive voice-derived data. Later requests and worker restarts reuse it, including when the reference file is absent, as long as `referenceAudio` still names the same path. Nano, Turbo, and different model weights use separate entries. When the reference is available, changes to its contents refresh the entry. A corrupt entry is rebuilt from the reference; if the reference is missing, restore it or remove the `referenceAudio` option to use bundled conditioning. Delete `.voice-cache` to remove all cached voices. The next use requires the reference again.

First use downloads large model files from Hugging Face and can take substantial time and disk space. Text can contain upstream native tags such as `[laugh]`, `[cough]`, and `[chuckle]`; preservation does not guarantee a particular audible effect. The worker attempts a PyTorch `cuda` device when the installed runtime reports one available, including compatible AMD runtimes exposing that interface. A load or synthesis failure retries on CPU before the current audio unit starts and shows a diagnostic toast; CPU inference may be slow. Installing a suitable AMD-compatible PyTorch runtime is hardware- and platform-specific and may conflict with upstream's exact PyTorch pins. Follow the runtime vendor's compatibility instructions in this separate environment; do not change system drivers based on this plugin. GPU availability alone does not prove inference works.

## Controls

In a session, `/voice-on` enables future speech, `/voice-off` disables it and cancels that session's current request, and `/voice-stop` cancels the current request without disabling future speech. The commands are also in the command palette. Speech starts enabled in each session and the setting is not persisted. A new answer cancels the previous request for that session. Synthesis already in progress cannot be forcibly interrupted, but its cancelled output is suppressed.

## Emotion markup

Opt in by asking the assistant, for example:

> When appropriate, mark emotional delivery with `[voice emotions="calm:0.3,reassuring:0.7"]Text[/voice]`. Use non-nested spans and weights from 0 to 1. Supported emotions are calm, excited, sad, reassuring, and serious. Leave ordinary prose untagged.

Untagged prose is neutral. Unknown names and invalid weights are ignored; a span with no valid weights is neutral. Tags can cover part of a sentence. Raw tags may remain visible in the transcript, but are removed from speech.

For each Kokoro unit, the worker adds weighted adjustments to the configured baseline speed: `calm -0.12`, `excited +0.18`, `sad -0.16`, `reassuring -0.08`, and `serious -0.06`. It clamps the result to `0.7` through `1.3`. The configured voice and words do not change.

## Verification status

TypeScript checking, 20 TypeScript tests, and 21 Python tests passed, including fake Chatterbox backends, CPU fallback, long-text splitting, sample rates, and cancellation. Nano and Turbo generated 24 kHz waveforms on CPU using a reference clip; GPU inference and listening have not been verified. The standalone TUI plugin previously loaded, its commands appeared, and a home-screen command showed the no-session toast. Model weights downloaded and direct Kokoro synthesis succeeded. A real worker returned `ready` then `done`; a separate immediate cancellation returned `cancelled`. These observations do not establish audible playback or cancellation during playback. No OpenCode model turn or end-to-end audio has been verified. See [listening notes](docs/listening-check.md) and the [adapter contract](docs/adapter-contract.md).

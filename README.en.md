# Omni

An AI agent on your phone, built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

One APK carries the whole agent runtime: the AI reads the screen, taps, swipes and types for you, and runs real commands in a built-in Linux environment. No root required.

## Features

- Phone control: with accessibility enabled, the AI reads screen content and performs taps, swipes, text input and screenshots
- Command execution: a built-in Termux environment runs bash for real
- Background operation: a foreground service keeps tasks running when you switch apps or lock the screen
- Plugins: new capabilities ship as DeepSeek Harness plugins without touching the core

## Install

| Item | Requirement |
|---|---|
| OS | Android 8.0+, arm64 |
| APK size | About 160 MB |
| Root | Not required |

1. Install the APK. The first launch unpacks the runtime and takes a few minutes; do not force-stop it
2. Follow the in-app prompts to enable accessibility and notifications
3. Enter your model API base URL and key in settings (OpenAI or Anthropic protocol)

On Xiaomi / HyperOS also enable autostart, set battery saver to "No restrictions", allow background pop-ups, and lock the app in recents.

## Development

- Android shell: `app/` (Kotlin)
- Engine plugins: `plugins/` (TypeScript, Cordis plugins)
- Build and environment: `docs/AGENTS/build-and-env.md`

## License

MIT, see [LICENSE](LICENSE). Third-party components are under their own licenses, see [`LICENSES/`](LICENSES) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

# Development workflow

[中文版](CONTRIBUTING.md)

Omni is an Android client for DeepSeek Harness. Read [`AGENTS.md`](AGENTS.md) first for the project map, build commands, and known pitfalls.

## Branches

| Branch | Purpose | Rule |
|---|---|---|
| `main` | Stable releases; what users install | Only accepts PRs from `dev`; no direct pushes |
| `dev` | Test builds; day-to-day work lands here | Merged via PR once PR Gate is green |
| `feat/…` `fix/…` `docs/…` `chore/…` | One change per branch | Branch from `dev`, delete after merge |
| `upgrade/dsh-<version>` | DeepSeek Harness engine upgrade | See "Engine upgrade" |

Commit messages: `<type>: <description>`, with type one of `feat` / `fix` / `docs` / `chore` / `refactor` / `test` / `ci`. One PR does one thing and can be reverted on its own.

## Day-to-day

1. Branch from the latest `dev`: `git switch dev && git pull && git switch -c feat/xxx`
2. Build and test locally (see `AGENTS.md`):
   ```bash
   ./gradlew :app:assembleDebug :app:testDebugUnitTest
   ```
3. If the change touches UI or device behavior, try it on a phone.
4. Push and open a PR against `dev`. Say what changed, why, and how it was verified. If it was not tried on a device, say so.
5. Merge once PR Gate is green, then delete the branch.

New UI text ships in both Chinese and English.

## Versioning

| Version | versionCode |
|---|---|
| 1.0.0 | 10000 |
| 1.0.1 … 1.0.99 | 10001 … 10099 |
| 1.1.0 | 10100 |

`versionCode = major × 10000 + minor × 100 + patch`, patch 0–99. Both live in `app/build.gradle.kts` and are bumped together on every release.

- Without a higher versionCode, Android refuses the in-place update.
- Without a higher versionName, the in-app update check always reports up to date.

## Releasing

1. On a `chore/release-1.0.x` branch from `dev`: bump the version, write `release/v1.0.x/notes.md`, merge into `dev`.
2. After the test build has been used on a phone without problems, open a PR from `dev` to `main`.
3. Run the `release` workflow in Actions with version `1.0.x`. It builds, runs the gates, and creates a draft Release with `omni-v1.0.x-arm64.apk` and `MANIFEST.txt`.
4. Check the draft, then publish it. The download site refreshes automatically.
5. Users update from "Check for updates" in the app; data is kept.

Every stable release must be signed with the same release key; changing it forces users to uninstall.

- The key never goes into the repository. CI restores it from Secrets (`OMNI_RELEASE_KEYSTORE_BASE64`, `OMNI_RELEASE_KEYSTORE_PASSWORD`, `OMNI_RELEASE_KEY_ALIAS`); see `scripts/ci/restore-release-key.sh`.
- For a releasable local build, `source ~/.omni-release/env.sh` before running Gradle. Without those variables the build is signed with the repository's `keystore/debug.keystore`, which the signature gate rejects; use it for local debugging only.
- The signature gate accepts only the certificate digest in `scripts/fixtures/apk-expected-cert.sha256`.

## Engine upgrade

When DeepSeek Harness publishes a new `@deepseek-ai/dsh` on npm:

1. Branch `upgrade/dsh-<version>` from `dev`.
2. Update the versions in `scripts/snapshot-config/engine-overlay.json`.
3. Review the runtime patches in `scripts/patches/`: drop ones the new release already fixes, re-target ones that no longer apply.
4. Rebuild the snapshot, run the gates and tests, verify on a phone.
5. Merge into `dev`, then follow "Releasing".

Prefer building features as plugins (`plugins/`) over changing the engine, so upgrades stay conflict-free.

## Before committing

```bash
git diff --check
git status --short
git diff --cached --stat
```

- Stage only the files for this change; avoid `git add .`.
- No debug leftovers, local paths, API keys, or device serials.
- Snapshots, APKs, and other large binaries stay out of git.

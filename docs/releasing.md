# Releasing

The desktop app is built for macOS (Apple silicon and Intel), Windows and Linux by [.github/workflows/release.yml](../.github/workflows/release.yml). It attaches the installers to a **draft** GitHub release, which a person reads over and publishes.

## Making a release

1. Set the version in `package.json` (the installers take it from there) and in `plugins/draftsman/.claude-plugin/plugin.json` (Claude Code updates the plugin when it changes) and move the `[Unreleased]` notes in `CHANGELOG.md` under that version.
2. Commit, then tag and push the tag: `git tag v0.3.0 && git push origin v0.3.0`. The workflow also runs from the Actions tab (Release, Run workflow) with the name of a tag that already exists and **Dry run** unticked.
3. The workflow checks that the tag matches `package.json`, makes the draft release, and builds on four machines at once. Each attaches what it made:

   | Build | Files |
   |---|---|
   | macOS, Apple silicon | `Draftsman_<version>_aarch64.dmg` |
   | macOS, Intel | `Draftsman_<version>_x64.dmg` |
   | Windows | `Draftsman_<version>_x64_en-US.msi` and `Draftsman_<version>_x64-setup.exe` |
   | Linux | `.deb`, `.rpm` and `.AppImage` |

   Each build's log also prints the SHA-256 of every file.
4. Open the draft on GitHub, write the notes from the changelog, and publish it.

## A dry run

To see that the installers build, without a tag or a release: in the Actions tab open Release, click **Run workflow**, pick the branch, leave the tag empty and **Dry run** ticked (the default), and run it. From the command line: `gh workflow run release.yml --ref main`.

A dry run builds on the same four machines from that branch, with signing on if its secrets exist, but skips the tag check and makes no release. Each machine's installers are kept as an artifact of the run (`installers-<target>`, downloadable from the run's page for 7 days), and the log prints each file's size and SHA-256. A dry run only reads the repository. With a tag given and Dry run ticked, it builds that tag the same way.

To build the same installers on your own machine: `npm run app:build` (it makes the ones for the system you are on, in `src-tauri/target/release/bundle/`).

## What the installers carry

The app itself, and one more file: the MCP server that connects Claude Code to the app window, bundled with the packages it uses into `dist-mcp/server.mjs` by `npm run build`. The installed app starts it with the user's own Node.js. It does not carry Claude Code or Node.

## Signing

Signing turns on by itself when the secrets below exist in the repository (Settings, Secrets and variables, Actions), and is skipped when they do not. Nothing else needs to change.

### macOS

| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE` | A "Developer ID Application" certificate with its private key, exported from Keychain Access as a `.p12` file, then base64-encoded (`base64 -i cert.p12`). Needs a paid Apple Developer account. |
| `APPLE_CERTIFICATE_PASSWORD` | The password you gave the `.p12` when exporting it. |
| `APPLE_SIGNING_IDENTITY` | The certificate's name, such as `Developer ID Application: Your Name (TEAMID)`. |
| `APPLE_ID` | The Apple ID email that notarizes the app. |
| `APPLE_PASSWORD` | An app-specific password for that Apple ID (made at account.apple.com), not its real password. |
| `APPLE_TEAM_ID` | The ten-character team ID from the Apple Developer account. |

The first three sign the app; the last three also notarize it, so macOS opens it without a warning. With the first three alone, the app is signed but not notarized, and the build log says so.

### Windows

| Secret | What it is |
|---|---|
| `WINDOWS_CERTIFICATE` | A code-signing certificate with its private key as a `.pfx` file, base64-encoded. |
| `WINDOWS_CERTIFICATE_PASSWORD` | The `.pfx` file's password. |

The workflow imports it on the build machine and signs the `.msi` and the setup `.exe` with it, time-stamped. Certificates whose key lives only in hardware or a cloud service (as most new ones do) cannot be exported as a `.pfx`; those need a signing step of their own, which this workflow does not have yet.

### Linux

The `.deb`, `.rpm` and `.AppImage` are not signed. People can check them against the SHA-256 sums in the build log.

## What an unsigned build means

Until the secrets above exist, the installers are unsigned (on macOS, signed "ad hoc", which Apple silicon needs to run the app at all). They work, but the system warns whoever opens them:

- **macOS** says it cannot check "Draftsman" for malicious software, or that it "is damaged and can't be opened". To open it anyway, open it once, then go to System Settings, Privacy & Security, and click **Open Anyway** next to the message about Draftsman. Or, in Terminal, after moving the app to Applications: `xattr -dr com.apple.quarantine "/Applications/Draftsman.app"`.
- **Windows** SmartScreen says "Windows protected your PC". Click **More info**, then **Run anyway**. The browser may also warn that the file is not commonly downloaded.
- **Linux** shows no warning. An AppImage needs to be made executable first: `chmod +x Draftsman*.AppImage`.

Say this in the release notes while builds are unsigned.

## Not checked yet

The workflow has not run yet. A dry run (above) is the way to prove the builds before the first tag. Its YAML and shell steps were checked locally, and `npm run app:build` was run on a Mac, but the Windows and Linux builds, signing and uploading have only been read over, not run.

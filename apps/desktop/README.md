# ForgeX Desktop

ForgeX Desktop is a Windows-first local client. The Electron main process runs the same ForgeX Agent runtime used by the CLI; the React renderer only talks to it through the typed preload bridge.

## Development

Requires Node.js 22.12 or newer and pnpm 11.20.

```powershell
pnpm install
pnpm desktop:dev
```

## Build a Windows installer

```powershell
pnpm desktop:package:win
```

The NSIS x64 installer is written to `apps/desktop/release/`. The packaged app includes its own Electron/Node runtime; users do not need Node.js installed.

## Configuration and data

- Model settings use the existing ForgeX `~/.forgex/config.json` and `~/.forgex/credentials.json` storage.
- Recent project paths are kept in Electron's per-user `userData/recent-projects.json` file.
- Sessions, project memory, audit events, and tool permissions continue to use the existing workspace/config paths.
- The project sidebar supports creating, renaming, and deleting sessions. Deletion hides the session from normal history while retaining its append-only event records; the active session cannot be deleted while a task is running.

## Security and platform limits

The renderer has Node integration disabled, context isolation and Chromium sandbox enabled, and a small allow-listed IPC API. The main process validates IPC senders and payloads. Agent permissions and OS sandbox support are still determined by the selected project's ForgeX configuration and the current platform provider; the desktop shell does not add a new OS sandbox.

The first packaged target is Windows x64. macOS and Linux packaging will need platform-specific verification, especially for native dependencies and sandbox providers.

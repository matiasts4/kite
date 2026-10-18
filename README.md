# Kite Code

Autonomous agentic development environment and native multi-model terminal desktop application built with React, TypeScript, Rust and Tauri 2.

## Key Features

- **Multi-Model Native Terminal**: Run and manage live CLI agents (Claude Code, Gemini, Codex, Antigravity, OpenCode, Cursor, and more).
- **Domain Workspaces**: Integrated file exploration, Git staging, diff views, and local repository tracking.
- **Agent Mind & Memory**: Configurable memory budgets, reflection modes, and persistent instruction synchronization.
- **Routines & Tasks**: Automated scheduled routines and agent task orchestration.
- **Offline & Local-First**: Built with local SQLite persistence and native ConPTY process management.

## Getting Started

### Development Mode

Run the local Vite development shell and Tauri backend:

```powershell
npm install
npm run dev
```

To launch the native desktop application in development mode:

```powershell
npm run app
```

### Building for Production

Compile the standalone native Windows installer:

```powershell
npm run build:installer
```

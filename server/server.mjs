import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const FRONTEND_DIR = process.env.SERVE_DIR ? path.resolve(ROOT_DIR, process.env.SERVE_DIR) : path.join(ROOT_DIR, "dist");
const DB_PATH = path.join(ROOT_DIR, "kite.sqlite3");

const app = express();
app.use(express.json({ limit: "50mb" }));

// Connect SQLite Database
let db = null;
try {
  if (fs.existsSync(DB_PATH)) {
    db = new DatabaseSync(DB_PATH);
    console.log(`[SQLite] Connected to ${DB_PATH}`);
  } else {
    const localDbPath = path.join(ROOT_DIR, "kite.sqlite3");
    db = new DatabaseSync(localDbPath);
    console.log(`[SQLite] Created local DB at ${localDbPath}`);
  }
} catch (e) {
  console.warn(`[SQLite] Warning: Could not connect to DB (${e.message}), using in-memory state`);
}

// Pre-authenticated Account State
const currentUser = {
  name: "Kite Developer",
  email: "developer@kite.local"
};

let currentAuthSnapshot = {
  schemaVersion: 2,
  revision: 1,
  phase: { kind: "signedIn" },
  access: { kind: "entitled" },
  user: currentUser,
  subscriptionTier: "ultra",
  features: {
    voice: true,
    assistant: true,
    kiteVerse: true,
    remote: true
  },
  includedCredits: 10000,
  canReopenBrowser: false,
  paymentRecovery: false
};

// Dictation Settings State
let currentDictationSettings = {
  schemaVersion: 1,
  mode: "cloud",
  localEngine: null,
  language: "es",
  deviceId: "default",
  cuesEnabled: true,
  shortcut: { key: "Space", modifiers: ["Control"] }
};

// Workspaces and Paths
const activeWorkspaces = [
  {
    id: "a1111111-1111-4111-8111-111111111111",
    displayName: "Workspace",
    createdAtUnixMs: Date.now() - 3600000,
    lastOpenedAtUnixMs: Date.now(),
    pinned: true,
    available: true
  },
  {
    id: "b2222222-2222-4222-8222-222222222222",
    displayName: "Kite Code",
    createdAtUnixMs: Date.now() - 1800000,
    lastOpenedAtUnixMs: Date.now(),
    pinned: false,
    available: true
  }
];

const workspacePaths = new Map([
  ["a1111111-1111-4111-8111-111111111111", "E:\\Workspace"],
  ["b2222222-2222-4222-8222-222222222222", "E:\\Kite"]
]);

const browserTestLane = process.env.KITE_BROWSER_TEST === "1";
const ANTIGRAVITY_AGENT_ID = "c3333333-3333-4333-8333-333333333333";

/** In-memory agent chat for browser test lane (Antigravity only). */
const agentChatThreads = new Map();
const agentChatRuns = new Map();

function agentsForLane() {
  if (browserTestLane) {
    return activeAgents.filter((a) => a.engine === "antigravity");
  }
  return activeAgents;
}

function makeEmptyThread(agentId, mode = "acceptEdits", model = null) {
  const threadId = randomUUID();
  const now = Date.now();
  return {
    schemaVersion: 1,
    revision: randomUUID().replace(/-/g, ""),
    id: threadId,
    profileId: agentId,
    provider: "antigravity",
    providerSessionId: null,
    title: "New Chat",
    items: [],
    mode,
    plan: false,
    model,
    status: "idle",
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    workspaceId: null,
    pinned: false,
    createdAtUnixMs: now,
    updatedAtUnixMs: now,
  };
}

function makeUserItem(text) {
  return {
    id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind: "user",
    text,
    title: null,
    detail: null,
    status: "completed",
    streaming: false,
    exitCode: null,
    createdAtUnixMs: Date.now(),
    attachments: [],
  };
}

function makeAssistantItem(text) {
  return {
    id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind: "assistant",
    text,
    title: null,
    detail: null,
    status: "completed",
    streaming: false,
    exitCode: null,
    createdAtUnixMs: Date.now(),
    attachments: [],
  };
}

let activeAgents = [
  {
    id: "c3333333-3333-4333-8333-333333333333",
    name: "Antigravity",
    engine: "antigravity",
    purpose: "Autonomous software engineering and code analysis assistant",
    avatar: null,
    createdAtUnixMs: Date.now() - 86400000,
    pinned: true,
    order: 0
  },
  {
    id: "d4444444-4444-4444-8444-444444444444",
    name: "Claude Code",
    engine: "claude-code",
    purpose: "Anthropic Claude coding agent in terminal",
    avatar: null,
    createdAtUnixMs: Date.now() - 86400000,
    pinned: false,
    order: 1
  },
  {
    id: "e5555555-5555-4555-8555-555555555555",
    name: "Gemini CLI",
    engine: "gemini",
    purpose: "Google DeepMind Gemini agent",
    avatar: null,
    createdAtUnixMs: Date.now() - 86400000,
    pinned: false,
    order: 2
  }
];

function stubAgentScript(meta = {}) {
  const agentName = meta.agentName || meta.displayName || "Agent";
  const engine = meta.engine || "antigravity";
  const task =
    meta.task ||
    "Refactorizar ipc.ts: separar shim web, carril navegador y comandos nativos.";
  return [
    `[${agentName}] ${engine} CLI — accept-edits mode`,
    `Task: ${task}`,
    `[${agentName}] Revisé src/lib/ipc.ts y el mock en server.mjs.`,
    `[${agentName}] Propuse extraer isBrowserTestLane y endurecer read_terminal_output simulado.`,
    `[${agentName}] Quedó esperando tu confirmación antes de editar archivos.`,
    "What would you like to do next?",
  ].join("\r\n");
}

function createStubTerminal(sessionId, meta = {}) {
  const session = new StubTerminalSession(sessionId, meta);
  return session;
}

/** Simulated PTY for browser test lane (no powershell spawn — avoids crashing the mock server). */
class StubTerminalSession {
  constructor(sessionId, meta = {}) {
    this.sessionId = sessionId;
    this.sequence = 0;
    this.meta = meta;
    this.outputBuffer = [Buffer.from(`${stubAgentScript(meta)}\r\n`)];
    this.waiters = [];
    this.exited = false;
    this.exitCode = 0;
    this.proc = null;
  }

  notifyWaiters() {
    while (this.waiters.length > 0) {
      const resolve = this.waiters.shift();
      resolve();
    }
  }

  async readOutput(timeoutMs = 5000) {
    if (this.outputBuffer.length === 0 && !this.exited) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          const idx = this.waiters.indexOf(resolve);
          if (idx !== -1) this.waiters.splice(idx, 1);
          resolve();
        }, timeoutMs);

        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    if (this.outputBuffer.length > 0) {
      const combined = Buffer.concat(this.outputBuffer);
      this.outputBuffer = [];
      return {
        kind: "output",
        sequence: this.sequence++,
        bytesBase64: combined.toString("base64"),
        turnStartedAtUnixMs: Date.now(),
        waitingForInput: false,
      };
    }

    if (this.exited) {
      return { kind: "exited", exitCode: this.exitCode ?? 0 };
    }

    return {
      kind: "idle",
      turnStartedAtUnixMs: Date.now(),
      waitingForInput: true,
    };
  }

  write(data) {
    this.outputBuffer.push(Buffer.from(String(data)));
    this.notifyWaiters();
  }

  terminate() {
    this.exited = true;
    this.exitCode = 0;
    this.notifyWaiters();
  }
}

// Interactive Terminal Session Class with Base64 output streaming
class TerminalSession {
  constructor(sessionId, cwd) {
    this.sessionId = sessionId;
    this.sequence = 0;
    this.outputBuffer = [];
    this.waiters = [];
    this.exited = false;
    this.exitCode = null;
    this.proc = null;

    try {
      this.proc = spawn("powershell.exe", ["-NoLogo"], {
        cwd: cwd || "E:\\Workspace",
        env: process.env
      });

      this.proc.on("error", (err) => {
        console.error(`Terminal spawn error for ${sessionId}:`, err.message);
        this.exited = true;
        this.exitCode = 1;
        this.outputBuffer.push(
          Buffer.from(`[terminal] No se pudo iniciar powershell: ${err.message}\r\n`)
        );
        this.notifyWaiters();
      });

      this.proc.stdout.on("data", (chunk) => {
        this.outputBuffer.push(chunk);
        this.notifyWaiters();
      });

      this.proc.stderr.on("data", (chunk) => {
        this.outputBuffer.push(chunk);
        this.notifyWaiters();
      });

      this.proc.on("exit", (code) => {
        this.exited = true;
        this.exitCode = code ?? 0;
        this.notifyWaiters();
      });
    } catch (err) {
      console.error(`Failed to spawn terminal process for ${sessionId}:`, err);
      this.exited = true;
      this.exitCode = 1;
    }
  }

  notifyWaiters() {
    while (this.waiters.length > 0) {
      const resolve = this.waiters.shift();
      resolve();
    }
  }

  async readOutput(timeoutMs = 5000) {
    if (this.outputBuffer.length === 0 && !this.exited) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          const idx = this.waiters.indexOf(resolve);
          if (idx !== -1) this.waiters.splice(idx, 1);
          resolve();
        }, timeoutMs);

        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    if (this.outputBuffer.length > 0) {
      const combined = Buffer.concat(this.outputBuffer);
      this.outputBuffer = [];
      return {
        kind: "output",
        sequence: this.sequence++,
        bytesBase64: combined.toString("base64"),
        turnStartedAtUnixMs: Date.now(),
        waitingForInput: false
      };
    }

    if (this.exited) {
      return {
        kind: "exited",
        exitCode: this.exitCode ?? 0
      };
    }

    return {
      kind: "idle",
      turnStartedAtUnixMs: Date.now(),
      waitingForInput: true
    };
  }

  write(data) {
    if (this.proc && this.proc.stdin && !this.proc.stdin.destroyed) {
      this.proc.stdin.write(data);
    }
  }

  terminate() {
    if (this.proc) {
      this.proc.kill();
    }
  }
}

const activeTerminalSessions = new Map();
let queuedEvents = [];

// Serve index.html with tauri-web-ipc.js injected
app.get(["/", "/index.html"], (req, res) => {
  const indexPath = path.join(FRONTEND_DIR, "index.html");
  if (!fs.existsSync(indexPath)) {
    return res.status(404).send("Frontend assets not found.");
  }
  let html = fs.readFileSync(indexPath, "utf8");
  if (!html.includes("/tauri-web-ipc.js")) {
    html = html.replace("<head>", `<head>\n    <script src="/tauri-web-ipc.js"></script>`);
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// Serve static frontend assets
app.use(express.static(FRONTEND_DIR));

// Background events endpoint
app.get("/api/tauri/events", (req, res) => {
  const events = [...queuedEvents];
  queuedEvents = [];
  res.json(events);
});

// Helper for resetting to entitled snapshot
function resetEntitledSnapshot() {
  currentAuthSnapshot = {
    schemaVersion: 2,
    revision: (currentAuthSnapshot.revision || 1) + 1,
    phase: { kind: "signedIn" },
    access: { kind: "entitled" },
    user: currentUser,
    subscriptionTier: "ultra",
    features: {
      voice: true,
      assistant: true,
      kiteVerse: true,
      remote: true
    },
    includedCredits: 10000,
    canReopenBrowser: false,
    paymentRecovery: false
  };
  return currentAuthSnapshot;
}

// Subscription Quotas Live Engine
let quotaCache = null;
let quotaCacheTime = 0;

async function getLiveQuotas(force = false) {
  if (!force && quotaCache && Date.now() - quotaCacheTime < 30000) {
    return quotaCache;
  }
  if (browserTestLane) {
    quotaCache = {
      antigravity: {
        providerId: "antigravity",
        displayName: "Antigravity",
        isAvailable: true,
        isAuth: true,
        primaryUsagePercent: 12,
        primaryRemainingPercent: 88,
        windows: [],
      },
    };
    quotaCacheTime = Date.now();
    return quotaCache;
  }
  const result = {};
  try {
    const devhubBase = "file:///D:/devhub/src/lib/quota/server";
    const adapters = {
      antigravity: () => import(`${devhubBase}/antigravity.js`).then((m) => m.fetchAntigravityQuota()),
      qoder: () => import(`${devhubBase}/qoder.js`).then((m) => m.fetchQoderQuota()),
      grok: () => import(`${devhubBase}/grok.js`).then((m) => m.fetchGrokQuota()),
      claude: () => import(`${devhubBase}/anthropic.js`).then((m) => m.fetchAnthropicQuota()),
      codex: () => import(`${devhubBase}/codex.js`).then((m) => m.fetchCodexQuota()),
      kimi: () => import(`${devhubBase}/kimi.js`).then((m) => m.fetchKimiQuota()),
      opencode: () => import(`${devhubBase}/opencode.js`).then((m) => m.fetchOpenCodeQuota()),
    };

    const keys = Object.keys(adapters);
    await Promise.all(
      keys.map(async (key) => {
        try {
          const q = await adapters[key]();
          if (q) result[key] = q;
        } catch (e) {
          result[key] = {
            providerId: key,
            displayName: key,
            isAvailable: false,
            isAuth: false,
            primaryUsagePercent: 0,
            primaryRemainingPercent: 100,
            windows: [],
            error: e.message,
          };
        }
      })
    );
  } catch (err) {
    console.warn("[Quota Server Fallback]", err);
  }
  quotaCache = result;
  quotaCacheTime = Date.now();
  return result;
}

app.get("/api/quota", async (req, res) => {
  const force = req.query.force === "1";
  const data = await getLiveQuotas(force);
  res.json(data);
});

// IPC Handler
app.post("/api/tauri/invoke", async (req, res) => {
  const { cmd, args } = req.body;
  const reqData = args?.request || args || {};

  try {
    switch (cmd) {
      // 1. Session & Auth
      case "auth_bootstrap":
      case "auth_snapshot":
      case "auth_retry_entitlement":
      case "auth_prewarm_sign_in":
      case "auth_cancel_sign_in":
      case "auth_reopen_sign_in": {
        return res.json(currentAuthSnapshot);
      }

      case "auth_begin_sign_in": {
        return res.json(resetEntitledSnapshot());
      }

      case "auth_sign_out": {
        currentAuthSnapshot = {
          schemaVersion: 2,
          revision: (currentAuthSnapshot.revision || 1) + 1,
          phase: { kind: "signedOut" },
          access: { kind: "unknown" },
          subscriptionTier: "free",
          features: {
            voice: false,
            assistant: false,
            kiteVerse: false,
            remote: false
          },
          canReopenBrowser: false,
          paymentRecovery: false
        };
        return res.json(currentAuthSnapshot);
      }

      case "auth_sign_in_diagnostics": {
        return res.json({ rejections: [] });
      }

      case "auth_open_upgrade":
      case "auth_open_terms":
      case "auth_open_privacy":
      case "auth_open_signup": {
        return res.json(true);
      }

      // 2. Application Bootstrap
      case "bootstrap": {
        const token = randomUUID();
        const laneAgents = agentsForLane();
        return res.json({
          browserDocumentToken: token,
          schemaVersion: 1,
          persistenceReadOnly: false,
          recoveryNotices: [],
          preferences: {
            schemaVersion: 1,
            workMode: browserTestLane ? "agent" : "code",
            route: browserTestLane ? { kind: "agent" } : { kind: "code" },
            selectedWorkspaceId: activeWorkspaces[0]?.id || null,
            selectedAgentId: browserTestLane
              ? laneAgents[0]?.id || ANTIGRAVITY_AGENT_ID
              : laneAgents[0]?.id || null,
            sidebarVisible: true,
            appearance: "dark",
            zoomPercent: 100,
            terminalPreference: { kind: "default" },
            usageMeter: { showPlanUsage: true, showPaneContext: true },
            darkTheme: "kite-dark",
            lightTheme: "kite-light",
            quitBehavior: "keepSessionsRunning"
          },
          workspaces: activeWorkspaces,
          agents: laneAgents
        });
      }

      // 3. Updates & Configuration
      case "update_configure": {
        return res.json({
          nativeUi: false,
          automatic: false,
          previewBuilds: null
        });
      }

      case "update_check": {
        return res.json({
          available: false,
          version: null,
          readyToInstall: false,
          nativeUi: false
        });
      }

      case "update_download":
      case "update_progress":
      case "update_restart":
      case "update_open_installer_download": {
        return res.json(true);
      }

      // 4. Telemetry
      case "telemetry_preferences": {
        return res.json({
          diagnostics: false,
          analytics: false
        });
      }

      case "telemetry_identity": {
        return res.json({
          revision: 1,
          ready: true,
          id: "0000000000000000000000000000000000000000000000000000000000000000"
        });
      }

      // 5. Tickets
      case "ticket_snapshot": {
        return res.json({
          schemaVersion: 1,
          revision: 1,
          issues: [],
          projects: [],
          labels: [],
          comments: [],
          history: [],
          connections: []
        });
      }

      case "ticket_call": {
        return res.json({ ok: true, result: null });
      }

      // 6. Agents & Mind
      case "get_agent_availability":
      case "probe_agent_availability":
      case "reprobe_agent_availability": {
        const engines = [
          "claude-code", "codex", "cursor", "gemini", "github-copilot",
          "droid", "open-code", "deep-seek", "grok", "kimi",
          "amp", "antigravity", "aider", "muse"
        ];
        return res.json(engines.map(engine => ({
          engine,
          installed: true,
          verified: true
        })));
      }

      case "list_agent_profiles": {
        return res.json(agentsForLane());
      }

      case "load_agent_profile": {
        const agentId = reqData.agentId || activeAgents[0]?.id;
        const agent = activeAgents.find(a => a.id === agentId) || activeAgents[0];
        return res.json({
          id: agent.id,
          name: agent.name,
          engine: agent.engine,
          brief: agent.purpose || "Autonomous software engineering agent.",
          avatar: null,
          createdAtUnixMs: agent.createdAtUnixMs || Date.now() - 86400000,
          defaultMode: null,
          defaultPlan: false,
          defaultModel: null,
          defaultProviderOptions: [],
          placeDisplayNames: [],
          memoryBudget: null,
          disabledPluginIDs: [],
          reflectionMode: "off",
          allowAgentScheduling: false,
          allowAgentMessaging: true
        });
      }

      case "load_agent_mind": {
        const agentId = reqData.agentId || activeAgents[0]?.id;
        return res.json({
          schemaVersion: 1,
          agentId,
          memory: "Kite agent session ready.",
          user: currentUser.name,
          skills: [],
          memoryUpdatedAtUnixMs: null,
          userUpdatedAtUnixMs: null,
          memoryRevision: null,
          userRevision: null,
          readIssues: []
        });
      }

      case "list_agent_starters": {
        return res.json([]);
      }

      case "list_agent_arrangement": {
        return res.json(activeAgents);
      }

      case "set_agent_pinned":
      case "move_agent": {
        return res.json(true);
      }

      case "list_agent_rail_activity": {
        return res.json([]);
      }

      case "create_agent": {
        const newAgent = {
          id: randomUUID(),
          name: reqData.name || "Custom Agent",
          engine: reqData.engine || "antigravity",
          purpose: reqData.purpose || "",
          avatar: reqData.avatar || null,
          createdAtUnixMs: Date.now(),
          pinned: false,
          order: activeAgents.length
        };
        activeAgents.push(newAgent);
        return res.json(newAgent);
      }

      case "update_agent_profile": {
        const idx = activeAgents.findIndex(a => a.id === reqData.agentId);
        if (idx !== -1) {
          activeAgents[idx] = { ...activeAgents[idx], ...reqData };
          return res.json(activeAgents[idx]);
        }
        return res.json(null);
      }

      case "delete_agent_profile": {
        activeAgents = activeAgents.filter(a => a.id !== reqData.agentId);
        return res.json(true);
      }

      // 7. Workspaces
      case "add_workspace": {
        const id = randomUUID();
        const root = reqData.canonicalRoot || "E:\\Workspace";
        const newWs = {
          id,
          displayName: reqData.displayName || path.basename(root) || "New Workspace",
          createdAtUnixMs: Date.now(),
          lastOpenedAtUnixMs: Date.now(),
          pinned: false,
          available: true
        };
        activeWorkspaces.push(newWs);
        workspacePaths.set(id, root);
        return res.json(newWs);
      }

      case "rename_workspace": {
        const ws = activeWorkspaces.find(w => w.id === reqData.workspaceId);
        if (ws) ws.displayName = reqData.name;
        return res.json(activeWorkspaces);
      }

      case "set_workspace_pinned": {
        const ws = activeWorkspaces.find(w => w.id === reqData.workspaceId);
        if (ws) ws.pinned = !!reqData.pinned;
        return res.json(activeWorkspaces);
      }

      case "remove_workspace_from_list": {
        const idx = activeWorkspaces.findIndex(w => w.id === reqData.workspaceId);
        if (idx !== -1) activeWorkspaces.splice(idx, 1);
        workspacePaths.delete(reqData.workspaceId);
        return res.json(activeWorkspaces);
      }

      case "load_workspace_layout": {
        const workspaceId = reqData.workspaceId || activeWorkspaces[0]?.id || "a1111111-1111-4111-8111-111111111111";
        return res.json({
          layout: {
            schemaVersion: 2,
            workspaceId,
            tabs: [],
            activeTabId: null,
            fullscreenLeafId: null
          },
          recoveryNotices: [],
          readOnly: false
        });
      }

      case "save_workspace_layout":
      case "save_shell_state":
      case "save_thread_grid":
      case "set_app_menu_state": {
        return res.json(null);
      }

      case "load_thread_grid": {
        return res.json({
          grid: null,
          recoveryNotices: [],
          readOnly: false
        });
      }

      // 8. Task Execution
      case "task_execution_snapshot":
      case "task_execution_refresh":
      case "task_execution_clear_error": {
        return res.json({
          schemaVersion: 1,
          available: false,
          runs: [],
          lastError: null
        });
      }

      // 9. Prompts
      case "list_prompts": {
        return res.json([]);
      }

      case "save_prompt":
      case "delete_prompt": {
        return res.json(true);
      }

      // 10. Notifications & Attention
      case "notifications_snapshot":
      case "notifications_poll":
      case "notifications_report_attention": {
        return res.json({
          revision: 1,
          unreadCount: 0,
          records: []
        });
      }

      case "notifications_mark_all_read":
      case "notifications_mark_read":
      case "notifications_play_sample": {
        return res.json(true);
      }

      // 11. Credits & Balance
      case "credits_balance": {
        return res.json({
          balance: 10000,
          included: 10000,
          remaining: 10000,
          plan: "Ultra",
          tier: "paid",
          renewsAtUnixMs: Date.now() + 86400000 * 30
        });
      }

      // 12. Complete ConPTY / PowerShell Terminal Sessions
      case "list_terminal_profiles": {
        return res.json({
          schemaVersion: 1,
          profiles: [
            { kind: "default" },
            { kind: "powerShell" },
            { kind: "commandPrompt" }
          ]
        });
      }

      case "start_terminal": {
        const sessionId = reqData.sessionId || randomUUID();
        const wsDir = workspacePaths.get(reqData.owner?.workspaceId) || "E:\\Workspace";
        if (browserTestLane) {
          activeTerminalSessions.set(
            sessionId,
            createStubTerminal(sessionId, {
              engine: reqData.engine || "antigravity",
              agentName: reqData.agentName || reqData.displayName,
              displayName: reqData.displayName || reqData.agentName,
            })
          );
        } else {
          activeTerminalSessions.set(sessionId, new TerminalSession(sessionId, wsDir));
        }
        return res.json({
          sessionId,
          attachedToExisting: false,
          host: { backend: "conpty", buildNumber: 22631 },
          restore: { kind: "newShell" }
        });
      }

      case "attach_terminal": {
        const sessionId = reqData.sessionId || randomUUID();
        if (!activeTerminalSessions.has(sessionId)) {
          const wsDir = workspacePaths.get(reqData.owner?.workspaceId) || "E:\\Workspace";
          if (browserTestLane) {
            activeTerminalSessions.set(sessionId, createStubTerminal(sessionId, {}));
          } else {
            activeTerminalSessions.set(sessionId, new TerminalSession(sessionId, wsDir));
          }
        }
        return res.json({
          sessionId,
          attachedToExisting: true,
          host: { backend: "conpty", buildNumber: 22631 },
          restore: { kind: "reattached" }
        });
      }

      case "read_terminal_output": {
        const session = activeTerminalSessions.get(reqData.sessionId);
        if (!session) {
          return res.json({ kind: "idle", waitingForInput: true });
        }
        const output = await session.readOutput(3000);
        return res.json(output);
      }

      case "write_terminal": {
        const session = activeTerminalSessions.get(reqData.sessionId);
        if (session && reqData.input) {
          session.write(reqData.input);
        }
        return res.json(null);
      }

      case "resize_terminal": {
        return res.json(null);
      }

      case "terminate_terminal": {
        const session = activeTerminalSessions.get(reqData.sessionId);
        if (session) {
          session.terminate();
          activeTerminalSessions.delete(reqData.sessionId);
        }
        return res.json({ terminated: true });
      }

      case "launch_workspace_terminals": {
        const seats = reqData.seats && reqData.seats.length > 0 ? reqData.seats : [{ engine: "terminal" }];
        const wsDir = workspacePaths.get(reqData.workspaceId) || "E:\\Workspace";
        const AGENT_CODENAMES = [
          "Orion", "Nova", "Atlas", "Vega", "Titan", "Echo", "Phoenix", "Lyra", "Apex", "Zenith",
          "Cygnus", "Helios", "Falcon", "Sirius", "Altair", "Polaris", "Castor", "Pollux", "Astra", "Cosmo",
          "Vortex", "Nebula", "Specter", "Sol", "Aura", "Quantum", "Nexus", "Pulse", "Ranger", "Draco"
        ];
        if (typeof globalThis._serverCodenameIndex !== "number") globalThis._serverCodenameIndex = 0;
        const slots = seats.map((seat, idx) => {
          const termId = randomUUID();
          const engine = seat.engine || "terminal";
          const isTerm = engine === "terminal" || engine === "powershell";
          const codename = seat.agentName || (isTerm ? null : AGENT_CODENAMES[globalThis._serverCodenameIndex++ % AGENT_CODENAMES.length]);
          if (browserTestLane) {
            activeTerminalSessions.set(
              termId,
              createStubTerminal(termId, {
                agentName: codename,
                displayName: codename,
                engine: isTerm ? "terminal" : engine,
              })
            );
          } else {
            activeTerminalSessions.set(termId, new TerminalSession(termId, wsDir));
          }
          const name = isTerm ? (seat.label || `Terminal ${idx + 1}`) : (codename || "Agent");
          return {
            index: idx,
            sessionId: termId,
            paneId: randomUUID(),
            engine,
            displayName: name,
            agentName: codename,
            roleLabel: seat.label || null,
            workTitle: name
          };
        });
        return res.json({
          requestId: reqData.requestId,
          attachedToExisting: false,
          slots
        });
      }

      case "restart_agent_terminal_for_autopilot":
      case "insert_terminal_drop_paths":
      case "insert_terminal_files_entry":
      case "stage_terminal_clipboard_image": {
        return res.json(true);
      }

      // 13. Voice Agents & Dictation
      case "read_dictation_availability": {
        return res.json({
          schemaVersion: 1,
          state: "ready",
          canRequestPermission: false,
          canStart: true,
          guidance: "Voice dictation is active."
        });
      }

      case "read_dictation_settings": {
        return res.json(currentDictationSettings);
      }

      case "update_dictation_settings": {
        if (reqData.settings) {
          currentDictationSettings = { ...currentDictationSettings, ...reqData.settings };
        }
        return res.json(currentDictationSettings);
      }

      case "list_dictation_input_devices": {
        return res.json({
          schemaVersion: 1,
          devices: [
            { id: "default", name: "Default Microphone (Realtek Audio)", isBluetooth: false },
            { id: "virtual", name: "Virtual Audio Input", isBluetooth: false }
          ],
          selectedId: "default"
        });
      }

      case "request_dictation_permission":
      case "request_agent_voice_input_permission": {
        return res.json({
          schemaVersion: 1,
          state: "ready",
          canRequestPermission: false,
          canStart: true,
          guidance: "Microphone permission active."
        });
      }

      case "read_agent_voice_input_availability": {
        return res.json({
          schemaVersion: 1,
          state: "ready",
          canRequestPermission: false,
          canStart: true,
          guidance: "Agent voice input is available."
        });
      }

      case "start_dictation": {
        return res.json({
          schemaVersion: 1,
          requestId: reqData.requestId || randomUUID(),
          phase: "listening",
          level: 0.7,
          transcript: "",
          error: null,
          draft: null
        });
      }

      case "read_dictation": {
        return res.json({
          schemaVersion: 1,
          requestId: reqData.requestId || randomUUID(),
          phase: "listening",
          level: 0.5,
          transcript: "Habla con Antigravity...",
          error: null,
          draft: null
        });
      }

      case "stop_dictation": {
        return res.json({
          schemaVersion: 1,
          requestId: reqData.requestId || randomUUID(),
          phase: "done",
          level: 0,
          transcript: "Dictado procesado.",
          error: null,
          draft: null
        });
      }

      case "cancel_dictation": {
        return res.json(true);
      }

      case "select_dictation_whisper_model": {
        return res.json({
          schemaVersion: 1,
          state: "ready",
          canRequestPermission: false,
          canStart: true,
          guidance: "Whisper local model ready."
        });
      }

      case "apply_voice_import":
      case "preview_voice_import": {
        return res.json({ ok: true });
      }

      case "start_agent_voice_create": {
        return res.json({
          schemaVersion: 1,
          requestId: reqData.requestId || randomUUID(),
          phase: "listening",
          level: 0.7,
          transcript: "",
          error: null,
          draft: null
        });
      }

      case "read_agent_voice_create": {
        return res.json({
          schemaVersion: 1,
          requestId: reqData.requestId || randomUUID(),
          phase: "listening",
          level: 0.5,
          transcript: "Diseñando agente por voz...",
          error: null,
          draft: null
        });
      }

      case "stop_agent_voice_create": {
        const newAgent = {
          id: randomUUID(),
          name: "Voice Specialist Agent",
          engine: "antigravity",
          purpose: "Agente generado vía comandos de voz en Kite Code",
          avatar: null,
          createdAtUnixMs: Date.now(),
          pinned: false,
          order: activeAgents.length
        };
        activeAgents.push(newAgent);
        return res.json({
          schemaVersion: 1,
          requestId: reqData.requestId || randomUUID(),
          phase: "done",
          level: 0,
          transcript: "Agente creado.",
          draft: {
            name: newAgent.name,
            brief: newAgent.purpose
          },
          error: null
        });
      }

      case "cancel_agent_voice_create": {
        return res.json(true);
      }

      case "voice_live_session": {
        return res.json({
          value: "0123456789012345678901234567890123456789012",
          model: "gpt-live-1",
          websocketUrl: "ws://127.0.0.1:8080/voice/live/ws"
        });
      }

      case "voice_live_connect":
      case "voice_live_send":
      case "voice_live_close": {
        return res.json(true);
      }

      case "voice_assistant_prompt": {
        return res.json({
          ok: true,
          prompt: "Instrucción de voz recibida."
        });
      }

      case "voice_context_read": {
        return res.json({
          summary: "Contexto del workspace activo cargado."
        });
      }

      case "voice_resolve_work": {
        return res.json({ resolved: true });
      }

      // 14. Filesystem API
      case "list_files_directory": {
        const targetPath = reqData.path || "E:\\Workspace";
        try {
          const entries = fs.readdirSync(targetPath, { withFileTypes: true });
          const items = entries.map(ent => ({
            name: ent.name,
            kind: ent.isDirectory() ? "directory" : "file",
            path: path.join(targetPath, ent.name),
            size: ent.isFile() ? fs.statSync(path.join(targetPath, ent.name)).size : 0
          }));
          return res.json({ items });
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case "read_files_text": {
        try {
          const content = fs.readFileSync(reqData.path, "utf8");
          return res.json({ content });
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      case "save_files_text": {
        try {
          fs.writeFileSync(reqData.path, reqData.content, "utf8");
          return res.json(true);
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      // 15. Chat and Agents Threads
      case "list_chat_summaries":
      case "list_agent_chat_summaries":
      case "list_live_chat_runs": {
        if (browserTestLane && cmd === "list_agent_chat_summaries") {
          const agentId = reqData.agentId;
          const summaries = [...agentChatThreads.values()]
            .filter((t) => !agentId || t.profileId === agentId)
            .map((t) => ({
              id: t.id,
              title: t.title,
              profileId: t.profileId,
              workspaceId: t.workspaceId,
              provider: t.provider,
              status: t.status,
              updatedAtUnixMs: t.updatedAtUnixMs,
              pinned: t.pinned,
            }));
          return res.json(summaries);
        }
        return res.json([]);
      }

      case "create_general_chat": {
        const thread = makeEmptyThread(null, reqData.mode || "acceptEdits", reqData.model || null);
        thread.provider = reqData.provider || "antigravity";
        thread.workspaceId = reqData.workspaceId || null;
        agentChatThreads.set(thread.id, thread);
        return res.json(thread);
      }

      case "create_agent_chat": {
        const agentId = reqData.agentId || ANTIGRAVITY_AGENT_ID;
        if (browserTestLane) {
          const profile = agentsForLane().find((a) => a.id === agentId);
          if (!profile || profile.engine !== "antigravity") {
            return res.status(400).json({
              code: "browser_lane_agent_only",
              message: "Browser test lane supports Antigravity agent only.",
            });
          }
        }
        const thread = makeEmptyThread(agentId, reqData.mode || "acceptEdits", reqData.model || null);
        agentChatThreads.set(thread.id, thread);
        return res.json(thread);
      }

      case "load_agent_chat_thread":
      case "load_chat_thread": {
        const tid = reqData.threadId;
        const existing = tid ? agentChatThreads.get(tid) : null;
        if (existing) {
          return res.json(existing);
        }
        const fallback = makeEmptyThread(reqData.agentId || null);
        if (tid) {
          fallback.id = tid;
          agentChatThreads.set(tid, fallback);
        }
        return res.json(fallback);
      }

      case "start_agent_chat_turn": {
        const threadId = reqData.threadId;
        let thread = agentChatThreads.get(threadId);
        if (!thread) {
          thread = makeEmptyThread(reqData.agentId || ANTIGRAVITY_AGENT_ID);
          thread.id = threadId;
          agentChatThreads.set(threadId, thread);
        }
        const promptText = String(reqData.prompt || reqData.text || "").trim();
        const replyText = `[Antigravity] ${promptText || "Listo."} (carril navegador — respuesta simulada.)`;
        const newItems = [];
        if (promptText) {
          newItems.push(makeUserItem(promptText));
        }
        const assistantItem = makeAssistantItem(replyText);
        newItems.push(assistantItem);
        thread.items = [...(thread.items || []), ...newItems];
        thread.status = "idle";
        thread.updatedAtUnixMs = Date.now();
        if (promptText && thread.title === "New Chat") {
          thread.title = promptText.slice(0, 48);
        }
        agentChatThreads.set(threadId, thread);
        const runId = randomUUID();
        agentChatRuns.set(runId, {
          threadId,
          nextSequence: 2,
          events: [
            { sequence: 1, kind: "upsert", item: assistantItem },
            { sequence: 2, kind: "finished", ok: true },
          ],
        });
        return res.json({ schemaVersion: 1, runId, thread });
      }

      case "start_chat_turn": {
        const threadId = reqData.threadId;
        let thread = agentChatThreads.get(threadId);
        if (!thread) {
          thread = makeEmptyThread(null);
          thread.id = threadId;
          agentChatThreads.set(threadId, thread);
        }
        const promptText = String(reqData.prompt || "").trim();
        const assistantItem = makeAssistantItem(`Echo: ${promptText || "…"}`);
        thread.items = [...(thread.items || []), assistantItem];
        thread.status = "idle";
        thread.updatedAtUnixMs = Date.now();
        const runId = randomUUID();
        agentChatRuns.set(runId, {
          threadId,
          nextSequence: 2,
          events: [
            { sequence: 1, kind: "upsert", item: assistantItem },
            { sequence: 2, kind: "finished", ok: true },
          ],
        });
        return res.json({ schemaVersion: 1, runId, thread });
      }

      case "read_agent_chat_turn_updates":
      case "read_chat_turn_updates": {
        const runId = reqData.runId;
        const afterSequence = Number(reqData.afterSequence || 0);
        const run = agentChatRuns.get(runId);
        if (!run) {
          return res.json({ schemaVersion: 1, runId, nextSequence: afterSequence, events: [] });
        }
        const events = run.events.filter((ev) => ev.sequence > afterSequence);
        return res.json({
          schemaVersion: 1,
          runId,
          nextSequence: run.nextSequence,
          events,
        });
      }

      case "operator_trace_append":
      case "operator_trace_path":
      case "show_in_folder": {
        return res.json(cmd === "operator_trace_path" ? "" : true);
      }

      case "proxy_operator_http": {
        const url = reqData.url;
        const method = (reqData.method || "GET").toUpperCase();
        const headers = reqData.headers || {};
        const body = reqData.body ?? null;
        const started = Date.now();
        try {
          const upstream = await fetch(url, { method, headers, body: body || undefined });
          const text = await upstream.text();
          return res.json({
            success: upstream.ok,
            status: upstream.status,
            body: text,
            latency_ms: Date.now() - started,
            error: upstream.ok ? null : upstream.statusText,
          });
        } catch (err) {
          return res.json({
            success: false,
            status: 0,
            body: "",
            latency_ms: Date.now() - started,
            error: err.message,
          });
        }
      }

      case "agent_message_inbox": {
        return res.json({ schemaVersion: 1, profileId: reqData.profileId, messages: [], nextCursor: null });
      }

      case "agent_messaging_preference": {
        return res.json({ schemaVersion: 1, enabled: false, readOnly: true, revision: "browser-lane" });
      }

      case "open_external_link": {
        const url = reqData.url;
        if (url) {
          spawn("cmd.exe", ["/c", "start", "", url], { detached: true });
        }
        return res.json(true);
      }

      case "get_subscription_quotas": {
        const force = Boolean(reqData.force);
        const data = await getLiveQuotas(force);
        return res.json(data);
      }

      case "get_system_metrics": {
        const memUsage = process.memoryUsage();
        const sysTotal = os.totalmem();
        const sysFree = os.freemem();
        const sysUsed = Math.max(0, sysTotal - sysFree);
        const sysPct = sysTotal > 0 ? Math.round((sysUsed / sysTotal) * 1000) / 10 : 0;
        const activeTermCount = activeTerminalSessions.size;
        const coreBytes = memUsage.rss || 140 * 1024 * 1024;
        const webviewBytes = 240 * 1024 * 1024;
        const termBytes = activeTermCount * 52 * 1024 * 1024;
        const appTotalBytes = coreBytes + webviewBytes + termBytes;
        const cpus = os.cpus() || [];
        let totalIdle = 0;
        let totalTick = 0;
        for (const cpu of cpus) {
          for (const type of Object.keys(cpu.times)) {
            totalTick += cpu.times[type];
          }
          totalIdle += cpu.times.idle;
        }
        const sysCpuPct = totalTick > 0 ? Math.round(((totalTick - totalIdle) / totalTick) * 1000) / 10 : 6.2;
        let diskTotal = 512 * 1024 * 1024 * 1024;
        let diskAvail = 280 * 1024 * 1024 * 1024;
        try {
          if (typeof fs.statfsSync === "function") {
            const st = fs.statfsSync(ROOT_DIR);
            diskTotal = st.blocks * st.bsize;
            diskAvail = st.bavail * st.bsize;
          }
        } catch (_) {}
        const diskUsed = Math.max(0, diskTotal - diskAvail);
        const diskPct = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 1000) / 10 : 45.0;
        let dbBytes = 0;
        try {
          if (fs.existsSync(DB_PATH)) dbBytes = fs.statSync(DB_PATH).size;
        } catch (_) {}

        return res.json({
          timestampMs: Date.now(),
          pid: process.pid,
          uptimeSeconds: Math.floor(process.uptime()),
          memory: {
            appTotalBytes,
            appCoreBytes: coreBytes + webviewBytes,
            appTerminalsBytes: termBytes,
            systemTotalBytes: sysTotal,
            systemUsedBytes: sysUsed,
            systemAvailableBytes: sysFree,
            systemUsagePercent: sysPct,
            appShareOfSystemPercent: sysTotal > 0 ? Math.round((appTotalBytes / sysTotal) * 1000) / 10 : 1.5,
            pressure:
              (sysFree < 900 * 1024 * 1024 && sysPct >= 94.0) || (sysTotal > 0 && appTotalBytes / sysTotal >= 0.5)
                ? "critical"
                : (sysTotal > 0 && appTotalBytes / sysTotal >= 0.3) || (sysFree < 1.8 * 1024 * 1024 * 1024 && (appTotalBytes / sysTotal) >= 0.18)
                ? "high"
                : (sysTotal > 0 && appTotalBytes / sysTotal >= 0.14) || appTotalBytes >= 4 * 1024 * 1024 * 1024
                ? "moderate"
                : (sysTotal > 0 && appTotalBytes / sysTotal < 0.04) && appTotalBytes < 650 * 1024 * 1024
                ? "low"
                : "normal"
          },
          cpu: {
            appUsagePercent: Math.min(100, Math.round((1.2 + activeTermCount * 0.6) * 10) / 10),
            systemUsagePercent: sysCpuPct,
            logicalCores: cpus.length || 8,
            model: cpus[0]?.model || "Multi-Core Processor"
          },
          disk: {
            mountPoint: path.parse(ROOT_DIR).root || "E:\\",
            totalBytes: diskTotal,
            usedBytes: diskUsed,
            availableBytes: diskAvail,
            usagePercent: diskPct,
            appCacheBytes: dbBytes
          },
          runtime: {
            activeTerminals: activeTermCount,
            processCount: 2 + activeTermCount,
            breakdown: [
              { id: "core", label: "Núcleo Host (Server / Rust)", memoryBytes: coreBytes, processCount: 1 },
              { id: "webview", label: "Motor UI (WebView2 / GPU)", memoryBytes: webviewBytes, processCount: 1 },
              { id: "terminals", label: "Terminales PTY & Agentes", memoryBytes: termBytes, processCount: activeTermCount }
            ]
          }
        });
      }

      default: {
        if (browserTestLane) {
          if (cmd.startsWith("list_")) return res.json([]);
          if (
            cmd.startsWith("save_") ||
            cmd.startsWith("set_") ||
            cmd.startsWith("cancel_") ||
            cmd.startsWith("delete_") ||
            cmd.startsWith("update_") ||
            cmd.startsWith("remove_") ||
            cmd.startsWith("release_")
          ) {
            return res.json(null);
          }
          console.warn(`[Browser lane unhandled] ${cmd}`);
          return res.json(null);
        }
        console.log(`[Tauri Mock Unhandled] ${cmd}`);
        return res.json({});
      }
    }
  } catch (err) {
    console.error(`[IPC Handler Exception] ${cmd}:`, err);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 1420;
app.listen(PORT, "127.0.0.1", () => {
  console.log(`
=====================================================
  Kite Code - Desktop Application
=====================================================
  Running at: http://127.0.0.1:${PORT}
  Account:    ${currentUser.name} (${currentUser.email})
  Tier:       Ultra Plan (Pre-authenticated)
  Frontend:   ${FRONTEND_DIR}
  Workspace:  E:\\Workspace & E:\\Kite
=====================================================
`);
});

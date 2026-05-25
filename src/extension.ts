import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

interface SessionInfo {
  name: string;
  windows: number;
  attached: boolean;
  created: string;
  activity: string;
}

interface WindowInfo {
  sessionName: string;
  index: number;
  name: string;
  active: boolean;
  panes: number;
  path: string;
}

interface PaneInfo {
  sessionName: string;
  windowIndex: number;
  index: number;
  id: string;
  pid: number;
  title: string;
  command: string;
  path: string;
  active: boolean;
  ports: PortInfo[];
}

interface PortInfo {
  address: string;
  port: number;
  pid: number;
  process: string;
}

interface SessionSnapshot {
  session: SessionInfo;
  windows: WindowInfo[];
  panes: PaneInfo[];
  primaryPath: string;
  primaryCommand: string;
  paneCount: number;
  ports: PortInfo[];
}

interface StyledSessionSnapshot extends SessionSnapshot {
  metaLine: string;
}

interface ProjectGroup {
  id: string;
  name: string;
  directory: string;
  isWorkspaceProject: boolean;
  gitStatusLabel: string;
  gitDirty: boolean;
  sessions: StyledSessionSnapshot[];
}

type ViewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "newSession" }
  | { type: "attachSession"; sessionName: string; directory?: string }
  | { type: "newWindow"; sessionName: string; directory?: string }
  | { type: "killSession"; sessionName: string }
  | { type: "previewPane"; paneId: string }
  | { type: "killPane"; paneId: string };

export function activate(context: vscode.ExtensionContext): void {
  const service = new TmuxService();
  const provider = new TmuxDashboardProvider(context, service);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("tmuxSessions", provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
    vscode.commands.registerCommand("tmuxManager.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("tmuxManager.newSession", () => provider.createSession()),
    vscode.commands.registerCommand("tmuxManager.newWindow", async () => {
      const sessions = await service.getSnapshot();
      if (sessions.length === 0) {
        vscode.window.showInformationMessage("No tmux sessions yet. Create one to get started.");
        return;
      }

      const picked = await vscode.window.showQuickPick(
        sessions.map((entry) => ({
          label: entry.session.name,
          description: entry.primaryPath || "unknown directory",
        })),
        { placeHolder: "Choose a tmux session" },
      );

      if (!picked) {
        return;
      }

      await provider.createWindow(picked.label, picked.description);
    }),
  );
}

export function deactivate(): void {}

class TmuxDashboardProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly tmux: TmuxService,
  ) {}

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async (message: ViewMessage) => {
      await this.handleMessage(message);
    });

    await this.pushState();
  }

  async refresh(): Promise<void> {
    await this.pushState();
  }

  async createSession(): Promise<void> {
    if (!(await this.tmux.ensureTmuxAvailable())) {
      return;
    }

    const sessionName = await vscode.window.showInputBox({
      prompt: "New tmux session name",
      placeHolder: "ponzi-api",
      validateInput: (value) => (value.trim() ? undefined : "Session name is required"),
    });

    if (!sessionName) {
      return;
    }

    const defaultDirectory = this.tmux.getDefaultDirectory();
    const directory = await vscode.window.showInputBox({
      prompt: "Working directory",
      value: defaultDirectory,
    });

    if (directory === undefined) {
      return;
    }

    await this.tmux.createSession(sessionName.trim(), directory || defaultDirectory);
    await this.pushState();
  }

  async createWindow(sessionName: string, directory?: string): Promise<void> {
    if (!(await this.tmux.ensureTmuxAvailable())) {
      return;
    }

    const windowName = await vscode.window.showInputBox({
      prompt: `New task for ${sessionName}`,
      placeHolder: "frontend",
      validateInput: (value) => (value.trim() ? undefined : "Task name is required"),
    });

    if (!windowName) {
      return;
    }

    const command = await vscode.window.showInputBox({
      prompt: "Command to run",
      placeHolder: "npm run dev",
    });

    if (command === undefined) {
      return;
    }

    const cwd = await vscode.window.showInputBox({
      prompt: "Working directory",
      value: directory || this.tmux.getDefaultDirectory(),
    });

    if (cwd === undefined) {
      return;
    }

    await this.tmux.createWindow(sessionName, windowName.trim(), command.trim(), cwd || this.tmux.getDefaultDirectory());
    await this.pushState();
  }

  private async handleMessage(message: ViewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
      case "refresh":
        await this.pushState();
        return;
      case "newSession":
        await this.createSession();
        return;
      case "attachSession":
        await this.tmux.attachSession(message.sessionName, message.directory);
        return;
      case "newWindow":
        await this.createWindow(message.sessionName, message.directory);
        return;
      case "killSession":
        await this.killSession(message.sessionName);
        return;
      case "previewPane":
        await this.tmux.previewPane(message.paneId);
        return;
      case "killPane":
        await this.killPane(message.paneId);
        return;
      default:
        return;
    }
  }

  private async killSession(sessionName: string): Promise<void> {
    if (!(await this.tmux.ensureTmuxAvailable())) {
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Kill tmux session ${sessionName}?`,
      { modal: true },
      "Kill",
    );

    if (confirmed !== "Kill") {
      return;
    }

    await this.tmux.killSession(sessionName);
    await this.pushState();
  }

  private async killPane(paneId: string): Promise<void> {
    if (!(await this.tmux.ensureTmuxAvailable())) {
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Kill pane ${paneId}?`,
      { modal: true },
      "Kill",
    );

    if (confirmed !== "Kill") {
      return;
    }

    await this.tmux.killPane(paneId);
    await this.pushState();
  }

  private async pushState(): Promise<void> {
    if (!this.view) {
      return;
    }

    try {
      const projects = await this.tmux.getProjects();
      this.view.webview.postMessage({
        type: "state",
        projects,
        workspaceName: vscode.workspace.name ?? "current project",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to read tmux sessions";
      this.view.webview.postMessage({
        type: "error",
        message,
      });
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = createNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: dark light;
      --bg: var(--vscode-sideBar-background);
      --panel: color-mix(in srgb, var(--vscode-sideBar-background) 84%, var(--vscode-editor-background));
      --panel-strong: color-mix(in srgb, var(--vscode-sideBar-background) 72%, var(--vscode-editor-background));
      --panel-hover: color-mix(in srgb, var(--vscode-list-hoverBackground) 70%, transparent);
      --border: color-mix(in srgb, var(--vscode-sideBar-border, transparent) 40%, var(--vscode-editorWidget-border, transparent));
      --text: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --accent: #4ea1ff;
      --accent-soft: color-mix(in srgb, var(--accent) 18%, transparent);
      --danger: #ff6b6b;
      --warning: #f7c86a;
      --ok: #55d48a;
      --shadow: 0 14px 30px rgba(0, 0, 0, 0.18);
      --radius: 14px;
      --mono: "JetBrains Mono", "Cascadia Code", monospace;
      --sans: "Segoe UI", system-ui, sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 10px 10px 18px;
      background:
        radial-gradient(circle at top right, rgba(78, 161, 255, 0.14), transparent 34%),
        radial-gradient(circle at top left, rgba(85, 212, 138, 0.1), transparent 24%),
        var(--bg);
      color: var(--text);
      font: 13px/1.4 var(--sans);
    }

    .app {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));
      box-shadow: var(--shadow);
    }

    .toolbar-title {
      font-size: 11px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--muted);
      margin-right: auto;
    }

    .icon-btn {
      border: 1px solid transparent;
      background: transparent;
      color: var(--text);
      width: 28px;
      height: 28px;
      border-radius: 9px;
      cursor: pointer;
      display: grid;
      place-items: center;
      font-size: 14px;
      transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
    }

    .icon-btn:hover {
      background: var(--panel-hover);
      border-color: var(--border);
      transform: translateY(-1px);
    }

    .empty,
    .error {
      padding: 14px;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--muted);
    }

    .error {
      color: #ffb1b1;
    }

    .project {
      border: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));
      border-radius: 16px;
      overflow: hidden;
      box-shadow: var(--shadow);
    }

    .project + .project {
      margin-top: 2px;
    }

    .project-header {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 12px 12px 11px;
      background: linear-gradient(180deg, rgba(78,161,255,0.08), rgba(78,161,255,0.02));
      border: 0;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }

    .project-header:hover {
      background: linear-gradient(180deg, rgba(78,161,255,0.14), rgba(78,161,255,0.05));
    }

    .chevron {
      width: 10px;
      color: var(--muted);
      transition: transform 120ms ease;
      flex: 0 0 auto;
    }

    details[open] > .project-header .chevron,
    details[open] > summary .chevron {
      transform: rotate(90deg);
    }

    summary {
      list-style: none;
    }

    summary::-webkit-details-marker {
      display: none;
    }

    .project-icon {
      width: 19px;
      height: 19px;
      border-radius: 6px;
      border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--border));
      background: linear-gradient(135deg, rgba(78,161,255,0.2), rgba(78,161,255,0.06));
      display: grid;
      place-items: center;
      font-size: 11px;
      color: var(--accent);
      flex: 0 0 auto;
    }

    .project-copy {
      min-width: 0;
      flex: 1;
    }

    .project-name {
      font-size: 14px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .project-meta {
      margin-top: 2px;
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--warning);
      box-shadow: 0 0 0 3px rgba(247, 200, 106, 0.12);
      flex: 0 0 auto;
    }

    .status-dot.clean {
      background: var(--ok);
      box-shadow: 0 0 0 3px rgba(85, 212, 138, 0.12);
    }

    .status-label {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .project-count {
      padding: 3px 8px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: #dceeff;
      font: 600 11px/1 var(--mono);
      flex: 0 0 auto;
    }

    .session-list {
      padding: 4px 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .session-card {
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 12px;
      overflow: hidden;
      background: var(--panel);
    }

    .session-header {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 9px 10px;
      border: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      text-align: left;
    }

    .session-header:hover {
      background: var(--panel-hover);
    }

    .session-left {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      flex: 1;
    }

    .terminal-badge {
      width: 18px;
      height: 18px;
      border-radius: 5px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.08);
      display: grid;
      place-items: center;
      color: var(--muted);
      font-size: 11px;
      flex: 0 0 auto;
    }

    .session-copy {
      min-width: 0;
      flex: 1;
    }

    .session-name-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .session-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }

    .attached-pill {
      border-radius: 999px;
      padding: 2px 6px;
      background: rgba(85, 212, 138, 0.14);
      color: #bdf4cf;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      flex: 0 0 auto;
    }

    .session-meta {
      color: var(--muted);
      font-size: 12px;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .session-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 0 0 auto;
    }

    .mini-btn {
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted);
      width: 24px;
      height: 24px;
      border-radius: 8px;
      cursor: pointer;
      display: grid;
      place-items: center;
      font-size: 13px;
    }

    .mini-btn:hover {
      border-color: var(--border);
      background: rgba(255,255,255,0.05);
      color: var(--text);
    }

    .mini-btn.danger:hover {
      color: #ffc7c7;
      border-color: rgba(255, 107, 107, 0.3);
      background: rgba(255, 107, 107, 0.08);
    }

    .windows {
      padding: 0 10px 10px 34px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .window-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 8px;
      border-radius: 10px;
      background: rgba(255,255,255,0.02);
      border: 1px solid rgba(255,255,255,0.04);
    }

    .window-index {
      color: var(--muted);
      font: 600 11px/1 var(--mono);
      min-width: 18px;
    }

    .window-main {
      min-width: 0;
      flex: 1;
    }

    .window-command {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text);
    }

    .window-sub {
      margin-top: 2px;
      color: var(--muted);
      font-size: 11px;
      font-family: var(--mono);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .window-meta {
      color: var(--muted);
      font-size: 11px;
      flex: 0 0 auto;
      white-space: nowrap;
    }

    .port-list {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
      margin-top: 5px;
    }

    .port-chip {
      border: 1px solid rgba(85, 212, 138, 0.22);
      background: rgba(85, 212, 138, 0.1);
      color: #bdf4cf;
      border-radius: 999px;
      padding: 2px 6px;
      font: 600 10px/1.2 var(--mono);
    }

    .session-ports {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: 4px;
    }

    .hidden {
      display: none;
    }
  </style>
</head>
<body>
  <div class="app">
    <div class="toolbar">
      <div class="toolbar-title">TMUX Dashboard</div>
      <button class="icon-btn" data-action="refresh" title="Refresh">↻</button>
      <button class="icon-btn" data-action="newSession" title="New Session">＋</button>
    </div>
    <div id="content"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const content = document.getElementById("content");

    function escapeHtml(value) {
      return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function renderState(projects) {
      if (!projects.length) {
        content.innerHTML = '<div class="empty">No tmux sessions yet. Create one to get started with the plus button.</div>';
        return;
      }

      content.innerHTML = projects.map((project, projectIndex) => {
        const projectOpen = projectIndex === 0 ? "open" : "";
        const statusClass = project.gitDirty ? "" : "clean";
        const sessionCards = project.sessions.map((session, sessionIndex) => {
          const sessionOpen = sessionIndex === 0 ? "open" : "";
          const attached = session.session.attached ? '<span class="attached-pill">attached</span>' : "";
          const sessionPorts = session.ports.length
            ? '<span class="session-ports">' + session.ports.slice(0, 3).map((port) =>
              '<span class="port-chip" title="' + escapeHtml(port.process + ' pid ' + port.pid + ' on ' + port.address) + '">:' + escapeHtml(String(port.port)) + '</span>'
            ).join("") + (session.ports.length > 3 ? '<span class="port-chip">+' + escapeHtml(String(session.ports.length - 3)) + '</span>' : "") + '</span>'
            : "";
          const windows = session.windows.map((windowInfo) => {
            const pane = session.panes.find((entry) => entry.windowIndex === windowInfo.index && entry.active)
              || session.panes.find((entry) => entry.windowIndex === windowInfo.index)
              || null;

            const paneCommand = pane ? (pane.command || pane.title || "shell") : (windowInfo.name || "window");
            const panePath = pane ? pane.path : windowInfo.path;
            const paneId = pane ? pane.id : "";
            const portChips = pane && pane.ports.length
              ? '<div class="port-list">' + pane.ports.map((port) =>
                '<span class="port-chip" title="' + escapeHtml(port.process + ' pid ' + port.pid + ' on ' + port.address) + '">:' + escapeHtml(String(port.port)) + '</span>'
              ).join("") + '</div>'
              : "";
            const previewButton = paneId
              ? '<button class="mini-btn" data-action="previewPane" data-pane-id="' + escapeHtml(paneId) + '" title="Preview">◫</button>'
              : "";
            const killButton = paneId
              ? '<button class="mini-btn danger" data-action="killPane" data-pane-id="' + escapeHtml(paneId) + '" title="Kill Pane">⌫</button>'
              : "";

            return '<div class="window-row">'
              + '<div class="window-index">' + escapeHtml(String(windowInfo.index)) + '</div>'
              + '<div class="window-main">'
              + '<div class="window-command">' + escapeHtml(paneCommand) + '</div>'
              + '<div class="window-sub">' + escapeHtml(panePath || "unknown path") + '</div>'
              + portChips
              + '</div>'
              + '<div class="window-meta">' + escapeHtml(String(windowInfo.panes)) + 'p</div>'
              + previewButton
              + killButton
              + '</div>';
          }).join("");

          return '<details class="session-card" ' + sessionOpen + '>'
            + '<summary class="session-header">'
            + '<div class="session-left">'
            + '<div class="chevron">›</div>'
            + '<div class="terminal-badge">⌘</div>'
            + '<div class="session-copy">'
            + '<div class="session-name-row">'
            + '<div class="session-name">' + escapeHtml(session.session.name) + '</div>'
            + attached
            + sessionPorts
            + '</div>'
            + '<div class="session-meta">' + escapeHtml(session.primaryCommand) + ' · ' + escapeHtml(session.metaLine) + '</div>'
            + '</div>'
            + '</div>'
            + '<div class="session-actions">'
            + '<button class="mini-btn" data-action="attachSession" data-session-name="' + escapeHtml(session.session.name) + '" data-directory="' + escapeHtml(session.primaryPath) + '" title="Open">▷</button>'
            + '<button class="mini-btn" data-action="newWindow" data-session-name="' + escapeHtml(session.session.name) + '" data-directory="' + escapeHtml(session.primaryPath) + '" title="New Task">＋</button>'
            + '<button class="mini-btn danger" data-action="killSession" data-session-name="' + escapeHtml(session.session.name) + '" title="Kill">⌫</button>'
            + '</div>'
            + '</summary>'
            + '<div class="windows">' + windows + '</div>'
            + '</details>';
        }).join("");

        return '<details class="project" ' + projectOpen + '>'
          + '<summary class="project-header">'
          + '<div class="chevron">›</div>'
          + '<div class="project-icon">' + (project.isWorkspaceProject ? "⌂" : "□") + '</div>'
          + '<div class="project-copy">'
          + '<div class="project-name">' + escapeHtml(project.name) + '</div>'
          + '<div class="project-meta">'
          + '<span class="status-dot ' + statusClass + '"></span>'
          + '<span class="status-label">' + escapeHtml(project.gitStatusLabel) + '</span>'
          + '</div>'
          + '</div>'
          + '<div class="project-count">' + escapeHtml(String(project.sessions.length)) + 't</div>'
          + '</summary>'
          + '<div class="session-list">' + sessionCards + '</div>'
          + '</details>';
      }).join("");
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "state") {
        renderState(message.projects);
      }
      if (message.type === "error") {
        content.innerHTML = '<div class="error">' + escapeHtml(message.message) + '</div>';
      }
    });

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const actionTarget = target.closest("[data-action]");
      if (!(actionTarget instanceof HTMLElement)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const action = actionTarget.dataset.action;
      if (action === "refresh") {
        vscode.postMessage({ type: "refresh" });
      } else if (action === "newSession") {
        vscode.postMessage({ type: "newSession" });
      } else if (action === "attachSession") {
        vscode.postMessage({
          type: "attachSession",
          sessionName: actionTarget.dataset.sessionName,
          directory: actionTarget.dataset.directory,
        });
      } else if (action === "newWindow") {
        vscode.postMessage({
          type: "newWindow",
          sessionName: actionTarget.dataset.sessionName,
          directory: actionTarget.dataset.directory,
        });
      } else if (action === "killSession") {
        vscode.postMessage({
          type: "killSession",
          sessionName: actionTarget.dataset.sessionName,
        });
      } else if (action === "previewPane") {
        vscode.postMessage({
          type: "previewPane",
          paneId: actionTarget.dataset.paneId,
        });
      } else if (action === "killPane") {
        vscode.postMessage({
          type: "killPane",
          paneId: actionTarget.dataset.paneId,
        });
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

class TmuxService {
  async getProjects(): Promise<ProjectGroup[]> {
    const sessions = await this.getSnapshot();
    const byProject = new Map<string, SessionSnapshot[]>();

    for (const session of sessions) {
      const directory = session.primaryPath || this.getDefaultDirectory();
      const projectKey = this.getProjectDirectory(directory);
      const existing = byProject.get(projectKey) ?? [];
      existing.push(session);
      byProject.set(projectKey, existing);
    }

    const projects: ProjectGroup[] = [];
    for (const [directory, projectSessions] of byProject.entries()) {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const isWorkspaceProject = workspaceRoot ? this.isSameOrParent(directory, workspaceRoot) || this.isSameOrParent(workspaceRoot, directory) : false;
      const git = await this.inspectGit(directory);
      const name = isWorkspaceProject ? (vscode.workspace.name ?? path.basename(directory)) : path.basename(directory) || directory;

      projects.push({
        id: directory,
        name,
        directory,
        isWorkspaceProject,
        gitStatusLabel: git.label,
        gitDirty: git.dirty,
        sessions: projectSessions
          .sort((left, right) => left.session.name.localeCompare(right.session.name))
          .map((entry) => ({
            ...entry,
            metaLine: `${entry.paneCount}p · ${entry.session.activity}`,
          })),
      });
    }

    return projects
      .sort((left, right) => {
        if (left.isWorkspaceProject && !right.isWorkspaceProject) {
          return -1;
        }
        if (!left.isWorkspaceProject && right.isWorkspaceProject) {
          return 1;
        }
        return left.name.localeCompare(right.name);
      });
  }

  async getSnapshot(): Promise<SessionSnapshot[]> {
    if (!(await this.ensureTmuxAvailable(false))) {
      return [];
    }

    const sessions = await this.listSessions();
    const listeningPorts = await this.listListeningPorts();
    const processChildren = await this.listProcessChildren();
    const snapshots = await Promise.all(
      sessions.map(async (session) => {
        const windows = await this.listWindows(session.name);
        const panesByWindow = await Promise.all(
          windows.map((windowInfo) => this.listPanes(session.name, windowInfo.index)),
        );
        const panes = panesByWindow.flat().map((pane) => ({
          ...pane,
          ports: this.getPanePorts(pane.pid, listeningPorts, processChildren),
        }));
        const primaryPane = panes.find((pane) => pane.active) ?? panes[0];
        const primaryWindow = windows.find((windowInfo) => windowInfo.active) ?? windows[0];
        const ports = dedupePorts(panes.flatMap((pane) => pane.ports));

        return {
          session,
          windows,
          panes,
          primaryPath: primaryPane?.path || primaryWindow?.path || "",
          primaryCommand: primaryPane?.command || primaryWindow?.name || "shell",
          paneCount: panes.length,
          ports,
        };
      }),
    );

    return snapshots;
  }

  async createSession(name: string, directory: string): Promise<void> {
    await this.runTmux(["new-session", "-d", "-s", name, "-c", directory]);
  }

  async createWindow(sessionName: string, windowName: string, command: string, directory: string): Promise<void> {
    const args = ["new-window", "-t", sessionName, "-n", windowName, "-c", directory];
    if (command) {
      args.push(command);
    }

    await this.runTmux(args);
  }

  async attachSession(sessionName: string, directory?: string): Promise<void> {
    const terminal = vscode.window.createTerminal({
      name: `tmux:${sessionName}`,
      cwd: directory || this.getDefaultDirectory(),
    });

    terminal.show();
    terminal.sendText(`tmux attach -t ${shellEscape(sessionName)}`, true);
  }

  async previewPane(paneId: string): Promise<void> {
    const lines = vscode.workspace.getConfiguration("tmuxManager").get<number>("captureHistoryLines", 200);
    const stdout = await this.runTmux(["capture-pane", "-p", "-t", paneId, "-S", `-${lines}`]);
    const document = await vscode.workspace.openTextDocument({
      language: "log",
      content: stdout,
    });

    await vscode.window.showTextDocument(document, {
      preview: true,
      viewColumn: vscode.ViewColumn.Beside,
    });
  }

  async killSession(sessionName: string): Promise<void> {
    await this.runTmux(["kill-session", "-t", sessionName]);
  }

  async killPane(paneId: string): Promise<void> {
    await this.runTmux(["kill-pane", "-t", paneId]);
  }

  async ensureTmuxAvailable(showMessage = true): Promise<boolean> {
    try {
      await this.runTmux(["-V"]);
      return true;
    } catch {
      if (showMessage) {
        vscode.window.showErrorMessage("tmux is not installed or not available on PATH. Please install tmux first.");
      }
      return false;
    }
  }

  getDefaultDirectory(): string {
    const configured = vscode.workspace.getConfiguration("tmuxManager").get<string>("defaultSessionDirectory", "").trim();
    if (configured) {
      return configured;
    }

    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  private async listSessions(): Promise<SessionInfo[]> {
    let stdout: string;

    try {
      stdout = await this.runTmux([
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created_string}\t#{session_activity_string}",
      ]);
    } catch (error) {
      if (this.isNoTmuxServerError(error)) {
        return [];
      }

      throw error;
    }

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, windows, attached, created, activity] = line.split("\t");
        return {
          name,
          windows: Number.parseInt(windows, 10) || 0,
          attached: attached === "1",
          created: created || "unknown",
          activity: activity || "unknown",
        };
      });
  }

  private async listWindows(sessionName: string): Promise<WindowInfo[]> {
    const stdout = await this.runTmux([
      "list-windows",
      "-t",
      sessionName,
      "-F",
      "#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{pane_current_path}",
    ]);

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [index, name, active, panes, currentPath] = line.split("\t");
        return {
          sessionName,
          index: Number.parseInt(index, 10) || 0,
          name: name || "window",
          active: active === "1",
          panes: Number.parseInt(panes, 10) || 0,
          path: currentPath || "",
        };
      });
  }

  private async listPanes(sessionName: string, windowIndex: number): Promise<PaneInfo[]> {
    const stdout = await this.runTmux([
      "list-panes",
      "-t",
      `${sessionName}:${windowIndex}`,
      "-F",
      "#{pane_index}\t#{pane_id}\t#{pane_pid}\t#{pane_title}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_active}",
    ]);

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [index, id, pid, title, command, currentPath, active] = line.split("\t");
        return {
          sessionName,
          windowIndex,
          index: Number.parseInt(index, 10) || 0,
          id,
          pid: Number.parseInt(pid, 10) || 0,
          title: title || "",
          command: command || "",
          path: currentPath || "",
          active: active === "1",
          ports: [],
        };
      });
  }

  private async listListeningPorts(): Promise<Map<number, PortInfo[]>> {
    try {
      const { stdout } = await execFileAsync("ss", ["-H", "-ltnp"], {
        env: process.env,
      });
      return this.parseSsPorts(stdout);
    } catch {
      return this.listListeningPortsWithLsof();
    }
  }

  private parseSsPorts(stdout: string): Map<number, PortInfo[]> {
    const portsByPid = new Map<number, PortInfo[]>();

    for (const line of stdout.split("\n")) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 5) {
        continue;
      }

      const localAddress = columns[3];
      const port = parsePort(localAddress);
      if (!port) {
        continue;
      }

      const processMatches = line.matchAll(/"([^"]+)",pid=(\d+),fd=\d+/g);
      for (const match of processMatches) {
        const process = match[1];
        const pid = Number.parseInt(match[2], 10);
        if (!pid) {
          continue;
        }

        const portInfo = {
          address: localAddress,
          port,
          pid,
          process,
        };
        const existing = portsByPid.get(pid) ?? [];
        existing.push(portInfo);
        portsByPid.set(pid, existing);
      }
    }

    return portsByPid;
  }

  private async listListeningPortsWithLsof(): Promise<Map<number, PortInfo[]>> {
    try {
      const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-FpPn"], {
        env: process.env,
      });
      const portsByPid = new Map<number, PortInfo[]>();
      let currentPid = 0;
      let currentProcess = "";

      for (const line of stdout.split("\n")) {
        if (line.startsWith("p")) {
          currentPid = Number.parseInt(line.slice(1), 10) || 0;
        } else if (line.startsWith("P")) {
          currentProcess = line.slice(1);
        } else if (line.startsWith("n") && currentPid) {
          const address = line.slice(1);
          const port = parsePort(address);
          if (!port) {
            continue;
          }

          const existing = portsByPid.get(currentPid) ?? [];
          existing.push({
            address,
            port,
            pid: currentPid,
            process: currentProcess || "process",
          });
          portsByPid.set(currentPid, existing);
        }
      }

      return portsByPid;
    } catch {
      return new Map();
    }
  }

  private async listProcessChildren(): Promise<Map<number, number[]>> {
    try {
      const { stdout } = await execFileAsync("ps", ["-eo", "pid=", "-o", "ppid="], {
        env: process.env,
      });
      const children = new Map<number, number[]>();

      for (const line of stdout.split("\n")) {
        const [pidValue, parentPidValue] = line.trim().split(/\s+/);
        const pid = Number.parseInt(pidValue, 10);
        const parentPid = Number.parseInt(parentPidValue, 10);
        if (!pid || !parentPid) {
          continue;
        }

        const existing = children.get(parentPid) ?? [];
        existing.push(pid);
        children.set(parentPid, existing);
      }

      return children;
    } catch {
      return new Map();
    }
  }

  private getPanePorts(
    panePid: number,
    listeningPorts: Map<number, PortInfo[]>,
    processChildren: Map<number, number[]>,
  ): PortInfo[] {
    if (!panePid) {
      return [];
    }

    const seenPids = new Set<number>();
    const queue = [panePid];

    while (queue.length > 0) {
      const pid = queue.shift();
      if (!pid || seenPids.has(pid)) {
        continue;
      }

      seenPids.add(pid);
      queue.push(...(processChildren.get(pid) ?? []));
    }

    return dedupePorts(
      [...seenPids]
        .flatMap((pid) => listeningPorts.get(pid) ?? [])
        .sort((left, right) => left.port - right.port),
    );
  }

  private async inspectGit(directory: string): Promise<{ label: string; dirty: boolean }> {
    try {
      const { stdout } = await execFileAsync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
        env: process.env,
      });
      const root = stdout.trim();
      const { stdout: statusOutput } = await execFileAsync("git", ["-C", directory, "status", "--porcelain"], {
        env: process.env,
      });
      const dirty = statusOutput.trim().length > 0;
      const gitName = path.basename(root);

      return {
        label: dirty ? `${gitName} (git dirty)` : `${gitName} (git clean)`,
        dirty,
      };
    } catch {
      return {
        label: "current project (no git)",
        dirty: true,
      };
    }
  }

  private getProjectDirectory(directory: string): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot && this.isSameOrParent(workspaceRoot, directory)) {
      return workspaceRoot;
    }

    return directory;
  }

  private isSameOrParent(parent: string, candidate: string): boolean {
    const relativePath = path.relative(parent, candidate);
    return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
  }

  private async runTmux(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("tmux", args, {
        cwd: this.getDefaultDirectory(),
        env: process.env,
      });
      return stdout.trimEnd();
    } catch (error) {
      const message = error instanceof Error ? error.message : "tmux command failed";
      throw new Error(message);
    }
  }

  private isNoTmuxServerError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return (
      message.includes("no server running") ||
      message.includes("failed to connect to server") ||
      (message.includes("error connecting to") && message.includes("no such file or directory"))
    );
  }
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parsePort(address: string): number | undefined {
  const normalized = address.replace(/\s+\(LISTEN\).*$/, "");
  const match = normalized.match(/:(\d+)$/);
  if (!match) {
    return undefined;
  }

  const port = Number.parseInt(match[1], 10);
  return port > 0 ? port : undefined;
}

function dedupePorts(ports: PortInfo[]): PortInfo[] {
  const seen = new Set<string>();
  const unique: PortInfo[] = [];

  for (const port of ports) {
    const key = `${port.pid}:${port.port}:${port.address}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(port);
  }

  return unique;
}

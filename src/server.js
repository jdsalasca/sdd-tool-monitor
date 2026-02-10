import express from "express";
import chokidar from "chokidar";
import path from "path";
import fs from "fs";
import { execSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import { resolveWorkspaceRoot } from "./config.js";
import { getProjectDetail, scanProjects } from "./scanner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function sseWrite(res, payload) {
  res.write(`event: snapshot\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function resolveSddToolRoot() {
  if (process.env.SDD_TOOL_ROOT && process.env.SDD_TOOL_ROOT.trim()) {
    return path.resolve(process.env.SDD_TOOL_ROOT.trim());
  }
  return path.resolve(__dirname, "..", "..", "ssd-tool");
}

function sanitizePrompt(input) {
  const raw = String(input || "").trim();
  if (!raw) return "continue delivery to final release with strict quality gates";
  return raw.replace(/^hello\s+/i, "").trim();
}

function listSuiteProcesses(projectName) {
  const token = String(projectName || "").toLowerCase();
  if (!token) return [];
  try {
    if (process.platform === "win32") {
      const raw = execSync("wmic process where \"name='node.exe'\" get CommandLine,ProcessId /format:list", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 4000
      }).trim();
      if (!raw) return [];
      const lines = raw.split(/\r?\n/).map((line) => line.trim());
      const rows = [];
      let current = { pid: 0, command: "" };
      for (const line of lines) {
        if (!line) {
          if (current.pid > 0 && current.command) rows.push({ ...current });
          current = { pid: 0, command: "" };
          continue;
        }
        if (line.startsWith("CommandLine=")) {
          current.command = line.replace(/^CommandLine=/, "");
        } else if (line.startsWith("ProcessId=")) {
          current.pid = Number(line.replace(/^ProcessId=/, ""));
        }
      }
      if (current.pid > 0 && current.command) rows.push({ ...current });
      return rows
        .filter(
          (row) =>
            row &&
            Number.isFinite(row.pid) &&
            row.pid > 0 &&
            row.command.toLowerCase().includes("dist/cli.js") &&
            row.command.toLowerCase().includes(" suite ") &&
            row.command.toLowerCase().includes(token)
        );
    }
    const raw = execSync("ps -ax -o pid= -o command=", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000
    });
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf(" ");
        if (idx <= 0) return null;
        const pid = Number.parseInt(line.slice(0, idx).trim(), 10);
        const command = line.slice(idx + 1).trim();
        return { pid, command };
      })
      .filter(
        (row) =>
          row &&
          Number.isFinite(row.pid) &&
          row.pid > 0 &&
          row.command.toLowerCase().includes("dist/cli.js") &&
          row.command.toLowerCase().includes(" suite ") &&
          row.command.toLowerCase().includes(token)
      );
  } catch {
    return [];
  }
}

function stopProcess(pid) {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function updateCampaignState(projectRoot, patch) {
  const file = path.join(projectRoot, "suite-campaign-state.json");
  let current = {};
  try {
    if (fs.existsSync(file)) {
      current = JSON.parse(fs.readFileSync(file, "utf-8"));
    }
  } catch {
    current = {};
  }
  const next = { ...current, ...patch };
  try {
    fs.writeFileSync(file, JSON.stringify(next, null, 2), "utf-8");
  } catch {
    // best effort
  }
}

function startSuite(project) {
  const sddRoot = resolveSddToolRoot();
  const logsRoot = path.join(project.projectRoot ? path.dirname(project.projectRoot) : sddRoot, "_suite-logs");
  fs.mkdirSync(logsRoot, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(logsRoot, `${project.name}.monitor.${ts}.out.log`);
  const errFile = path.join(logsRoot, `${project.name}.monitor.${ts}.err.log`);
  const outFd = fs.openSync(outFile, "a");
  const errFd = fs.openSync(errFile, "a");

  const provider = project.runStatus?.raw?.provider || "gemini";
  const model = project.runStatus?.raw?.model || project.campaign?.model || "";
  const fromStep = project.runStatus?.recovery?.fromStep || project.campaign?.nextFromStep || "finish";
  const hint = sanitizePrompt(project.runStatus?.recovery?.hint || "");
  const args = ["dist/cli.js", "--provider", provider, "--non-interactive", "--project", project.name, "--iterations", "10"];
  if (model) {
    args.push("--model", model);
  }
  args.push(
    "suite",
    "--campaign-autonomous",
    "--campaign-hours",
    "6",
    "--campaign-max-cycles",
    "500",
    "--campaign-sleep-seconds",
    "5",
    "--from-step",
    fromStep,
    "hello",
    hint
  );

  const child = spawn(process.execPath, args, {
    cwd: sddRoot,
    detached: true,
    stdio: ["ignore", outFd, errFd]
  });
  child.unref();
  return { pid: child.pid, outFile, errFile };
}

function withMonitorMeta(snapshot, options) {
  return {
    ...snapshot,
    monitor: {
      refreshMs: Math.max(1000, options.refreshMs),
      stream: "sse+fswatch"
    }
  };
}

export async function startMonitorServer(options) {
  const workspaceRoot = resolveWorkspaceRoot(options.workspace);
  const app = express();
  const subscribers = new Set();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      workspaceRoot,
      at: new Date().toISOString(),
      monitor: { refreshMs: Math.max(1000, options.refreshMs), stream: "sse+fswatch" }
    });
  });

  app.get("/api/status", async (_req, res) => {
    const snapshot = await scanProjects(workspaceRoot);
    res.json(withMonitorMeta(snapshot, options));
  });

  app.get("/api/project/:name", async (req, res) => {
    const detail = await getProjectDetail(req.params.name, workspaceRoot);
    if (!detail.project) {
      res.status(404).json({ ok: false, error: "project_not_found", project: req.params.name });
      return;
    }
    res.json({ ok: true, ...detail, monitor: { refreshMs: Math.max(1000, options.refreshMs), stream: "sse+fswatch" } });
  });

  app.post("/api/project/:name/action", async (req, res) => {
    const action = String(req.body?.action || "").trim().toLowerCase();
    const detail = await getProjectDetail(req.params.name, workspaceRoot);
    if (!detail.project) {
      res.status(404).json({ ok: false, error: "project_not_found", project: req.params.name });
      return;
    }
    const project = detail.project;
    const active = listSuiteProcesses(project.name);
    const campaignPid = Number(project?.campaign?.suitePid || 0);
    if (active.length === 0 && isProcessAlive(campaignPid)) {
      active.push({ pid: campaignPid, command: "from_campaign_state" });
    }

    if (!["pause", "resume", "restart"].includes(action)) {
      res.status(400).json({ ok: false, error: "invalid_action", details: "Use pause|resume|restart" });
      return;
    }

    if (action === "pause") {
      const stopped = active.filter((row) => stopProcess(row.pid)).map((row) => row.pid);
      updateCampaignState(project.projectRoot, {
        running: false,
        phase: "paused_by_monitor",
        lastError: stopped.length > 0 ? "" : "No active suite process found to pause."
      });
      res.json({ ok: true, action, project: project.name, stoppedPids: stopped });
      return;
    }

    if (action === "restart") {
      active.forEach((row) => stopProcess(row.pid));
      updateCampaignState(project.projectRoot, { running: false, phase: "restarting_by_monitor" });
    } else if (action === "resume" && active.length > 0) {
      res.json({ ok: true, action, project: project.name, skipped: true, details: "suite already running", pids: active.map((row) => row.pid) });
      return;
    }

    try {
      const started = startSuite(project);
      updateCampaignState(project.projectRoot, {
        running: true,
        suitePid: started.pid,
        phase: action === "restart" ? "restarted_by_monitor" : "resumed_by_monitor",
        lastError: ""
      });
      res.json({
        ok: true,
        action,
        project: project.name,
        suitePid: started.pid,
        outLog: started.outFile,
        errLog: started.errFile
      });
    } catch (error) {
      res.status(500).json({ ok: false, action, error: "action_failed", details: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/stream", async (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    subscribers.add(res);
    const snapshot = await scanProjects(workspaceRoot);
    sseWrite(res, withMonitorMeta(snapshot, options));

    const keepAlive = setInterval(() => {
      res.write(`: keepalive ${Date.now()}\n\n`);
    }, 15000);

    res.on("close", () => {
      clearInterval(keepAlive);
      subscribers.delete(res);
      res.end();
    });
  });

  const server = app.listen(options.port, options.host, async () => {
    const snapshot = await scanProjects(workspaceRoot);
    console.log(`sdd-tool-monitor listening on http://${options.host}:${options.port}`);
    console.log(`Workspace: ${snapshot.workspaceRoot}`);
    console.log(`Projects: ${snapshot.summary.total} | Healthy: ${snapshot.summary.healthy} | Critical: ${snapshot.summary.critical} | Running: ${snapshot.summary.runningProcesses}`);
  });

  const pushSnapshot = async () => {
    const snapshot = await scanProjects(workspaceRoot);
    const payload = withMonitorMeta(snapshot, options);
    for (const sub of subscribers) {
      sseWrite(sub, payload);
    }
  };

  const refreshTimer = setInterval(pushSnapshot, Math.max(1000, options.refreshMs));
  const watcher = chokidar.watch(workspaceRoot, {
    ignoreInitial: true,
    depth: 6,
    awaitWriteFinish: { stabilityThreshold: 600, pollInterval: 100 }
  });
  watcher.on("all", () => {
    pushSnapshot().catch(() => {});
  });

  const shutdown = () => {
    clearInterval(refreshTimer);
    watcher.close().catch(() => {});
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

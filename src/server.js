import express from "express";
import chokidar from "chokidar";
import path from "path";
import { fileURLToPath } from "url";
import { resolveWorkspaceRoot } from "./config.js";
import { getProjectDetail, scanProjects } from "./scanner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function sseWrite(res, payload) {
  res.write(`event: snapshot\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
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

#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { startMonitorServer } from "./server.js";
import { scanProjects } from "./scanner.js";

function parseArgs(argv) {
  const args = { host: "127.0.0.1", port: 4317, refreshMs: 5000, workspace: "", once: false, json: false, pidFile: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--host") args.host = argv[++i] || args.host;
    else if (current === "--port") args.port = Number.parseInt(argv[++i] || "", 10) || args.port;
    else if (current === "--refresh-ms") args.refreshMs = Number.parseInt(argv[++i] || "", 10) || args.refreshMs;
    else if (current === "--workspace") args.workspace = argv[++i] || "";
    else if (current === "--once") args.once = true;
    else if (current === "--json") args.json = true;
    else if (current === "--pid-file") args.pidFile = argv[++i] || "";
  }
  return args;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.once) {
    const snapshot = await scanProjects(options.workspace || undefined);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
      return;
    }
    process.stdout.write(`Workspace: ${snapshot.workspaceRoot}\n`);
    process.stdout.write(`Projects: ${snapshot.summary.total}\n`);
    process.stdout.write(`Healthy: ${snapshot.summary.healthy} | Unhealthy: ${snapshot.summary.unhealthy}\n`);
    return;
  }
  const pidFile = options.pidFile || path.resolve(process.cwd(), "monitor.pid.json");
  try {
    fs.writeFileSync(
      pidFile,
      JSON.stringify(
        {
          writtenAt: new Date().toISOString(),
          monitorPid: process.pid,
          url: `http://${options.host}:${options.port}`,
          workspace: options.workspace || ""
        },
        null,
        2
      ),
      "utf-8"
    );
  } catch {
    // best effort
  }
  await startMonitorServer(options);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`sdd-tool-monitor failed: ${message}\n`);
  process.exit(1);
});

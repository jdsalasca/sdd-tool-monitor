import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { resolveWorkspaceRoot } from "./config.js";

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function readText(file) {
  if (!fs.existsSync(file)) return "";
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

function safeParseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readJsonlTail(file, max = 10) {
  if (!fs.existsSync(file)) return [];
  let raw = "";
  try {
    const stat = fs.statSync(file);
    const tailBytes = Math.min(stat.size, 256 * 1024);
    const start = Math.max(0, stat.size - tailBytes);
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(tailBytes);
    fs.readSync(fd, buffer, 0, tailBytes, start);
    fs.closeSync(fd);
    raw = buffer.toString("utf-8");
  } catch {
    raw = readText(file);
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  return lines.slice(Math.max(0, lines.length - max)).map(safeParseJsonLine).filter(Boolean);
}

function parseLifecycle(projectRoot) {
  const jsonFile = path.join(projectRoot, "generated-app", "deploy", "lifecycle-report.json");
  const json = readJson(jsonFile);
  if (json && typeof json === "object") {
    const steps = Array.isArray(json.steps) ? json.steps : [];
    const failItems = steps.filter((step) => !step?.ok).map((step) => `${step.command}: ${String(step.output || "")}`);
    return {
      present: true,
      ok: steps.filter((step) => step?.ok).length,
      fail: failItems.length,
      skipped: Array.isArray(json.summary) ? json.summary.filter((line) => String(line).startsWith("SKIP:")).length : 0,
      lastFailure: failItems.at(-1) || "",
      failItems
    };
  }
  const file = path.join(projectRoot, "generated-app", "deploy", "lifecycle-report.md");
  const raw = readText(file);
  if (!raw) {
    return { present: false, ok: 0, fail: 0, skipped: 0, lastFailure: "missing", failItems: [] };
  }
  const ok = (raw.match(/- OK:/g) || []).length;
  const fail = (raw.match(/- FAIL:/g) || []).length;
  const skipped = (raw.match(/- SKIP:/g) || []).length;
  const failItems = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- FAIL:"))
    .map((line) => line.replace(/^- FAIL:\s*/, ""));
  return {
    present: true,
    ok,
    fail,
    skipped,
    lastFailure: failItems.at(-1) || "",
    failItems
  };
}

function parseRunStatus(projectRoot) {
  const parsed = readJson(path.join(projectRoot, "sdd-run-status.json"));
  if (!parsed) {
    return {
      present: false,
      blockers: [],
      recovery: null,
      stageCurrent: "",
      step: ""
    };
  }
  return {
    present: true,
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
    recovery: parsed.recovery || null,
    stageCurrent: String(parsed.stageCurrent || ""),
    step: String(parsed.step || ""),
    lifecyclePassed: typeof parsed?.lifecycle?.passed === "boolean" ? parsed.lifecycle.passed : null,
    reviewApproved: typeof parsed?.review?.approved === "boolean" ? parsed.review.approved : null,
    releaseFinal: String(parsed?.release?.final || ""),
    runtimeStarted: typeof parsed?.runtime?.started === "boolean" ? parsed.runtime.started : null,
    raw: parsed
  };
}

function parseDigitalReview(projectRoot) {
  const file = path.join(projectRoot, "generated-app", "deploy", "digital-review-report.json");
  const parsed = readJson(file);
  if (!parsed) {
    return { present: false, passed: false, score: 0, threshold: 0 };
  }
  return {
    present: true,
    passed: Boolean(parsed.passed),
    score: Number(parsed.score || 0),
    threshold: Number(parsed.threshold || 0)
  };
}

function parseStage(projectRoot) {
  const parsed = readJson(path.join(projectRoot, ".sdd-stage-state.json"));
  const stages = parsed?.stages || {};
  const order = [
    "discovery",
    "functional_requirements",
    "technical_backlog",
    "implementation",
    "quality_validation",
    "role_review",
    "release_candidate",
    "final_release",
    "runtime_start"
  ];
  const current = order.find((stage) => stages[stage] !== "passed") || "runtime_start";
  return { stages, current, history: Array.isArray(parsed?.history) ? parsed.history.slice(-20) : [] };
}

function parseCampaign(projectRoot) {
  const file = path.join(projectRoot, "suite-campaign-state.json");
  const state = readJson(file);
  if (!state) {
    return { present: false, cycle: 0, elapsedMinutes: 0, autonomous: false, targetPassed: false, qualityPassed: false, runtimePassed: false };
  }
  let updatedAt = "";
  try {
    updatedAt = fs.statSync(file).mtime.toISOString();
  } catch {
    updatedAt = "";
  }
  return {
    present: true,
    cycle: Number(state.cycle || 0),
    elapsedMinutes: Number(state.elapsedMinutes || 0),
    autonomous: Boolean(state.autonomous),
    running: Boolean(state.running),
    suitePid: Number(state.suitePid || 0),
    phase: String(state.phase || ""),
    lastError: String(state.lastError || ""),
    model: String(state.model || ""),
    nextFromStep: String(state.nextFromStep || ""),
    stallCount: Number(state.stallCount || 0),
    targetPassed: Boolean(state.targetPassed),
    qualityPassed: Boolean(state.qualityPassed),
    runtimePassed: Boolean(state.runtimePassed),
    targetStage: String(state.targetStage || ""),
    updatedAt
  };
}

function detectIdleBeforeMinimum(campaign, running) {
  if (!campaign?.present) return null;
  const minMinutes = 360;
  const active = Boolean(running?.active);
  const endedOrIdle = campaign.running === false && !active;
  if (!endedOrIdle) return null;
  if (campaign.targetPassed) return null;
  if (Number(campaign.elapsedMinutes || 0) >= minMinutes) return null;
  return {
    failed: true,
    minMinutes,
    elapsedMinutes: Number(campaign.elapsedMinutes || 0),
    message: `Campaign went idle before ${minMinutes} minutes (${campaign.elapsedMinutes}m).`
  };
}

function parsePromptMeta(projectRoot) {
  const metadataFile = path.join(projectRoot, "debug", "provider-prompts.metadata.jsonl");
  const fullFile = path.join(projectRoot, "debug", "provider-prompts.jsonl");
  const rows = readJsonlTail(metadataFile, 20);
  const last = rows.at(-1);
  const full = readJsonlTail(fullFile, 3);
  const lastFull = full.at(-1);
  if (!last) {
    return {
      present: false,
      lastAt: "",
      lastStage: "",
      lastOk: false,
      lastPromptPreview: "",
      lastOutputPreview: "",
      recent: []
    };
  }
  return {
    present: true,
    lastAt: String(last.at || ""),
    lastStage: String(last.stage || ""),
    lastOk: Boolean(last.ok),
    lastPromptPreview: String(last.promptPreview || ""),
    lastOutputPreview: String(last.outputPreview || ""),
    lastPromptFull: typeof lastFull?.prompt === "string" ? lastFull.prompt.slice(0, 3000) : "",
    lastOutputFull: typeof lastFull?.output === "string" ? lastFull.output.slice(0, 3000) : "",
    recent: rows.slice(-6)
  };
}

function listSddProcesses() {
  try {
    if (process.platform === "win32") {
      const cmd = "wmic process where \"name='node.exe'\" get ProcessId,CommandLine /format:csv";
      const raw = execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }).trim();
      if (!raw) return [];
      const rows = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(1)
        .map((line) => {
          const pieces = line.split(",");
          if (pieces.length < 3) return null;
          const processId = Number(pieces.at(-1) || 0);
          const command = pieces.slice(1, -1).join(",").trim();
          return { processId, command };
        })
        .filter((row) => row && Number.isFinite(row.processId) && row.processId > 0 && /dist[\\/]cli\.js/i.test(row.command));
      return rows
        .map((row) => ({ processId: row.processId, command: row.command }))
        .filter((row) => row.command);
    }
    const raw = execSync("ps -ax -o pid= -o command=", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const firstSpace = line.indexOf(" ");
        if (firstSpace <= 0) return null;
        const processId = Number.parseInt(line.slice(0, firstSpace).trim(), 10);
        const command = line.slice(firstSpace + 1).trim();
        return { processId, command };
      })
      .filter((row) => row && Number.isFinite(row.processId) && /dist\/cli\.js/i.test(row.command));
  } catch {
    return [];
  }
}

function detectRunningProcess(projectName, processRows) {
  const targetPrefix = projectName.slice(0, 40).toLowerCase();
  const hit = processRows.find((row) => {
    const normalized = String(row.command || "").replace(/\s+/g, " ").trim().toLowerCase();
    return normalized.includes(projectName.toLowerCase()) || normalized.includes(targetPrefix);
  });
  if (!hit) {
    return { active: false, processId: 0, command: "" };
  }
  return { active: true, processId: hit.processId, command: hit.command.slice(0, 400) };
}

function parseReleases(projectRoot) {
  const history = readJson(path.join(projectRoot, "generated-app", "deploy", "release-history.json"));
  const releases = Array.isArray(history?.releases) ? history.releases : [];
  return {
    total: releases.length,
    candidates: releases.filter((row) => row.stage === "candidate").length,
    finals: releases.filter((row) => row.stage === "final").length,
    last: releases.at(-1) || null
  };
}

function computeValueScore(stage, lifecycle, review, releases) {
  let score = 100;
  score -= lifecycle.fail * 12;
  score -= lifecycle.skipped * 3;
  if (!review.present) score -= 8;
  if (review.present && !review.passed) score -= 20;
  if (stage.stages?.final_release !== "passed") score -= 10;
  if (stage.stages?.runtime_start !== "passed") score -= 8;
  if (releases.finals === 0) score -= 8;
  return Math.max(0, Math.min(100, score));
}

function getProjectHealth(stage, lifecycle, review) {
  const finalPassed = stage.stages?.final_release === "passed";
  const runtimePassed = stage.stages?.runtime_start === "passed";
  if (finalPassed && runtimePassed && lifecycle.fail === 0 && (review.present ? review.passed : true)) {
    return "healthy";
  }
  if (lifecycle.fail > 0 || stage.stages?.quality_validation === "failed" || stage.stages?.role_review === "failed") {
    return "critical";
  }
  return "in_progress";
}

function suggestRecoveryCommand(projectName, stage, lifecycle) {
  const base = `node dist/cli.js --provider gemini --non-interactive --project "${projectName}" --iterations 10 --max-runtime-minutes 120`;
  const failure = (lifecycle.lastFailure || "").toLowerCase();
  if (stage.current === "quality_validation" || lifecycle.fail > 0) {
    let hint = "continue improving quality; fix all lifecycle FAIL items, rerun tests/build/smoke, then progress release";
    if (failure.includes("smoke")) hint = "add a real smoke script and make it pass with local runtime checks";
    if (failure.includes("readme")) hint = "fix README root with Features/Run/Testing/Release sections and align docs to project";
    if (failure.includes("jest") || failure.includes("unexpected token")) hint = "fix module format and jest config; make tests pass consistently";
    return `${base} --from-step finish hello "${hint}"`;
  }
  if (stage.current === "role_review") {
    return `${base} --from-step finish hello "implement reviewer findings and convert them into prioritized user stories"`;
  }
  if (stage.current === "release_candidate" || stage.current === "final_release") {
    return `${base} --from-step finish hello "finalize release artifacts, push tags, and publish final release"`;
  }
  return `${base} hello "continue delivery to final release and runtime start with production quality"`;
}

function parseOrchestrationJournal(projectRoot) {
  const file = path.join(projectRoot, "orchestration-journal.jsonl");
  const rows = readJsonlTail(file, 20);
  return rows.slice(-8);
}

function parseIterationMetrics(projectRoot) {
  const file = path.join(projectRoot, "generated-app", "deploy", "iteration-metrics.json");
  const parsed = readJson(file);
  const metrics = Array.isArray(parsed?.metrics) ? parsed.metrics : [];
  if (metrics.length === 0) {
    return {
      total: 0,
      passed: 0,
      failed: 0,
      lastRound: 0,
      lastPhase: "",
      lastResult: "",
      recent: []
    };
  }
  const passed = metrics.filter((item) => item?.result === "passed").length;
  const failed = metrics.filter((item) => item?.result === "failed").length;
  const last = metrics[metrics.length - 1] || {};
  return {
    total: metrics.length,
    passed,
    failed,
    lastRound: Number(last.round || 0),
    lastPhase: String(last.phase || ""),
    lastResult: String(last.result || ""),
    recent: metrics.slice(-8)
  };
}

function parseLifeArtifacts(projectRoot) {
  const lifeRoot = path.join(projectRoot, "life");
  const tracks = ["users", "stakeholders", "design", "marketing", "quality"];
  const data = {};
  for (const track of tracks) {
    const file = path.join(lifeRoot, `${track}-rounds.jsonl`);
    const rows = readJsonlTail(file, 25);
    data[track] = {
      count: rows.length,
      last: rows.at(-1) || null,
      recent: rows.slice(-8)
    };
  }
  const summaryFile = path.join(lifeRoot, "summary.md");
  return {
    present: fs.existsSync(lifeRoot),
    summaryPath: fs.existsSync(summaryFile) ? "life/summary.md" : "",
    summaryPreview: readText(summaryFile).slice(0, 1200),
    tracks: data
  };
}

function findLatestRequirementDir(projectRoot) {
  const bases = ["backlog", "wip", "in-progress", "done", "archived"].map((status) =>
    path.join(projectRoot, "requirements", status)
  );
  let latest = { dir: "", mtimeMs: 0 };
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(base, entry.name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      if (mtimeMs >= latest.mtimeMs) {
        latest = { dir: full, mtimeMs };
      }
    }
  }
  return latest.dir || "";
}

function findByCandidates(root, candidates) {
  for (const rel of candidates) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) {
      return rel.replace(/\\/g, "/");
    }
  }
  return "";
}

function parseStageProducts(projectRoot, releases) {
  const appRoot = path.join(projectRoot, "generated-app");
  const latestReq = findLatestRequirementDir(projectRoot);
  const reqRel = latestReq ? path.relative(projectRoot, latestReq).replace(/\\/g, "/") : "";
  const inReq = (file) => (reqRel ? `${reqRel}/${file}` : `requirements/**/${file}`);
  const hasReqFile = (file) => (latestReq ? fs.existsSync(path.join(latestReq, file)) : false);

  const catalog = {
    discovery: [
      { label: "Project metadata", path: "metadata.json", present: fs.existsSync(path.join(projectRoot, "metadata.json")) },
      { label: "Run status", path: "sdd-run-status.json", present: fs.existsSync(path.join(projectRoot, "sdd-run-status.json")) },
      { label: "Orchestration journal", path: "orchestration-journal.jsonl", present: fs.existsSync(path.join(projectRoot, "orchestration-journal.jsonl")) }
    ],
    functional_requirements: [
      { label: "Requirement document", path: inReq("requirement.md"), present: hasReqFile("requirement.md") },
      { label: "Functional spec", path: inReq("functional-spec.md"), present: hasReqFile("functional-spec.md") }
    ],
    technical_backlog: [
      { label: "Technical spec", path: inReq("technical-spec.md"), present: hasReqFile("technical-spec.md") },
      { label: "Architecture", path: inReq("architecture.md"), present: hasReqFile("architecture.md") },
      { label: "Test plan", path: inReq("test-plan.md"), present: hasReqFile("test-plan.md") }
    ],
    implementation: [
      { label: "Generated app root", path: "generated-app/", present: fs.existsSync(appRoot) },
      {
        label: "Runtime manifest",
        path: findByCandidates(appRoot, ["package.json", "requirements.txt", "backend/pom.xml", "frontend/package.json"]) || "generated-app/{package.json|requirements.txt|backend/pom.xml|frontend/package.json}",
        present:
          fs.existsSync(path.join(appRoot, "package.json")) ||
          fs.existsSync(path.join(appRoot, "requirements.txt")) ||
          fs.existsSync(path.join(appRoot, "backend", "pom.xml")) ||
          fs.existsSync(path.join(appRoot, "frontend", "package.json"))
      },
      { label: "README", path: "generated-app/README.md", present: fs.existsSync(path.join(appRoot, "README.md")) }
    ],
    quality_validation: [
      { label: "Lifecycle report", path: "generated-app/deploy/lifecycle-report.json", present: fs.existsSync(path.join(appRoot, "deploy", "lifecycle-report.json")) },
      { label: "Iteration metrics", path: "generated-app/deploy/iteration-metrics.json", present: fs.existsSync(path.join(appRoot, "deploy", "iteration-metrics.json")) },
      { label: "Quality backlog", path: "generated-app/deploy/quality-backlog.json", present: fs.existsSync(path.join(appRoot, "deploy", "quality-backlog.json")) }
    ],
    role_review: [
      { label: "Digital review report", path: "generated-app/deploy/digital-review-report.json", present: fs.existsSync(path.join(appRoot, "deploy", "digital-review-report.json")) },
      { label: "User stories backlog", path: "generated-app/deploy/digital-review-user-stories.md", present: fs.existsSync(path.join(appRoot, "deploy", "digital-review-user-stories.md")) },
      { label: "Review rounds", path: "generated-app/deploy/digital-review-rounds.json", present: fs.existsSync(path.join(appRoot, "deploy", "digital-review-rounds.json")) },
      { label: "Life review summary", path: "life/summary.md", present: fs.existsSync(path.join(projectRoot, "life", "summary.md")) }
    ],
    release_candidate: [
      { label: "Release history", path: "generated-app/deploy/release-history.json", present: fs.existsSync(path.join(appRoot, "deploy", "release-history.json")) },
      { label: "Candidate releases", path: "generated-app/deploy/releases/", present: releases.candidates > 0 }
    ],
    final_release: [
      { label: "Final release history", path: "generated-app/deploy/release-history.json", present: releases.finals > 0 },
      { label: "Deployment report", path: "generated-app/deploy/deployment.md", present: fs.existsSync(path.join(appRoot, "deploy", "deployment.md")) },
      { label: "Life summary", path: "life/summary.md", present: fs.existsSync(path.join(projectRoot, "life", "summary.md")) }
    ],
    runtime_start: [
      { label: "Runtime process metadata", path: "generated-app/deploy/runtime-processes.json", present: fs.existsSync(path.join(appRoot, "deploy", "runtime-processes.json")) },
      { label: "Campaign state", path: "suite-campaign-state.json", present: fs.existsSync(path.join(projectRoot, "suite-campaign-state.json")) }
    ]
  };
  return catalog;
}

function buildProjectRow(projectRoot, name, processRows) {
  const lifecycle = parseLifecycle(projectRoot);
  const review = parseDigitalReview(projectRoot);
  const stage = parseStage(projectRoot);
  const campaign = parseCampaign(projectRoot);
  const prompt = parsePromptMeta(projectRoot);
  const runStatus = parseRunStatus(projectRoot);
  const releases = parseReleases(projectRoot);
  const iterationMetrics = parseIterationMetrics(projectRoot);
  const life = parseLifeArtifacts(projectRoot);
  const running = detectRunningProcess(name, processRows);
  if (!running.active && campaign.present && campaign.running) {
    running.active = true;
    running.processId = Number.isFinite(campaign.suitePid) ? campaign.suitePid : 0;
    running.command = campaign.phase ? `suite ${campaign.phase}` : "suite campaign running";
  }
  if (!running.active && campaign.present && campaign.running !== false && !campaign.targetPassed && campaign.updatedAt) {
    const updatedMs = Date.parse(campaign.updatedAt);
    if (Number.isFinite(updatedMs) && Date.now() - updatedMs <= 180000) {
      running.active = true;
      running.command = "inferred from fresh campaign state";
    }
  }
  if (!running.active && runStatus.present && (!campaign.present || campaign.running !== false)) {
    const runUpdatedMs = Date.parse(runStatus.raw?.at || "");
    if (Number.isFinite(runUpdatedMs) && Date.now() - runUpdatedMs <= 180000) {
      running.active = true;
      running.command = "inferred from fresh run-status activity";
    }
  }
  const idleBeforeMinimum = detectIdleBeforeMinimum(campaign, running);
  const valueScore = computeValueScore(stage, lifecycle, review, releases);
  const recovery = suggestRecoveryCommand(name, stage, lifecycle);
  const health = idleBeforeMinimum?.failed ? "critical" : getProjectHealth(stage, lifecycle, review);

  return {
    name,
    projectRoot,
    stage,
    lifecycle,
    review,
    campaign,
    stageTimeline: Array.isArray(stage.history)
      ? stage.history.slice(-10).map((row) => ({
          at: String(row?.at || ""),
          stage: String(row?.stage || ""),
          status: String(row?.status || row?.state || "")
        }))
      : [],
    prompt,
    runStatus,
    releases,
    iterationMetrics,
    life,
    stageProducts: parseStageProducts(projectRoot, releases),
    running,
    idleBeforeMinimum,
    health,
    valueScore,
    recovery: runStatus.recovery?.command || recovery,
    journal: parseOrchestrationJournal(projectRoot),
    updatedAt: fs.statSync(projectRoot).mtime.toISOString()
  };
}

export async function scanProjects(explicitWorkspace) {
  const workspaceRoot = resolveWorkspaceRoot(explicitWorkspace);
  const projects = [];
  const processRows = listSddProcesses();

  if (fs.existsSync(workspaceRoot)) {
    const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const entry of entries) {
      const projectRoot = path.join(workspaceRoot, entry.name);
      const looksLikeProject =
        fs.existsSync(path.join(projectRoot, "metadata.json")) ||
        fs.existsSync(path.join(projectRoot, ".sdd-stage-state.json")) ||
        fs.existsSync(path.join(projectRoot, "requirements")) ||
        fs.existsSync(path.join(projectRoot, "sdd-run-status.json")) ||
        fs.existsSync(path.join(projectRoot, "debug", "provider-prompts.metadata.jsonl")) ||
        fs.existsSync(path.join(projectRoot, "suite-campaign-state.json"));
      if (!looksLikeProject) continue;
      projects.push(buildProjectRow(projectRoot, entry.name, processRows));
    }
  }

  projects.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  const summary = {
    total: projects.length,
    healthy: projects.filter((p) => p.health === "healthy").length,
    critical: projects.filter((p) => p.health === "critical").length,
    unhealthy: projects.filter((p) => p.health !== "healthy").length,
    runningCampaigns: projects.filter((p) => p.campaign.present && (p.campaign.running || p.running.active)).length,
    runningProcesses: projects.filter((p) => p.running.active).length,
    idleBeforeMinimum: projects.filter((p) => p.idleBeforeMinimum?.failed).length,
    blockedProjects: projects.filter((p) => (p.runStatus?.blockers || []).length > 0 || p.lifecycle.fail > 0 || p.idleBeforeMinimum?.failed).length,
    avgValueScore: projects.length === 0 ? 0 : Math.round(projects.reduce((acc, p) => acc + p.valueScore, 0) / projects.length)
  };

  return {
    at: new Date().toISOString(),
    workspaceRoot,
    summary,
    projects
  };
}

export async function getProjectDetail(projectName, explicitWorkspace) {
  const snapshot = await scanProjects(explicitWorkspace);
  const project = snapshot.projects.find((item) => item.name === projectName);
  return {
    at: snapshot.at,
    workspaceRoot: snapshot.workspaceRoot,
    project: project || null
  };
}

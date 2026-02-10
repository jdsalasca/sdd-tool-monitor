import fs from "fs";
import os from "os";
import path from "path";
import YAML from "yaml";

function defaultConfigPath() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "sdd-cli", "config.yml");
  }
  return path.join(os.homedir(), ".config", "sdd-cli", "config.yml");
}

function resolveTokens(input) {
  const home = os.homedir();
  const user = path.basename(home);
  return input.replace(/\{\{home\}\}/gi, home).replace(/\{\{user\}\}/gi, user);
}

export function resolveWorkspaceRoot(explicitWorkspace) {
  if (explicitWorkspace && explicitWorkspace.trim().length > 0) {
    return path.resolve(explicitWorkspace);
  }
  if (process.env.SDD_MONITOR_WORKSPACE && process.env.SDD_MONITOR_WORKSPACE.trim().length > 0) {
    return path.resolve(process.env.SDD_MONITOR_WORKSPACE.trim());
  }
  const configPath = process.env.SDD_CONFIG_PATH || defaultConfigPath();
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = YAML.parse(raw) || {};
    const root = parsed?.workspace?.default_root;
    if (typeof root === "string" && root.trim().length > 0) {
      return path.resolve(resolveTokens(root.trim()));
    }
  }
  return path.resolve(path.join(os.homedir(), "Documents", "sdd-tool-projects"));
}

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const repo = process.env.GITHUB_REPOSITORY || "Gloomysunday28/mr-kit";

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}`);
    process.exitCode = 1;
  }
  return value || "";
}

function optional(name) {
  return process.env[name] || "";
}

function run(command, args, input) {
  const result = spawnSync(command, args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function setSecret(name, value) {
  run("gh", ["secret", "set", name, "--repo", repo], value);
}

const certificatePath = required("APPLE_CERTIFICATE_PATH");
const certificatePassword = required("APPLE_CERTIFICATE_PASSWORD");

const hasAppleId = Boolean(optional("APPLE_ID") && optional("APPLE_PASSWORD") && optional("APPLE_TEAM_ID"));
const hasApiKey = Boolean(optional("APPLE_API_KEY") && optional("APPLE_API_ISSUER") && optional("APPLE_API_KEY_P8_PATH"));

if (!hasAppleId && !hasApiKey) {
  console.error(
    "Missing notarization credentials. Provide APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID or APPLE_API_KEY / APPLE_API_ISSUER / APPLE_API_KEY_P8_PATH.",
  );
  process.exitCode = 1;
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

if (!existsSync(certificatePath)) {
  console.error(`Certificate file does not exist: ${certificatePath}`);
  process.exit(1);
}

const ghVersion = spawnSync("gh", ["--version"], { stdio: "ignore" });
if (ghVersion.status !== 0) {
  console.error("GitHub CLI is required: brew install gh && gh auth login");
  process.exit(1);
}

const certificateBase64 = readFileSync(certificatePath).toString("base64");
setSecret("APPLE_CERTIFICATE", certificateBase64);
setSecret("APPLE_CERTIFICATE_PASSWORD", certificatePassword);

if (hasAppleId) {
  setSecret("APPLE_ID", optional("APPLE_ID"));
  setSecret("APPLE_PASSWORD", optional("APPLE_PASSWORD"));
  setSecret("APPLE_TEAM_ID", optional("APPLE_TEAM_ID"));
}

if (hasApiKey) {
  const apiKeyPath = optional("APPLE_API_KEY_P8_PATH");
  if (!existsSync(apiKeyPath)) {
    console.error(`API key file does not exist: ${apiKeyPath}`);
    process.exit(1);
  }
  setSecret("APPLE_API_KEY", optional("APPLE_API_KEY"));
  setSecret("APPLE_API_ISSUER", optional("APPLE_API_ISSUER"));
  setSecret("APPLE_API_KEY_P8", readFileSync(apiKeyPath, "utf8"));
}

const providerShortName = optional("APPLE_PROVIDER_SHORT_NAME");
if (providerShortName) {
  setSecret("APPLE_PROVIDER_SHORT_NAME", providerShortName);
}

console.log(`Configured macOS release secrets for ${repo}.`);

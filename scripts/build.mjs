import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const isMac = process.platform === "darwin";
const buildEnv = {
  ...process.env,
  PATH: isMac
    ? `/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ""}`
    : process.env.PATH,
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
    shell: process.platform === "win32",
    env: buildEnv,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function codesignIdentities() {
  const result = run("security", ["find-identity", "-v", "-p", "codesigning"], {
    capture: true,
  });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.match(/"(.+?)"/)?.[1])
    .filter(Boolean);
}

function signingIdentity() {
  const configured = process.env.MR_KIT_SIGNING_IDENTITY || process.env.APPLE_SIGNING_IDENTITY;
  if (configured) {
    return configured;
  }

  const identities = codesignIdentities();
  return (
    identities.find((identity) => identity.startsWith("Developer ID Application:")) ||
    identities.find((identity) => identity.startsWith("Apple Development:")) ||
    ""
  );
}

function macSigningConfig() {
  if (!isMac) {
    return {};
  }

  if (process.env.APPLE_CERTIFICATE) {
    return {
      bundle: {
        macOS: {
          hardenedRuntime: true,
          ...(process.env.APPLE_PROVIDER_SHORT_NAME
            ? { providerShortName: process.env.APPLE_PROVIDER_SHORT_NAME }
            : {}),
        },
      },
    };
  }

  if (process.env.MR_KIT_ALLOW_UNSIGNED === "1") {
    console.warn("MR_KIT_ALLOW_UNSIGNED=1，跳过 macOS 签名配置。");
    return {};
  }

  const identity = signingIdentity();
  if (!identity) {
    console.error("未找到可用的 macOS 签名证书。");
    console.error("请安装 Developer ID Application 证书，或设置：");
    console.error("  MR_KIT_SIGNING_IDENTITY=\"Developer ID Application: ...\"");
    console.error("也可以用 APPLE_CERTIFICATE / APPLE_CERTIFICATE_PASSWORD 走 CI 证书导入。");
    process.exit(1);
  }

  console.log(`使用签名身份: ${identity}`);
  return {
    bundle: {
      macOS: {
        signingIdentity: identity,
        hardenedRuntime: true,
        ...(process.env.APPLE_PROVIDER_SHORT_NAME
          ? { providerShortName: process.env.APPLE_PROVIDER_SHORT_NAME }
          : {}),
      },
    },
  };
}

const tempDir = mkdtempSync(join(tmpdir(), "mr-kit-build-"));
const configPath = join(tempDir, "tauri.signing.conf.json");

try {
  writeFileSync(configPath, JSON.stringify(macSigningConfig(), null, 2));
  const args = ["tauri", "build", "--config", configPath, ...process.argv.slice(2)];
  const result = run("npx", args);
  process.exit(result.status ?? 1);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

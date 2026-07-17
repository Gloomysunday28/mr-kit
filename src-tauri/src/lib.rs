use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::str::FromStr;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Size};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};

const TOGGLE_SHORTCUT: &str = "CommandOrControl+Shift+M";
const CREATE_MR_SHORTCUT: &str = "CommandOrControl+Shift+Enter";
const OPENAI_TITLE_MODEL: &str = "gpt-5.6-luna";
const TRAY_ID: &str = "mr-kit-tray";
const TARGET_BRANCHES: [&str; 3] = ["us-develop", "us-pre", "us-release"];
const HOMEBREW_TAP: &str = "Gloomysunday28/mr-kit";
const HOMEBREW_TAP_URL: &str = "https://github.com/Gloomysunday28/mr-kit.git";

struct DesktopPin(Mutex<bool>);

/// GUI 应用在 macOS 下不继承 shell PATH，补上 Homebrew 等常见路径，
/// 否则打包后的 app 找不到 glab / git。
fn build_cmd(program: &str, cwd: Option<&str>) -> Command {
    let mut cmd = Command::new(program);
    let home = std::env::var("HOME").unwrap_or_default();
    let path = std::env::var("PATH").unwrap_or_default();
    cmd.env(
        "PATH",
        format!("{path}:/opt/homebrew/bin:/usr/local/bin:{home}/.local/bin"),
    );
    if !home.is_empty() {
        cmd.env("CLAUDE_CONFIG_DIR", format!("{home}/.claude"));
        cmd.env("CODEX_HOME", format!("{home}/.codex"));
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null());
    cmd
}

struct CmdOutput {
    ok: bool,
    stdout: String,
    stderr: String,
}

fn run_cmd(program: &str, args: &[&str], cwd: Option<&str>) -> Result<CmdOutput, String> {
    let output = build_cmd(program, cwd)
        .args(args)
        .output()
        .map_err(|e| format!("无法执行 {program}: {e}"))?;
    Ok(CmdOutput {
        ok: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

fn git(path: &str, args: &[&str]) -> Result<CmdOutput, String> {
    run_cmd("git", args, Some(path))
}

#[derive(Serialize, Default)]
struct GitInfo {
    is_repo: bool,
    root: String,
    branch: String,
    remote_name: String,
    remote_url: String,
    dirty_count: usize,
    changed_files: Vec<String>,
    has_upstream: bool,
    ahead: usize,
    behind: usize,
    error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppUpdateInfo {
    cask: String,
    version: String,
    current_version: String,
    notes: String,
}

fn ensure_homebrew_tap() -> Result<(), String> {
    let taps = run_cmd("brew", &["tap"], None)?;
    if !taps.ok {
        return Err(command_error("读取 Homebrew tap 失败", &taps));
    }
    let expected = HOMEBREW_TAP.to_lowercase();
    if !taps
        .stdout
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case(&expected))
    {
        let tap = run_cmd("brew", &["tap", HOMEBREW_TAP, HOMEBREW_TAP_URL], None)?;
        if !tap.ok {
            return Err(command_error("添加 Homebrew tap 失败", &tap));
        }
    }

    let trust = run_cmd("brew", &["trust", HOMEBREW_TAP], None)?;
    let trust_output = format!("{}\n{}", trust.stdout, trust.stderr);
    if !trust.ok && !trust_output.contains("Unknown command") {
        return Err(command_error("信任 Homebrew tap 失败", &trust));
    }
    Ok(())
}

fn installed_homebrew_cask_version(cask: &str) -> Result<Option<String>, String> {
    let out = run_cmd("brew", &["list", "--cask", "--versions", cask], None)?;
    if !out.ok || out.stdout.trim().is_empty() {
        return Ok(None);
    }
    Ok(out
        .stdout
        .split_whitespace()
        .nth(1)
        .map(|version| version.to_string()))
}

fn homebrew_cask_current_version(cask: &str) -> Result<String, String> {
    let info = run_cmd("brew", &["info", "--cask", "--json=v2", cask], None)?;
    if !info.ok {
        return Err(command_error("Homebrew cask 不可用", &info));
    }
    let json: serde_json::Value =
        serde_json::from_str(&info.stdout).map_err(|e| format!("解析 Homebrew cask 失败：{e}"))?;
    Ok(json
        .get("casks")
        .and_then(|v| v.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("version"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

#[tauri::command]
async fn check_homebrew_update(cask: String) -> Result<Option<AppUpdateInfo>, String> {
    let cask = cask.trim();
    if cask.is_empty() {
        return Err("Homebrew cask 名称不能为空".to_string());
    }

    ensure_homebrew_tap()?;

    let installed_version = installed_homebrew_cask_version(cask)?;
    let current_info_version = homebrew_cask_current_version(cask)?;
    if installed_version.is_none() {
        return Ok(Some(AppUpdateInfo {
            cask: cask.to_string(),
            version: String::new(),
            current_version: current_info_version,
            notes: "可通过 Homebrew 安装".to_string(),
        }));
    }

    let _ = run_cmd("brew", &["update", "--quiet"], None);
    let out = run_cmd("brew", &["outdated", "--cask", "--json=v2", cask], None)?;
    let json: serde_json::Value = serde_json::from_str(&out.stdout).map_err(|e| {
        if out.ok {
            format!("解析 Homebrew 更新失败：{e}")
        } else {
            command_error("检查 Homebrew 更新失败", &out)
        }
    })?;
    let Some(item) = json
        .get("casks")
        .and_then(|v| v.as_array())
        .and_then(|items| items.first())
    else {
        return Ok(None);
    };

    let current_version = item
        .get("current_version")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let version = item
        .get("installed_versions")
        .and_then(|v| v.as_array())
        .and_then(|items| items.first())
        .and_then(|v| v.as_str())
        .or(installed_version.as_deref())
        .unwrap_or("")
        .to_string();
    Ok(Some(AppUpdateInfo {
        cask: cask.to_string(),
        version,
        current_version,
        notes: "Homebrew 有可用更新".to_string(),
    }))
}

#[tauri::command]
async fn install_homebrew_update(app: AppHandle, cask: String) -> Result<(), String> {
    let cask = cask.trim();
    if cask.is_empty() {
        return Err("Homebrew cask 名称不能为空".to_string());
    }
    ensure_homebrew_tap()?;

    let installed = installed_homebrew_cask_version(cask)?.is_some();
    let args = if installed {
        vec!["upgrade", "--cask", cask]
    } else {
        vec!["install", "--cask", "--force", cask]
    };
    let out = run_cmd("brew", &args, None)?;
    if !out.ok {
        return Err(command_error("Homebrew 安装或升级失败", &out));
    }
    let app_path = PathBuf::from("/Applications/MR Kit.app");
    if app_path.exists() {
        let path = app_path.to_string_lossy().to_string();
        let open = run_cmd("open", &["-n", &path], None)?;
        if !open.ok {
            return Err(command_error("重新打开 MR Kit 失败", &open));
        }
        app.exit(0);
    } else {
        app.restart();
    }
    Ok(())
}

#[tauri::command]
async fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    let folder = app.dialog().file().blocking_pick_folder();
    Ok(folder.map(|f| f.to_string()))
}

#[tauri::command]
async fn git_info(path: String) -> Result<GitInfo, String> {
    let mut info = GitInfo::default();

    let root = git(&path, &["rev-parse", "--show-toplevel"])?;
    if !root.ok {
        info.error = "该目录不是 Git 仓库".to_string();
        return Ok(info);
    }
    info.is_repo = true;
    info.root = root.stdout;

    info.branch = git(&path, &["branch", "--show-current"])?.stdout;

    // 远程：优先 origin
    let remotes = git(&path, &["remote"])?.stdout;
    let remote_list: Vec<&str> = remotes.lines().collect();
    info.remote_name = if remote_list.contains(&"origin") {
        "origin".to_string()
    } else {
        remote_list.first().unwrap_or(&"").to_string()
    };
    if !info.remote_name.is_empty() {
        info.remote_url = git(&path, &["remote", "get-url", &info.remote_name])?.stdout;
    }

    // 工作区改动
    let status = git(&path, &["status", "--porcelain"])?.stdout;
    let lines: Vec<&str> = status.lines().filter(|l| !l.is_empty()).collect();
    info.dirty_count = lines.len();
    info.changed_files = lines.iter().take(8).map(|s| s.to_string()).collect();

    // 相对上游的领先/落后
    let ahead = git(&path, &["rev-list", "--count", "@{u}..HEAD"])?;
    if ahead.ok {
        info.has_upstream = true;
        info.ahead = ahead.stdout.parse().unwrap_or(0);
        let behind = git(&path, &["rev-list", "--count", "HEAD..@{u}"])?;
        info.behind = behind.stdout.parse().unwrap_or(0);
    }

    Ok(info)
}

#[tauri::command]
async fn list_branches(path: String) -> Result<Vec<String>, String> {
    let out = git(&path, &["branch", "--format=%(refname:short)"])?;
    Ok(out.stdout.lines().map(|s| s.to_string()).collect())
}

#[tauri::command]
async fn git_fetch(path: String, remote: String) -> Result<String, String> {
    let out = git(&path, &["fetch", &remote, "--prune"])?;
    if out.ok {
        Ok("fetch 完成".to_string())
    } else {
        Err(out.stderr)
    }
}

/// target..source 的提交列表，用于提炼 MR 标题
#[tauri::command]
async fn commits_between(
    path: String,
    remote: String,
    target: String,
    source: String,
) -> Result<Vec<String>, String> {
    let range = format!("{remote}/{target}..{source}");
    let out = git(&path, &["log", &range, "--oneline", "-20"])?;
    if out.ok {
        Ok(out.stdout.lines().map(|s| s.to_string()).collect())
    } else {
        // 远程目标分支不存在等情况：退回最近一条提交
        let last = git(&path, &["log", "-1", "--oneline"])?;
        Ok(last.stdout.lines().map(|s| s.to_string()).collect())
    }
}

/// 按 UTF-8 字符边界截断，避免切在多字节字符中间 panic
fn truncate_chars(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiConfig {
    provider: String, // "claude" | "openai" | "custom"
    base_url: String,
    api_key: String,
    model: String,
}

fn command_error(name: &str, out: &CmdOutput) -> String {
    let detail = if !out.stderr.is_empty() {
        &out.stderr
    } else if !out.stdout.is_empty() {
        &out.stdout
    } else {
        "命令执行失败"
    };
    format!("{name}：{}", truncate_chars(detail, 1200))
}

fn strip_title_prefix(line: &str) -> &str {
    for prefix in [
        "MR 标题：",
        "MR 标题:",
        "标题：",
        "标题:",
        "Commit:",
        "commit:",
    ] {
        if let Some(rest) = line.strip_prefix(prefix) {
            return rest.trim();
        }
    }
    line
}

fn is_valid_conventional_head(head: &str) -> bool {
    let head = head.strip_suffix('!').unwrap_or(head);
    let (kind, scope_ok) = if let Some(open) = head.find('(') {
        if !head.ends_with(')') || open == 0 {
            return false;
        }
        let scope = &head[open + 1..head.len() - 1];
        (
            &head[..open],
            !scope.trim().is_empty() && !scope.chars().any(char::is_whitespace),
        )
    } else {
        (head, true)
    };
    scope_ok
        && matches!(
            kind,
            "feat"
                | "fix"
                | "docs"
                | "style"
                | "refactor"
                | "perf"
                | "test"
                | "build"
                | "ci"
                | "chore"
                | "revert"
        )
}

fn normalize_conventional_title(text: &str) -> String {
    for raw in text.lines() {
        let line = raw
            .trim()
            .trim_start_matches(|c| c == '-' || c == '*' || c == '•')
            .trim();
        if line.is_empty() || line.starts_with("```") {
            continue;
        }
        let line = strip_title_prefix(line)
            .trim_matches(|c| {
                c == '"' || c == '“' || c == '”' || c == '「' || c == '」' || c == '`'
            })
            .trim();
        if let Some((head, subject)) = line.split_once(':').or_else(|| line.split_once('：')) {
            let head = head.trim();
            let subject = subject.trim();
            if !subject.is_empty() && is_valid_conventional_head(head) {
                return format!("{head}: {subject}");
            }
        }
    }
    String::new()
}

fn claude_title(path: &str, prompt: &str) -> Result<String, String> {
    let out = run_cmd(
        "claude",
        &[
            "-p",
            "--safe-mode",
            "--no-session-persistence",
            "--output-format",
            "text",
            "--permission-mode",
            "dontAsk",
            prompt,
        ],
        Some(path),
    )
    .map_err(|e| format!("无法调用 Claude Code，请确认已安装并配置 ~/.claude：{e}"))?;
    if out.ok {
        Ok(out.stdout)
    } else {
        Err(command_error(
            "Claude Code 调用失败，请检查 ~/.claude 登录配置",
            &out,
        ))
    }
}

fn codex_program() -> String {
    if let Ok(program) = std::env::var("CODEX_CLI_PATH") {
        if Path::new(&program).is_file() {
            return program;
        }
    }

    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let candidates = [
            "/Applications/ChatGPT.app/Contents/Resources/codex".to_string(),
            "/Applications/Codex.app/Contents/Resources/codex".to_string(),
            format!("{home}/Applications/ChatGPT.app/Contents/Resources/codex"),
            format!("{home}/Applications/Codex.app/Contents/Resources/codex"),
        ];
        if let Some(program) = candidates.iter().find(|p| Path::new(p).is_file()) {
            return program.clone();
        }
    }

    "codex".to_string()
}

fn codex_output_path() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!("mr-kit-codex-{}-{nonce}.txt", std::process::id()))
}

fn openai_title(path: &str, prompt: &str) -> Result<String, String> {
    let program = codex_program();
    let output_path = codex_output_path();
    let output_file = output_path.to_string_lossy().into_owned();
    let out = run_cmd(
        &program,
        &[
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--disable",
            "plugins",
            "--disable",
            "hooks",
            "--disable",
            "memories",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--color",
            "never",
            "-m",
            OPENAI_TITLE_MODEL,
            "-c",
            "model_reasoning_effort=\"low\"",
            "-c",
            "service_tier=\"priority\"",
            "-c",
            "include_skills_usage_instructions=false",
            "-c",
            "model_reasoning_summary=\"none\"",
            "-c",
            "notify=[]",
            "-c",
            "mcp_servers={}",
            "-o",
            &output_file,
            prompt,
        ],
        Some(path),
    )
    .map_err(|e| format!("无法调用 Codex，请确认已安装并登录：{e}"))?;

    let text = fs::read_to_string(&output_path).unwrap_or_default();
    let _ = fs::remove_file(&output_path);
    if out.ok {
        if text.trim().is_empty() {
            Ok(out.stdout)
        } else {
            Ok(text)
        }
    } else {
        Err(command_error("Codex 调用失败，请检查 Codex 登录配置", &out))
    }
}

/// 调用 AI 渠道总结暂存区改动，生成符合 Conventional Commits 的 MR 标题
#[tauri::command]
async fn ai_title(path: String, config: AiConfig) -> Result<String, String> {
    let stat = git(&path, &["diff", "--cached", "--stat"])?;
    if stat.stdout.is_empty() {
        return Err("暂存区为空，请先 git add 要提交的文件".to_string());
    }
    let diff = git(&path, &["diff", "--cached", "--unified=0"])?;

    let prompt = format!(
        "根据下面的 git 暂存区改动生成一行 GitLab MR 标题。\
         标题必须严格符合 Conventional Commits / git commit 规范：type(scope): subject。\
         type 只能从 feat、fix、docs、style、refactor、perf、test、build、ci、chore、revert 中选择。\
         scope 可省略；如果分支或文件能看出模块，优先使用具体模块名，例如 home、mr、settings。\
         subject 用简洁自然的中文概括本次改动目的，优先动宾短句，例如“调整首页间距并清理默认标题缓存”。\
         不要机械照搬英文分支名、文件夹名或 diff token，不要输出“更新 style home gap”这类中英混杂标题。\
         不要用生硬连接词；能合并时用“并”。整行不超过 72 个字符。\
         只输出一行标题本身，不要解释、引号、Markdown 或任何前缀。\
         示例：feat(dispatch): 支持批量创建 MR\n\
         反例：feat(apps): 更新 style home gap 删除默认的 title 以及 原来的缓存\n\
         正例：feat(home): 调整首页间距并清理默认标题缓存\n\n\
         改动文件：\n{}\n\ndiff（可能被截断）：\n{}",
        truncate_chars(&stat.stdout, 2000),
        truncate_chars(&diff.stdout, 6000),
    );

    let text = match config.provider.as_str() {
        "claude" => claude_title(&path, &prompt)?,
        "openai" => openai_title(&path, &prompt)?,
        "custom" => {
            if config.base_url.trim().is_empty()
                || config.api_key.trim().is_empty()
                || config.model.trim().is_empty()
            {
                return Err("自定义渠道缺少 Base URL、API Key 或模型".to_string());
            }
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .map_err(|e| e.to_string())?;
            let base = config.base_url.trim_end_matches('/');
            let resp = client
                .post(format!("{base}/chat/completions"))
                .bearer_auth(&config.api_key)
                .json(&serde_json::json!({
                    "model": config.model,
                    "max_tokens": 200,
                    "messages": [{ "role": "user", "content": prompt }],
                }))
                .send()
                .await
                .map_err(|e| format!("请求失败：{e}"))?;
            let status = resp.status();
            let body: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("响应解析失败：{e}"))?;
            if !status.is_success() {
                return Err(format!(
                    "API {status}：{}",
                    body["error"]["message"]
                        .as_str()
                        .unwrap_or(&body.to_string())
                ));
            }
            body["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("")
                .to_string()
        }
        _ => return Err(format!("不支持的 AI 渠道：{}", config.provider)),
    };

    let title = normalize_conventional_title(&text);
    if title.is_empty() {
        return Err("AI 未返回符合 Conventional Commits 的标题，请重试或手动填写".to_string());
    }
    Ok(title)
}

#[tauri::command]
async fn stage_all(path: String) -> Result<(), String> {
    let out = git(&path, &["add", "--all"])?;
    if out.ok {
        Ok(())
    } else {
        Err(command_error("git add 失败", &out))
    }
}

#[tauri::command]
async fn commit_staged(path: String, title: String) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("提交标题不能为空".to_string());
    }

    let diff = git(&path, &["diff", "--cached", "--quiet"])?;
    if diff.ok {
        return Err("暂存区为空，没有可提交的改动".to_string());
    }

    let out = git(&path, &["commit", "--no-verify", "-m", title])?;
    if out.ok {
        Ok(format!("{}\n{}", out.stdout, out.stderr).trim().to_string())
    } else {
        Err(command_error("git commit 失败", &out))
    }
}

#[tauri::command]
async fn push_branch(path: String, remote: String, branch: String) -> Result<String, String> {
    let out = git(&path, &["push", "-u", &remote, &branch])?;
    if out.ok {
        Ok(format!("已推送 {branch} 到 {remote}\n{}", out.stderr))
    } else {
        Err(out.stderr)
    }
}

#[derive(Serialize)]
struct GlabStatus {
    installed: bool,
    version: String,
    authed: bool,
    detail: String,
}

#[tauri::command]
async fn glab_status(path: String) -> Result<GlabStatus, String> {
    let ver = match run_cmd("glab", &["version"], Some(&path)) {
        Ok(v) if v.ok => v.stdout,
        _ => {
            return Ok(GlabStatus {
                installed: false,
                version: String::new(),
                authed: false,
                detail: "未安装 glab，请执行: brew install glab".to_string(),
            })
        }
    };
    let auth = run_cmd("glab", &["auth", "status"], Some(&path))?;
    // glab auth status 输出在 stderr
    let detail = if auth.stderr.is_empty() {
        auth.stdout
    } else {
        auth.stderr
    };
    Ok(GlabStatus {
        installed: true,
        version: ver,
        authed: auth.ok,
        detail,
    })
}

#[derive(Serialize)]
struct MrResult {
    target: String,
    ok: bool,
    url: String,
    output: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BranchMr {
    iid: String,
    title: String,
    target_branch: String,
    url: String,
    has_conflicts: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DingtalkConfig {
    webhook: String,
    #[serde(default)]
    user_id: String,
    #[serde(default)]
    user_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DingtalkDefaults {
    webhook: String,
    user_id: String,
}

fn dingtalk_config_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "无法读取 HOME 目录".to_string())?;
    Ok(Path::new(&home).join(".mr-kit").join("dingtalk.json"))
}

#[tauri::command]
async fn dingtalk_defaults() -> Result<DingtalkDefaults, String> {
    let path = dingtalk_config_path()?;
    if !path.is_file() {
        return Ok(DingtalkDefaults::default());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取钉钉配置失败：{e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("解析钉钉配置失败：{e}"))
}

fn url_encode(input: &str) -> String {
    let mut out = String::new();
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn project_path_from_remote(remote_url: &str) -> Option<String> {
    let remote = remote_url.trim().trim_end_matches(".git");
    if remote.is_empty() {
        return None;
    }

    let path = if let Some(rest) = remote.strip_prefix("git@") {
        rest.split_once(':').map(|(_, path)| path.to_string())?
    } else if let Some(idx) = remote.find("://") {
        let rest = &remote[idx + 3..];
        let path_start = rest.find('/')?;
        rest[path_start + 1..].to_string()
    } else {
        remote.to_string()
    };

    let path = path.trim_start_matches('/').trim_end_matches(".git").trim();
    if path.contains('/') {
        Some(path.to_string())
    } else {
        None
    }
}

fn mr_has_conflicts(json: &serde_json::Value) -> bool {
    let has_conflicts = json
        .get("has_conflicts")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let merge_status = json
        .get("merge_status")
        .or_else(|| json.get("detailed_merge_status"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    has_conflicts || merge_status.contains("conflict")
}

fn branch_mr_from_json(path: &str, project: &str, item: &serde_json::Value) -> BranchMr {
    let iid = item
        .get("iid")
        .map(|v| {
            v.as_i64()
                .map(|n| n.to_string())
                .or_else(|| v.as_str().map(|s| s.to_string()))
                .unwrap_or_default()
        })
        .unwrap_or_default();
    let mut has_conflicts = mr_has_conflicts(item);

    // GitLab 的列表接口可能不会主动刷新 mergeability；补查单个 MR 让冲突标记更准。
    if !iid.is_empty() {
        let endpoint = format!("projects/{}/merge_requests/{}", url_encode(project), iid);
        if let Ok(detail) = run_cmd("glab", &["api", &endpoint], Some(path)) {
            if detail.ok {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&detail.stdout) {
                    has_conflicts = mr_has_conflicts(&json);
                }
            }
        }
    }

    BranchMr {
        iid,
        title: item
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        target_branch: item
            .get("target_branch")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        url: item
            .get("web_url")
            .or_else(|| item.get("url"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        has_conflicts,
    }
}

#[tauri::command]
async fn open_branch_mrs(
    path: String,
    remote: String,
    source: String,
) -> Result<Vec<BranchMr>, String> {
    let remote = git(&path, &["remote", "get-url", &remote])?;
    if !remote.ok {
        return Ok(Vec::new());
    }
    let Some(project) = project_path_from_remote(&remote.stdout) else {
        return Ok(Vec::new());
    };
    let endpoint = format!(
        "projects/{}/merge_requests?state=opened&scope=all&source_branch={}&per_page=20",
        url_encode(&project),
        url_encode(&source)
    );
    let out = run_cmd("glab", &["api", &endpoint], Some(&path))?;
    if !out.ok {
        return Err(command_error("MR 列表读取失败", &out));
    }
    let json: serde_json::Value =
        serde_json::from_str(&out.stdout).map_err(|e| format!("MR 列表解析失败：{e}"))?;
    let items = json.as_array().cloned().unwrap_or_default();
    Ok(items
        .iter()
        .map(|item| branch_mr_from_json(&path, &project, item))
        .collect())
}

#[tauri::command]
async fn approve_mr(path: String, iid: String) -> Result<String, String> {
    let out = run_cmd("glab", &["mr", "approve", &iid], Some(&path))?;
    if out.ok {
        Ok(format!("{}\n{}", out.stdout, out.stderr).trim().to_string())
    } else {
        Err(command_error("MR 审批失败", &out))
    }
}

#[tauri::command]
async fn close_mr(path: String, iid: String) -> Result<String, String> {
    let out = run_cmd("glab", &["mr", "close", &iid], Some(&path))?;
    if out.ok {
        Ok(format!("{}\n{}", out.stdout, out.stderr).trim().to_string())
    } else {
        Err(command_error("MR 关闭失败", &out))
    }
}

#[tauri::command]
async fn notify_dingtalk_approval(
    config: DingtalkConfig,
    target: String,
    source: String,
    title: String,
    url: String,
) -> Result<String, String> {
    let webhook = config.webhook.trim();
    let mut user_ids = if config.user_ids.is_empty() {
        vec![config.user_id]
    } else {
        config.user_ids
    };
    user_ids = user_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    user_ids.sort();
    user_ids.dedup();
    if webhook.is_empty() {
        return Err("钉钉 webhook 未配置".to_string());
    }
    if user_ids.is_empty() {
        return Err("钉钉审批人未配置".to_string());
    }
    let mentions = user_ids
        .iter()
        .map(|id| format!("@{id}"))
        .collect::<Vec<_>>()
        .join(" ");

    let text = format!(
        "{mentions} MR Kit 提醒：请审批 {target} MR\n\n- 标题：{title}\n- 源分支：{source}\n- 目标分支：{target}\n- 链接：{url}"
    );
    let payload = serde_json::json!({
        "msgtype": "markdown",
        "markdown": {
            "title": "MR 审批提醒",
            "text": text,
        },
        "at": {
            "atUserIds": user_ids,
            "atDingtalkIds": user_ids,
            "isAtAll": false,
        }
    });

    let resp = reqwest::Client::new()
        .post(webhook)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("钉钉通知请求失败：{e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("钉钉通知响应解析失败：{e}"))?;
    let errcode = body.get("errcode").and_then(|v| v.as_i64()).unwrap_or(-1);
    if status.is_success() && errcode == 0 {
        Ok(format!("已通知 {}", mentions))
    } else {
        let message = body
            .get("errmsg")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        Err(format!("钉钉通知失败：{message}"))
    }
}

fn extract_mr_url(text: &str) -> String {
    text.split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ',' | '[' | ']' | '(' | ')'))
        .find_map(|part| {
            let url = part.trim_matches(|c: char| matches!(c, '.' | ';' | ':' | '}'));
            if url.starts_with("http") && url.contains("/merge_requests/") {
                Some(url.to_string())
            } else {
                None
            }
        })
        .unwrap_or_default()
}

fn extract_existing_mr_iid(text: &str) -> Option<String> {
    if !text.contains("Another open merge request already exists") {
        return None;
    }
    for (idx, _) in text.match_indices('!') {
        let digits: String = text[idx + 1..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if !digits.is_empty() {
            return Some(digits);
        }
    }
    None
}

fn existing_mr_url(path: &str, iid: &str, source: &str, target: &str) -> String {
    let view = run_cmd("glab", &["mr", "view", iid, "--output", "json"], Some(path));
    if let Ok(view) = view {
        let combined = format!("{}\n{}", view.stdout, view.stderr)
            .trim()
            .to_string();
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&view.stdout) {
            for key in ["web_url", "webUrl", "url"] {
                if let Some(url) = json.get(key).and_then(|v| v.as_str()) {
                    if url.contains("/merge_requests/") {
                        return url.to_string();
                    }
                }
            }
        }
        let url = extract_mr_url(&combined);
        if !url.is_empty() {
            return url;
        }
    }

    let list = run_cmd(
        "glab",
        &[
            "mr",
            "list",
            "--source-branch",
            source,
            "--target-branch",
            target,
            "--output",
            "json",
            "--per-page",
            "1",
        ],
        Some(path),
    );
    if let Ok(list) = list {
        let combined = format!("{}\n{}", list.stdout, list.stderr)
            .trim()
            .to_string();
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&list.stdout) {
            if let Some(items) = json.as_array() {
                if let Some(first) = items.first() {
                    for key in ["web_url", "webUrl", "url"] {
                        if let Some(url) = first.get(key).and_then(|v| v.as_str()) {
                            if url.contains("/merge_requests/") {
                                return url.to_string();
                            }
                        }
                    }
                }
            }
        }
        let url = extract_mr_url(&combined);
        if !url.is_empty() {
            return url;
        }
    }

    String::new()
}

#[tauri::command]
async fn create_mr(
    path: String,
    source: String,
    target: String,
    title: String,
) -> Result<MrResult, String> {
    let out = run_cmd(
        "glab",
        &[
            "mr",
            "create",
            "--source-branch",
            &source,
            "--target-branch",
            &target,
            "--title",
            &title,
            "--fill",
            "--yes",
        ],
        Some(&path),
    )?;
    let combined = format!("{}\n{}", out.stdout, out.stderr).trim().to_string();
    // glab 会在输出里打印 MR 链接
    let mut url = extract_mr_url(&combined);
    if !out.ok {
        if let Some(iid) = extract_existing_mr_iid(&combined) {
            if url.is_empty() {
                url = existing_mr_url(&path, &iid, &source, &target);
            }
            return Ok(MrResult {
                target,
                ok: true,
                url,
                output: format!("已有打开的 MR !{iid}，已复用。"),
            });
        }
    }
    Ok(MrResult {
        target,
        ok: out.ok,
        url,
        output: combined,
    })
}

#[tauri::command]
async fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    tauri_plugin_opener::open_url(&url, None::<String>).map_err(|e| e.to_string())?;
    let _ = app;
    Ok(())
}

#[tauri::command]
async fn notify_user(app: AppHandle, title: String, body: String) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Ok(());
    }

    let body = body.trim();
    let mut notification = notify_rust::Notification::new();
    notification.summary(title).auto_icon();
    if !body.is_empty() {
        notification.body(body);
    }

    #[cfg(windows)]
    {
        notification.app_id(&app.config().identifier);
    }
    #[cfg(target_os = "macos")]
    {
        let identifier = if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            app.config().identifier.as_str()
        };
        let _ = notify_rust::set_application(identifier);
    }

    let handle = notification.show().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn(async move {
        handle.wait_for_action(move |action| {
            if action == "default" {
                show_main_window(&app);
            }
        });
    });
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayContext {
    dir: Option<String>,
    repos: Vec<String>,
    branch: String,
    source: String,
    targets: Vec<String>,
    pinned: bool,
}

fn repo_label(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

fn menu_label(text: &str, max_chars: usize) -> String {
    let mut out: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        out.push('…');
    }
    out
}

fn build_tray_menu(app: &AppHandle, ctx: Option<&TrayContext>) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;

    let current_text = ctx
        .and_then(|c| c.dir.as_deref())
        .map(|p| format!("当前目录: {}", menu_label(&repo_label(p), 28)))
        .unwrap_or_else(|| "当前目录: 未选择".to_string());
    menu.append(&MenuItem::with_id(
        app,
        "info:repo",
        current_text,
        false,
        None::<&str>,
    )?)?;

    let branch_text = ctx
        .map(|c| {
            let source = if c.source.trim().is_empty() {
                c.branch.as_str()
            } else {
                c.source.as_str()
            };
            format!("源分支: {}", menu_label(source, 36))
        })
        .unwrap_or_else(|| "源分支: -".to_string());
    menu.append(&MenuItem::with_id(
        app,
        "info:source",
        branch_text,
        false,
        None::<&str>,
    )?)?;

    let target_menu = Submenu::with_id(app, "submenu:targets", "目标分支", true)?;
    for target in TARGET_BRANCHES {
        let selected = ctx
            .map(|c| c.targets.iter().any(|t| t == target))
            .unwrap_or(false);
        target_menu.append(&CheckMenuItem::with_id(
            app,
            format!("target:{target}"),
            target,
            true,
            selected,
            None::<&str>,
        )?)?;
    }
    menu.append(&target_menu)?;

    let repo_menu = Submenu::with_id(app, "submenu:repos", "切换目录", true)?;
    if let Some(ctx) = ctx {
        if ctx.repos.is_empty() {
            repo_menu.append(&MenuItem::with_id(
                app,
                "repo:none",
                "暂无目录",
                false,
                None::<&str>,
            )?)?;
        } else {
            for (idx, repo) in ctx.repos.iter().enumerate() {
                repo_menu.append(&CheckMenuItem::with_id(
                    app,
                    format!("repo:{idx}"),
                    menu_label(&repo_label(repo), 28),
                    true,
                    ctx.dir.as_deref() == Some(repo.as_str()),
                    None::<&str>,
                )?)?;
            }
        }
    } else {
        repo_menu.append(&MenuItem::with_id(
            app,
            "repo:none",
            "暂无目录",
            false,
            None::<&str>,
        )?)?;
    }
    menu.append(&repo_menu)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "create-mr",
        "发起 MR (⌘⇧Enter)",
        ctx.map(|c| c.dir.is_some() && !c.targets.is_empty())
            .unwrap_or(false),
        None::<&str>,
    )?)?;
    menu.append(&CheckMenuItem::with_id(
        app,
        "desktop-pin",
        "缩小为桌面小窗",
        true,
        ctx.map(|c| c.pinned).unwrap_or(false),
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "move-pin-to-cursor",
        "移动小窗到鼠标位置",
        ctx.map(|c| c.pinned).unwrap_or(false),
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "toggle",
        "显示 / 隐藏 (⌘⇧M)",
        true,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "退出 MR Kit",
        true,
        None::<&str>,
    )?)?;

    Ok(menu)
}

#[cfg(target_os = "macos")]
fn clear_macos_compact_collection_behavior(app: &AppHandle) {
    let app_for_thread = app.clone();
    let _ = app.run_on_main_thread(move || {
        use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

        let Some(win) = app_for_thread.get_webview_window("main") else {
            return;
        };
        let Ok(ns_window_ptr) = win.ns_window() else {
            return;
        };

        unsafe {
            let ns_window: &NSWindow = &*ns_window_ptr.cast();
            let mut behavior = ns_window.collectionBehavior();
            behavior &= !NSWindowCollectionBehavior::CanJoinAllSpaces;
            behavior &= !NSWindowCollectionBehavior::FullScreenAuxiliary;
            behavior &= !NSWindowCollectionBehavior::FullScreenNone;
            ns_window.setCollectionBehavior(behavior);
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn clear_macos_compact_collection_behavior(_app: &AppHandle) {}

fn apply_desktop_pin(app: &AppHandle, pinned: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        if pinned {
            let _ = win.unminimize();
            win.set_min_size(Some(Size::Logical(LogicalSize::new(360.0, 136.0))))
                .map_err(|e| e.to_string())?;
            win.set_size(Size::Logical(LogicalSize::new(420.0, 168.0)))
                .map_err(|e| e.to_string())?;
            win.set_decorations(false).map_err(|e| e.to_string())?;
            let _ = win.set_visible_on_all_workspaces(false);
            clear_macos_compact_collection_behavior(app);
            win.set_always_on_top(false).map_err(|e| e.to_string())?;
            let _ = win.show();
            let _ = win.set_focus();
        } else {
            win.set_always_on_top(false).map_err(|e| e.to_string())?;
            let _ = win.set_visible_on_all_workspaces(false);
            clear_macos_compact_collection_behavior(app);
            win.set_decorations(true).map_err(|e| e.to_string())?;
            win.set_min_size(Some(Size::Logical(LogicalSize::new(620.0, 540.0))))
                .map_err(|e| e.to_string())?;
            win.set_size(Size::Logical(LogicalSize::new(760.0, 720.0)))
                .map_err(|e| e.to_string())?;
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
    Ok(())
}

#[tauri::command]
async fn set_desktop_pin(app: AppHandle, pinned: bool) -> Result<(), String> {
    if let Ok(mut state) = app.state::<DesktopPin>().0.lock() {
        *state = pinned;
    }
    apply_desktop_pin(&app, pinned)
}

#[tauri::command]
async fn update_tray_context(app: AppHandle, context: TrayContext) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let menu = build_tray_menu(&app, Some(&context)).map_err(|e| e.to_string())?;
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        let title = context
            .dir
            .as_deref()
            .map(repo_label)
            .unwrap_or_else(|| "MR Kit".to_string());
        let targets = if context.targets.is_empty() {
            "未选择目标".to_string()
        } else {
            context.targets.join(", ")
        };
        let _ = tray.set_tooltip(Some(format!("MR Kit\n{title}\n目标: {targets}")));
    }
    Ok(())
}

fn toggle_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            show_main_window(app);
        }
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn move_pin_to_cursor(app: &AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Ok(());
    };
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let x = (cursor.x - 210.0).round() as i32;
    let y = (cursor.y - 84.0).round() as i32;
    win.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    let _ = win.show();
    let _ = win.set_focus();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let toggle_shortcut = Shortcut::from_str(TOGGLE_SHORTCUT).expect("解析显示/隐藏快捷键失败");
    let create_mr_shortcut =
        Shortcut::from_str(CREATE_MR_SHORTCUT).expect("解析发起 MR 快捷键失败");

    tauri::Builder::default()
        .manage(DesktopPin(Mutex::new(false)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts([toggle_shortcut, create_mr_shortcut])
                .expect("解析全局快捷键失败")
                .with_handler(move |app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed && *shortcut == toggle_shortcut {
                        toggle_window(app);
                    }
                    if event.state() == ShortcutState::Pressed && *shortcut == create_mr_shortcut {
                        let _ = app.emit("mrkit:create-mr", ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            // 系统托盘：常驻 + 显示/隐藏 + 退出
            let menu = build_tray_menu(app.handle(), None)?;
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("MR Kit")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_window(app),
                    "create-mr" => {
                        let _ = app.emit("mrkit:create-mr", ());
                    }
                    "desktop-pin" => {
                        let next = app
                            .state::<DesktopPin>()
                            .0
                            .lock()
                            .map(|state| !*state)
                            .unwrap_or(true);
                        if let Ok(mut state) = app.state::<DesktopPin>().0.lock() {
                            *state = next;
                        }
                        let _ = apply_desktop_pin(app, next);
                        let _ = app.emit("mrkit:desktop-pin-state", next);
                    }
                    "move-pin-to-cursor" => {
                        let _ = move_pin_to_cursor(app);
                    }
                    "quit" => app.exit(0),
                    id if id.starts_with("repo:") => {
                        if let Some(idx) = id.strip_prefix("repo:") {
                            let _ = app.emit("mrkit:switch-repo", idx.to_string());
                        }
                    }
                    id if id.starts_with("target:") => {
                        if let Some(target) = id.strip_prefix("target:") {
                            let _ = app.emit("mrkit:toggle-target", target.to_string());
                        }
                    }
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        // 关闭窗口时隐藏而不是退出，保持常驻
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let pinned = window
                    .app_handle()
                    .state::<DesktopPin>()
                    .0
                    .lock()
                    .map(|state| *state)
                    .unwrap_or(false);
                if pinned {
                    let app = window.app_handle();
                    if let Ok(mut state) = app.state::<DesktopPin>().0.lock() {
                        *state = false;
                    }
                    let _ = apply_desktop_pin(app, false);
                    let _ = app.emit("mrkit:desktop-pin-state", false);
                }
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            check_homebrew_update,
            install_homebrew_update,
            pick_directory,
            git_info,
            list_branches,
            git_fetch,
            commits_between,
            ai_title,
            stage_all,
            commit_staged,
            push_branch,
            glab_status,
            create_mr,
            open_branch_mrs,
            approve_mr,
            close_mr,
            dingtalk_defaults,
            notify_dingtalk_approval,
            open_url,
            notify_user,
            set_desktop_pin,
            update_tray_context
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

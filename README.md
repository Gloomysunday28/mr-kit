# MR Kit

基于 Tauri 2 的 GitLab MR 快捷工具。

## 功能

1. **打开目录** — 选择任意本地 Git 仓库，记住上次选择
2. **Git 检测** — 当前分支、远程、未提交改动、领先/落后上游，可一键推送
3. **快速创建 MR** — 有未提交改动时自动暂存、AI 生成标题、提交并推送，再通过 `glab mr create` 批量创建
4. **快捷目标分支** — `us-develop` / `us-pre` / `us-release` 三个主按钮（另有 `develop` / `release` 次要按钮）
5. **标题自动生成** — 按 `远程/目标..源` 的提交记录提炼标题（取最近提交 subject，≤72 字符）
6. **AI 标题** — 按 Conventional Commits 生成标题；Claude 自动读取 `~/.claude`，Codex 自动读取 `~/.codex` 并使用轻量快速模型；自定义渠道支持 OpenAI 兼容接口
7. **常驻 + 全局快捷键** — 关闭窗口隐藏到系统托盘不退出；**⌘⇧M**（Windows/Linux 为 Ctrl+Shift+M）全局唤起/隐藏

## 前置要求

- Rust 工具链（`brew install rust`）
- Node.js
- [glab](https://gitlab.com/gitlab-org/cli)（`brew install glab`），并完成认证：
  ```bash
  glab auth login --hostname gitlab.bantouyan.com
  glab auth status   # 确认已登录
  ```

## 开发运行

```bash
npm install
npm run tauri dev
```

## 打包

```bash
npm run build
```

产物在 `src-tauri/target/release/bundle/`。

macOS 打包会走签名脚本：优先使用 `MR_KIT_SIGNING_IDENTITY` / `APPLE_SIGNING_IDENTITY`，未设置时自动查找本机 `Developer ID Application` 证书。CI 可使用 `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD`。

## Homebrew 安装

```bash
brew tap Gloomysunday28/mr-kit https://github.com/Gloomysunday28/mr-kit.git
brew trust Gloomysunday28/mr-kit
brew install --cask mr-kit
```

Homebrew cask 读取 GitHub Release 里的 dmg。CI 会使用 Developer ID 证书签名并公证 macOS 包，避免下载后被 Gatekeeper 提示移到废纸篓。发布前需要配置 GitHub Secrets：`APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`，可选 `APPLE_PROVIDER_SHORT_NAME`。

发布新版本时，先同步 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 和 `Casks/mr-kit.rb` 的版本号，然后推 tag：

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions 会自动打包 macOS `aarch64` / `x64` dmg 并挂到对应 Release。

## 使用流程

1. 点「选择目录…」选中仓库（或自动恢复上次目录）
2. 查看 Git 状态；有未提交改动或未推送提交时，发起 MR 会自动提交并推送当前源分支
3. 选源分支（默认当前分支）、点选一个或多个目标分支
4. 标题留空会自动取最近提交信息；有未提交改动时会先用 AI 生成提交/MR 标题
5. 点「创建 MR」，每个目标分支各建一条 MR，结果附链接（点击用系统浏览器打开）

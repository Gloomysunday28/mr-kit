cask "mr-kit" do
  arch arm: "aarch64", intel: "x64"

  version "0.12.11"
  sha256 :no_check

  url "https://github.com/Gloomysunday28/mr-kit/releases/download/v#{version}/MR-Kit_#{version}_#{arch}.dmg",
      verified: "github.com/Gloomysunday28/mr-kit/"
  name "MR Kit"
  desc "GitLab merge request helper"
  homepage "https://github.com/Gloomysunday28/mr-kit"

  app "MR Kit.app"

  # ad-hoc 签名的包每次重打 cdhash 都会变，Gatekeeper 会对带 quarantine
  # 的新包重新要求信任；安装/升级后统一去掉隔离标记
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/MR Kit.app"]
  end

  zap trash: [
    "~/Library/Application Support/com.weiguang.mrkit",
    "~/Library/Preferences/com.weiguang.mrkit.plist",
    "~/Library/Saved Application State/com.weiguang.mrkit.savedState",
  ]
end

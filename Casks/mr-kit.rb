cask "mr-kit" do
  arch arm: "aarch64", intel: "x64"

  version "0.12.4"
  sha256 :no_check

  url "https://github.com/Gloomysunday28/mr-kit/releases/download/v#{version}/MR-Kit_#{version}_#{arch}.dmg",
      verified: "github.com/Gloomysunday28/mr-kit/"
  name "MR Kit"
  desc "GitLab merge request helper"
  homepage "https://github.com/Gloomysunday28/mr-kit"

  app "MR Kit.app"

  zap trash: [
    "~/Library/Application Support/com.weiguang.mrkit",
    "~/Library/Preferences/com.weiguang.mrkit.plist",
    "~/Library/Saved Application State/com.weiguang.mrkit.savedState",
  ]
end

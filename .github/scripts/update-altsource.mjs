// 按本仓库的 Releases 重新生成订阅源 altsource.json（SideStore / AltStore 的「源」：一份 JSON 清单，用户在商店里添加之后能安装、能看到更新）。
//
// 版本列表直接来自 Releases（tag 形如 v1.6.5-14，附件 One-unsigned.ipa；草稿和预发布不算），所以重复跑是幂等的：
// 删掉某个 Release，它就从源里消失；重新编辑 Release 的说明，源里的更新说明跟着变。
// 清单里不变的部分（名字、描述、图标、权限声明…）在 .github/altsource.template.json。
// 由 .github/workflows/update-altsource.yml 在 Release 发布 / 编辑 / 删除时跑，也可以手动跑：
//   GITHUB_REPOSITORY=ios151/One-releases [GITHUB_TOKEN=…] node .github/scripts/update-altsource.mjs [--dry-run]
// 格式依据 AltStore 官方文档 Make a Source：App 要写 appPermissions（商店拿它和安装包里的权限核对），buildVersion 要和安装包里的 CFBundleVersion 一致，versions 最新的放最前。
// 页面 index.html 里「从 Release 取版本」的规则和这里保持一致，改了要一起改。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = process.env.GITHUB_REPOSITORY || "ios151/One-releases";
const token = process.env.GITHUB_TOKEN || "";
const dryRun = process.argv.includes("--dry-run");
const ASSET_NAME = "One-unsigned.ipa";
const TAG_PATTERN = /^v(\d+(?:\.\d+)*)-(\d+)$/;
const MIN_OS = "16.0";

async function fetchReleases() {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
    headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) throw new Error(`读 Releases 失败：HTTP ${response.status}`);
  return response.json();
}

const pickAsset = (release) => (release.assets ?? []).find((asset) => asset.name === ASSET_NAME && asset.state === "uploaded");

/** 刚发布的 Release 可能还在传附件：最新的一个有符合规则的 tag 却没有附件，就等一会儿再读（最多约 2 分钟） */
async function loadReleases() {
  for (let attempt = 1; ; attempt++) {
    const releases = (await fetchReleases()).filter((release) => !release.draft && !release.prerelease);
    const newest = releases.sort((a, b) => Date.parse(b.published_at ?? b.created_at) - Date.parse(a.published_at ?? a.created_at))[0];
    const waiting = newest && TAG_PATTERN.test(newest.tag_name ?? "") && !pickAsset(newest);
    if (!waiting || attempt >= 8) return releases;
    console.log(`最新的 Release ${newest.tag_name} 还没有附件，15 秒后再读（第 ${attempt} 次）`);
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
}

function toVersions(releases) {
  const versions = [];
  for (const release of releases) {
    const match = TAG_PATTERN.exec(release.tag_name ?? "");
    const asset = pickAsset(release);
    if (!match || !asset) continue;
    const notes = String(release.body ?? "")
      .split(/\r?\n/)
      .filter((line) => /^\s*[-*]\s+/.test(line))
      .map((line) => "• " + line.replace(/^\s*[-*]\s+/, "").trim())
      .join("\n");
    versions.push({
      version: match[1],
      buildVersion: match[2],
      date: release.published_at ?? release.created_at,
      ...(notes ? { localizedDescription: notes } : {}),
      downloadURL: asset.browser_download_url,
      size: asset.size,
      minOSVersion: MIN_OS,
    });
  }
  versions.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return versions;
}

/** 写出去之前核对一遍：缺字段 / 类型不对的清单，商店会直接拒收 */
function validate(manifest) {
  const problems = [];
  const need = (condition, text) => {
    if (!condition) problems.push(text);
  };
  need(typeof manifest.name === "string" && manifest.name, "源缺 name");
  need(typeof manifest.nsfw === "boolean", "源缺 nsfw（布尔，要如实写）");
  const app = manifest.apps?.[0] ?? {};
  for (const key of ["name", "bundleIdentifier", "developerName", "localizedDescription", "iconURL"]) need(typeof app[key] === "string" && app[key], `app 缺 ${key}`);
  need(app.appPermissions && Array.isArray(app.appPermissions.entitlements) && typeof app.appPermissions.privacy === "object", "app 缺 appPermissions");
  need(Array.isArray(app.versions) && app.versions.length > 0, "versions 为空：没有符合 v<版本>-<构建号> + One-unsigned.ipa 的 Release");
  for (const version of app.versions ?? []) {
    need(/^\d+(\.\d+)*$/.test(version.version), `版本号不对：${version.version}`);
    need(/^\d+$/.test(version.buildVersion), `构建号要是字符串数字：${version.buildVersion}`);
    need(Number.isFinite(Date.parse(version.date)), `日期不是 ISO 8601：${version.date}`);
    need(String(version.downloadURL).startsWith("https://"), `downloadURL 不是 https：${version.downloadURL}`);
    need(Number.isInteger(version.size) && version.size > 0, `size 要是正整数：${version.size}`);
  }
  const keys = (app.versions ?? []).map((item) => `${item.version}-${item.buildVersion}`);
  need(new Set(keys).size === keys.length, "有重复的版本");
  if (problems.length) {
    console.error("订阅源没通过核对：\n- " + problems.join("\n- "));
    process.exit(1);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, ".github", "altsource.template.json"), "utf8"));
manifest.apps[0].versions = toVersions(await loadReleases());
validate(manifest);

const latest = manifest.apps[0].versions[0];
console.log(`订阅源：${manifest.apps[0].versions.length} 个版本（最新 ${latest.version} (${latest.buildVersion})，${(latest.size / 1048576).toFixed(1)} MB）${dryRun ? "【干跑】" : ""}`);
const content = JSON.stringify(manifest, null, 2) + "\n";
const target = path.join(root, "altsource.json");
const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
if (before === content) {
  console.log("altsource.json：没变化");
} else if (dryRun) {
  console.log(`altsource.json：会${before ? "更新" : "新建"}（${Buffer.byteLength(content)} 字节）——干跑，没写`);
} else {
  fs.writeFileSync(target, content);
  console.log(`altsource.json：已${before ? "更新" : "新建"}（${Buffer.byteLength(content)} 字节）`);
}

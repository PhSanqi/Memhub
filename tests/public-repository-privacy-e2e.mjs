import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0").filter(Boolean);
const binaryExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".zip", ".gz",
  ".tgz", ".woff", ".woff2", ".pdf"
]);

const forbidden = [
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["Slack token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ["OpenAI-style key", /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/],
  ["Cloudflare token assignment", /(?:CF_API_TOKEN|CLOUDFLARE_API_TOKEN|TUNNEL_TOKEN)\s*=\s*[A-Za-z0-9._~+/=-]{20,}/i],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["JWT literal", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/]
];
const sensitiveTokenHashes = new Set([
  "475841e7b7be6efd69fb9708e3cfdb08c5ffb8264b430f95d03e39dff8794940",
  "67f88ea0ec858b234ad7bcc5bccf0441dc8bb0a4221c5c6931e5f0ffc47a4cb8",
  "94f051a5215c2d2bc3886c6c9c529db1afbea0bc2f09bdad6015b688f6f69ecc",
  "21e62806a51ce0b639851928e3bb77addff23e8c700b4ca945aac8eeba653eba",
  "5e7db794e2309b5821c0ec14da16846c064c9a3f145223c0ffa21730856fdfdc",
  "44f9457e91d3f44b74db2f18a6129d8f607d9c126551a004d37c9f78c3bd7970",
  "af8dee72ebe9a8898ff707c233e05e89854028ded310364123078c5a36476357",
  "24169880805a81e6ec075f9eeda736572a3f5e63c69e695a004b94f1fd069f3f",
  "eb201f225a5fb064bb1a258a807bc8c45085004a12d2dd1a64581ba6d8aa0f41",
  "2f89e3128b8d548b1d6755e9a0943345f1d459a2623152924cad3e0a7f128258",
  "40c43a3c9208d7d4c2c0065084e907cc23769fb083d50dbf33e44faf197a9d38",
  "7b562afc2b51c6c26f9d0ccd75342a0ba8db50b7773c67c8c76b22d5626de865",
  "4621f9a1e9ca511ffc617de69f5745cf754de29c2da2854d0d8023df8f90405c",
  "dfb8fbd75964d3e6e77bd867483fe9be3816d515559e515ba956f6d0a8cf213f",
  "d555f154e381efe9807d6ca36b18f361e8917875394f5a349a62fe99e3fef4bb"
]);
const sensitiveDomainHashes = new Set([
  "d80eb7853fc1b606ea04aaf8cbd106f54fd6c7d226c4ca6701cad8712b0c0df5",
  "30cb3c2b27ae1ee6299f2e7946c897e573de4b022e6da250fa6f2cc7367d7ddf",
  "81713a054c89de63245a02e6f9e0a0475d1fae3b5758b0339a11934b0a919189",
  "254cbd505789a0cae573d1b042d19f35c00cb08d141ae2ae1ce2b1d5befdbe60"
]);
const sensitivePathHashes = new Set([
  "32414e216bb50095b39e362ba3a217844e79e20ae73f73a3fc4cb45a2fdafbe7",
  "ffad357d4c282b5022a7b597371f9c04c967a1a25a31a7c0e2ed305e6dfa98e6"
]);
const email = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const violations = [];
const digest = (value) => createHash("sha256").update(value.toLocaleLowerCase()).digest("hex");
const sensitiveToken = (value) => {
  for (const match of value.matchAll(/[\p{L}\p{N}_][\p{L}\p{N}_.-]{1,63}/gu)) {
    if (sensitiveTokenHashes.has(digest(match[0]))) return match[0];
  }
  return null;
};
const sensitiveDomain = (value) => {
  for (const match of value.matchAll(/\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g)) {
    if (sensitiveDomainHashes.has(digest(match[0]))) return match[0];
  }
  return null;
};
const sensitivePath = (value) => {
  const candidates = [
    ...value.matchAll(/\/home\/[^/\s]+\//g),
    ...value.matchAll(/[A-Za-z]:\\Users\\[^\\\r\n]+\\/g)
  ];
  for (const match of candidates) {
    if (sensitivePathHashes.has(digest(match[0]))) return match[0];
  }
  return null;
};

for (const file of tracked) {
  if (file === "tests/public-repository-privacy-e2e.mjs") continue;
  if (binaryExtensions.has(extname(file).toLowerCase())) continue;
  let info;
  try { info = await stat(file); } catch { continue; }
  if (!info.isFile() || info.size > 1_500_000) continue;
  if (/docs\/internal\/|release-acceptance-\d{4}-\d{2}-\d{2}/i.test(file) || sensitiveToken(file)) {
    violations.push(`${file}: private/internal path name`);
  }
  const text = await readFile(file, "utf8");
  for (const [label, pattern] of forbidden) {
    if (pattern.test(text)) violations.push(`${file}: ${label}`);
  }
  if (sensitiveToken(text)) violations.push(`${file}: private token fingerprint`);
  if (sensitiveDomain(text)) violations.push(`${file}: private hostname fingerprint`);
  if (sensitivePath(text)) violations.push(`${file}: private path fingerprint`);
  if (!file.startsWith("vendor/")) {
    for (const match of text.matchAll(email)) {
      const domain = match[1].toLowerCase();
      if (domain !== "example.com" && domain !== "example.org") {
        violations.push(`${file}: non-example email domain ${domain}`);
      }
    }
  }
}

assert.deepEqual(violations, [], `public repository privacy violations:\n${violations.join("\n")}`);
console.log(`public-repository-privacy: ok (${tracked.length} tracked paths checked)`);

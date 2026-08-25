// Publishes this package to GitHub Packages under the repo owner's scope.
// GitHub Packages requires the npm scope to match the repository owner (ztffn), while
// the source name stays @huma/path-creator for the pnpm workspace; consumers alias it.
// Stamps name/publishConfig/repository into package.json, publishes, then restores.
// Auth: GH_PACKAGES_TOKEN env var, falling back to `gh auth token`. Run via `pnpm publish:github`.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(pkgDir, "package.json");

const REGISTRY = "https://npm.pkg.github.com";
const PUBLISH_NAME = "@ztffn/path-creator";
const REPOSITORY = {
  type: "git",
  url: "https://github.com/ztffn/Path-Creator.git",
  directory: "Packages/path-creator",
};

const token =
  process.env.GH_PACKAGES_TOKEN ??
  execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
if (!token) {
  console.error("No GitHub token: set GH_PACKAGES_TOKEN or log in with gh.");
  process.exit(1);
}

const original = readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(original);
pkg.name = PUBLISH_NAME;
pkg.publishConfig = { registry: REGISTRY };
pkg.repository = REPOSITORY;

const npmrcDir = mkdtempSync(join(tmpdir(), "pc-publish-"));
const npmrcPath = join(npmrcDir, "npmrc");
writeFileSync(
  npmrcPath,
  `${REGISTRY.replace("https:", "")}/:_authToken=${token}\n`,
);

try {
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  execFileSync("npm", ["publish", "--userconfig", npmrcPath], {
    cwd: pkgDir,
    stdio: "inherit",
  });
  console.log(`Published ${PUBLISH_NAME}@${pkg.version} to ${REGISTRY}`);
} finally {
  writeFileSync(pkgPath, original);
  rmSync(npmrcDir, { recursive: true, force: true });
}

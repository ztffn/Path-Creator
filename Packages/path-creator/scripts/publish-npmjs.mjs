// Publishes this package to the public npmjs registry as @ztffn/path-creator.
// The source name stays @huma/path-creator for the pnpm workspace; consumers alias it
// ("@huma/path-creator": "npm:@ztffn/path-creator@<version>"), same name as on GitHub Packages.
// Stamps name/publishConfig/repository into package.json, publishes with public access, restores.
// Auth: your npmjs login (`npm login`) plus 2FA: NPM_OTP=<code> pnpm publish:npm.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(pkgDir, "package.json");

const REGISTRY = "https://registry.npmjs.org";
const PUBLISH_NAME = "@ztffn/path-creator";
const REPOSITORY = {
  type: "git",
  url: "git+https://github.com/ztffn/Path-Creator.git",
  directory: "Packages/path-creator",
};

const original = readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(original);
pkg.name = PUBLISH_NAME;
pkg.publishConfig = { registry: REGISTRY, access: "public" };
pkg.repository = REPOSITORY;

try {
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  const args = ["publish", "--registry", REGISTRY, "--access", "public"];
  if (process.env.NPM_OTP) args.push(`--otp=${process.env.NPM_OTP}`);
  execFileSync("npm", args, {
    cwd: pkgDir,
    stdio: "inherit",
  });
  console.log(`Published ${PUBLISH_NAME}@${pkg.version} to ${REGISTRY}`);
} finally {
  writeFileSync(pkgPath, original);
}

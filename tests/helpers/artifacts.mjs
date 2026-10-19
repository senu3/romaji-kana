import { mkdir, mkdtemp } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
export const testResultsRoot = resolve(projectRoot, "test-results");

// Explicit output paths are project-relative, matching the evaluation CLI.
export function resolveArtifactPath(path) {
  const output = resolve(projectRoot, path);
  const subpath = relative(testResultsRoot, output);
  if (!subpath || isAbsolute(subpath) || subpath === ".." || subpath.startsWith(`..${sep}`)) {
    throw new Error("Artifact output must be a path inside test-results/");
  }
  return output;
}

export function artifactPath(path) {
  return resolveArtifactPath(resolve(testResultsRoot, path));
}

export async function temporaryArtifactDirectory(prefix) {
  const parent = artifactPath("tmp");
  await mkdir(parent, { recursive: true });
  return mkdtemp(resolve(parent, prefix));
}

export async function screenshotPath(path) {
  const output = resolveArtifactPath(path);
  await mkdir(dirname(output), { recursive: true });
  return output;
}

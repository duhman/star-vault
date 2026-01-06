/**
 * Fetch README and package.json content from GitHub repositories
 */

import { getGitHubClient } from "./client.js";

const RAW_CONTENT_BASE = "https://raw.githubusercontent.com";

/**
 * Fetch README content for a repository
 * Tries common README filenames in order
 */
export async function fetchReadme(
  owner: string,
  name: string,
  defaultBranch: string,
): Promise<string | null> {
  const readmeNames = [
    "README.md",
    "readme.md",
    "Readme.md",
    "README.MD",
    "README",
    "readme",
    "README.rst",
    "readme.rst",
    "README.txt",
    "readme.txt",
  ];

  for (const filename of readmeNames) {
    try {
      const url = `${RAW_CONTENT_BASE}/${owner}/${name}/${defaultBranch}/${filename}`;
      const response = await fetch(url);

      if (response.ok) {
        const content = await response.text();
        // Return first 50KB to avoid huge READMEs
        return content.slice(0, 50000);
      }
    } catch {
      // Try next filename
    }
  }

  return null;
}

/**
 * Fetch package.json for JS/TS repositories
 */
export async function fetchPackageJson(
  owner: string,
  name: string,
  defaultBranch: string,
): Promise<Record<string, unknown> | null> {
  try {
    const url = `${RAW_CONTENT_BASE}/${owner}/${name}/${defaultBranch}/package.json`;
    const response = await fetch(url);

    if (response.ok) {
      const content = await response.json();
      return content as Record<string, unknown>;
    }
  } catch {
    // No package.json or invalid JSON
  }

  return null;
}

/**
 * Fetch both README and package.json for a repository
 */
export async function fetchRepoContent(
  owner: string,
  name: string,
  defaultBranch: string,
): Promise<{
  readme: string | null;
  packageJson: Record<string, unknown> | null;
}> {
  // Fetch in parallel
  const [readme, packageJson] = await Promise.all([
    fetchReadme(owner, name, defaultBranch),
    fetchPackageJson(owner, name, defaultBranch),
  ]);

  return { readme, packageJson };
}

/**
 * Extract dependency list from package.json
 */
export function extractDependencies(
  packageJson: Record<string, unknown> | null,
): string[] {
  if (!packageJson) return [];

  const deps: string[] = [];

  const dependencies = packageJson.dependencies as
    | Record<string, string>
    | undefined;
  const devDependencies = packageJson.devDependencies as
    | Record<string, string>
    | undefined;

  if (dependencies) {
    deps.push(...Object.keys(dependencies));
  }
  if (devDependencies) {
    deps.push(...Object.keys(devDependencies));
  }

  return deps;
}

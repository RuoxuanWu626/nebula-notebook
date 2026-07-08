/**
 * Kernelspec Discovery
 *
 * Discovers Jupyter kernelspecs from standard locations.
 * Similar to jupyter_client.kernelspec.find_kernel_specs()
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as childProcess from 'child_process';
import { KernelSpec } from './types';

// Re-export KernelSpec for convenience
export type { KernelSpec } from './types';

// In-memory cache for kernelspecs (avoids repeated disk I/O)
let kernelspecCache: KernelSpec[] | null = null;
let kernelspecCacheTime: number = 0;
const KERNELSPEC_CACHE_TTL_MS = 60 * 1000; // 60 seconds

/**
 * Standard kernelspec search paths
 */
export function getKernelSearchPaths(): string[] {
  const paths: string[] = [];
  const home = os.homedir();

  // User-local paths
  if (process.platform === 'darwin') {
    paths.push(path.join(home, 'Library', 'Jupyter', 'kernels'));
  } else if (process.platform === 'win32') {
    paths.push(path.join(home, 'AppData', 'Roaming', 'jupyter', 'kernels'));
  } else {
    paths.push(path.join(home, '.local', 'share', 'jupyter', 'kernels'));
  }

  paths.push(path.join(home, 'kernels', 'share', 'jupyter', 'kernels'));

  // System paths
  if (process.platform !== 'win32') {
    paths.push('/usr/local/share/jupyter/kernels');
    paths.push('/usr/share/jupyter/kernels');
  }

  // Conda paths
  const condaPrefix = process.env.CONDA_PREFIX;
  if (condaPrefix) {
    paths.push(path.join(condaPrefix, 'share', 'jupyter', 'kernels'));

    const envsDir = path.basename(path.dirname(condaPrefix)) === 'envs'
      ? path.dirname(condaPrefix)
      : null;
    const condaBase = envsDir ? path.dirname(envsDir) : condaPrefix;
    paths.push(path.join(condaBase, 'share', 'jupyter', 'kernels'));

    if (envsDir && fs.existsSync(envsDir)) {
      try {
        for (const envName of fs.readdirSync(envsDir)) {
          paths.push(path.join(envsDir, envName, 'share', 'jupyter', 'kernels'));
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  // JUPYTER_PATH environment variable
  const jupyterPath = process.env.JUPYTER_PATH;
  if (jupyterPath) {
    for (const p of jupyterPath.split(path.delimiter)) {
      if (p) {
        if (path.basename(p) === 'kernels') {
          paths.push(p);
        }
        paths.push(path.join(p, 'kernels'));
      }
    }
  }

  // Homebrew Python paths (macOS)
  if (process.platform === 'darwin') {
    const brewPaths = [
      '/opt/homebrew/share/jupyter/kernels',
      '/usr/local/opt/python/Frameworks/Python.framework/Versions/Current/share/jupyter/kernels',
    ];
    paths.push(...brewPaths);
  }

  // pyenv paths
  const pyenvRoot = process.env.PYENV_ROOT || path.join(home, '.pyenv');
  if (fs.existsSync(pyenvRoot)) {
    const versionsDir = path.join(pyenvRoot, 'versions');
    if (fs.existsSync(versionsDir)) {
      try {
        const versions = fs.readdirSync(versionsDir);
        for (const version of versions) {
          const kernelPath = path.join(versionsDir, version, 'share', 'jupyter', 'kernels');
          paths.push(kernelPath);
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  return paths;
}

/**
 * Read a kernel.json file and return the kernelspec
 */
function readKernelSpec(kernelDir: string): KernelSpec | null {
  const kernelJsonPath = path.join(kernelDir, 'kernel.json');

  if (!fs.existsSync(kernelJsonPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(kernelJsonPath, 'utf-8');
    const spec = JSON.parse(content);

    return {
      name: path.basename(kernelDir),
      displayName: spec.display_name || path.basename(kernelDir),
      language: spec.language || 'python',
      path: kernelDir,
      argv: spec.argv,
      env: spec.env,
    };
  } catch (err) {
    console.error(`Error reading kernelspec from ${kernelDir}:`, err);
    return null;
  }
}

function addKernelSpec(specs: KernelSpec[], seenNames: Set<string>, spec: KernelSpec | null): void {
  if (!spec || seenNames.has(spec.name)) {
    return;
  }

  specs.push(spec);
  seenNames.add(spec.name);
}

interface JupyterKernelListJson {
  kernelspecs?: Record<string, {
    resource_dir?: string;
    spec?: {
      display_name?: string;
      language?: string;
      argv?: string[];
      env?: Record<string, string>;
    };
  }>;
}

function readJupyterKernelListJson(output: string): KernelSpec[] {
  const parsed = JSON.parse(output) as JupyterKernelListJson;
  const kernelspecs = parsed.kernelspecs || {};

  return Object.entries(kernelspecs)
    .map(([name, entry]) => {
      const resourceDir = entry.resource_dir;
      if (!resourceDir) {
        return null;
      }

      const fromDisk = readKernelSpec(resourceDir);
      if (fromDisk) {
        return fromDisk;
      }

      return {
        name,
        displayName: entry.spec?.display_name || name,
        language: entry.spec?.language || 'python',
        path: resourceDir,
        argv: entry.spec?.argv,
        env: entry.spec?.env,
      };
    })
    .filter((spec): spec is KernelSpec => spec !== null);
}

function readJupyterKernelListText(output: string): KernelSpec[] {
  const specs: KernelSpec[] = [];

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\S+)\s+(.+)$/);
    if (!match || match[1].toLowerCase() === 'available') {
      continue;
    }

    const spec = readKernelSpec(match[2].trim());
    if (spec) {
      specs.push(spec);
    }
  }

  return specs;
}

/**
 * Ask the active Jupyter installation for its kernelspec list.
 *
 * This catches kernels from Jupyter's own path resolution that are easy to miss
 * by manually scanning common directories, especially on clusters and conda
 * installs where kernels live outside the active Node environment.
 */
function discoverJupyterCommandKernelSpecs(): KernelSpec[] {
  try {
    const output = childProcess.execFileSync('jupyter', ['kernelspec', 'list', '--json'], {
      encoding: 'utf-8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return readJupyterKernelListJson(output);
  } catch {
    // Fall back to the human-readable command requested by users/admins.
  }

  try {
    const output = childProcess.execFileSync('jupyter', ['kernelspec', 'list'], {
      encoding: 'utf-8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return readJupyterKernelListText(output);
  } catch {
    return [];
  }
}

/**
 * Perform actual kernelspec discovery (disk I/O)
 */
function performKernelspecDiscovery(): KernelSpec[] {
  const specs: KernelSpec[] = [];
  const seenNames = new Set<string>();

  const searchPaths = getKernelSearchPaths();

  for (const searchPath of searchPaths) {
    if (!fs.existsSync(searchPath)) {
      continue;
    }

    try {
      const entries = fs.readdirSync(searchPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const kernelName = entry.name;
        if (seenNames.has(kernelName)) {
          continue;
        }

        const kernelDir = path.join(searchPath, kernelName);
        const spec = readKernelSpec(kernelDir);
        addKernelSpec(specs, seenNames, spec);
      }
    } catch (err) {
      // Ignore errors reading directories
    }
  }

  for (const spec of discoverJupyterCommandKernelSpecs()) {
    addKernelSpec(specs, seenNames, spec);
  }

  return specs;
}

/**
 * Discover all available kernelspecs on the system
 * Uses 60-second in-memory cache to avoid repeated disk I/O
 */
export function discoverKernelSpecs(forceRefresh = false): KernelSpec[] {
  const now = Date.now();

  // Return from cache if valid
  if (!forceRefresh && kernelspecCache && (now - kernelspecCacheTime) < KERNELSPEC_CACHE_TTL_MS) {
    return kernelspecCache;
  }

  // Perform discovery and update cache
  kernelspecCache = performKernelspecDiscovery();
  kernelspecCacheTime = now;

  return kernelspecCache;
}

/**
 * Invalidate the kernelspec cache (call after installing a new kernel)
 */
export function invalidateKernelspecCache(): void {
  kernelspecCache = null;
  kernelspecCacheTime = 0;
}

/**
 * Get a specific kernelspec by name
 */
export function getKernelSpec(name: string): KernelSpec | null {
  const specs = discoverKernelSpecs();
  return specs.find(s => s.name === name) || null;
}

/**
 * Check if a kernelspec exists
 */
export function hasKernelSpec(name: string): boolean {
  return getKernelSpec(name) !== null;
}

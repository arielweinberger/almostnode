/**
 * npm Package Manager
 * Orchestrates package installation into the virtual file system
 */

import { VirtualFS } from '../virtual-fs';
import { Registry, RegistryOptions } from './registry';
import type { PackageManifest } from './registry';
import {
  resolveDependencies,
  resolveFromPackageJson,
  ResolvedPackage,
  ResolveOptions,
} from './resolver';
import { downloadAndExtract, extractTarball } from './tarball';
import * as path from '../shims/path';
import { initTransformer, transformPackage, isTransformerReady } from '../transform';

/**
 * Normalize a package.json bin field into a consistent Record<string, string>.
 * Handles both string form ("bin": "cli.js") and object form ("bin": {"cmd": "cli.js"}).
 */
function normalizeBin(pkgName: string, bin?: Record<string, string> | string): Record<string, string> {
  if (!bin) return {};
  if (typeof bin === 'string') {
    // String form uses the package name (without scope) as the command name
    const cmdName = pkgName.includes('/') ? pkgName.split('/').pop()! : pkgName;
    return { [cmdName]: bin };
  }
  return bin;
}

interface CachedPackageFile {
  relativePath: string;
  content: Uint8Array;
}

interface CachedPackage {
  files: CachedPackageFile[];
  byteLength: number;
}

const PACKAGE_CACHE_VERSION = 1;
const MAX_SHARED_PACKAGE_CACHE_BYTES = 256 * 1024 * 1024;
const PERSISTENT_PACKAGE_CACHE_DB = 'almostnode-package-cache';
const PERSISTENT_PACKAGE_CACHE_STORE = 'packages';
const PERSISTENT_PACKAGE_CACHE_VERSION = 1;

const sharedRegistryCache = new Map<string, PackageManifest>();
const sharedPackageCache = new Map<string, CachedPackage>();
let sharedPackageCacheBytes = 0;

function packageCacheKey(pkg: ResolvedPackage, transform: boolean): string {
  return [
    PACKAGE_CACHE_VERSION,
    pkg.name,
    pkg.version,
    pkg.tarballUrl,
    transform ? 'transform' : 'raw',
  ].join('|');
}

function readCachedPackage(cacheKey: string): CachedPackage | null {
  const cached = sharedPackageCache.get(cacheKey);
  if (!cached) return null;

  sharedPackageCache.delete(cacheKey);
  sharedPackageCache.set(cacheKey, cached);
  return cached;
}

function writeCachedPackage(cacheKey: string, cached: CachedPackage): void {
  if (cached.byteLength > MAX_SHARED_PACKAGE_CACHE_BYTES) return;

  const existing = sharedPackageCache.get(cacheKey);
  if (existing) {
    sharedPackageCacheBytes -= existing.byteLength;
    sharedPackageCache.delete(cacheKey);
  }

  sharedPackageCache.set(cacheKey, cached);
  sharedPackageCacheBytes += cached.byteLength;

  while (sharedPackageCacheBytes > MAX_SHARED_PACKAGE_CACHE_BYTES) {
    const oldestKey = sharedPackageCache.keys().next().value;
    if (!oldestKey) break;

    const oldest = sharedPackageCache.get(oldestKey);
    if (oldest) sharedPackageCacheBytes -= oldest.byteLength;
    sharedPackageCache.delete(oldestKey);
  }
}

function hasPersistentPackageCache(): boolean {
  return typeof indexedDB !== 'undefined';
}

function isCachedPackage(value: unknown): value is CachedPackage {
  if (typeof value !== 'object' || value === null) return false;
  if (!('files' in value) || !('byteLength' in value)) return false;

  const candidate = value;
  return Array.isArray(candidate.files) && typeof candidate.byteLength === 'number';
}

function openPersistentPackageCache(): Promise<IDBDatabase | null> {
  if (!hasPersistentPackageCache()) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      PERSISTENT_PACKAGE_CACHE_DB,
      PERSISTENT_PACKAGE_CACHE_VERSION
    );

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PERSISTENT_PACKAGE_CACHE_STORE)) {
        database.createObjectStore(PERSISTENT_PACKAGE_CACHE_STORE);
      }
    };
    request.onerror = () => reject(request.error ?? new Error('Failed to open package cache'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function readPersistentCachedPackage(cacheKey: string): Promise<CachedPackage | null> {
  const database = await openPersistentPackageCache();
  if (!database) return null;

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PERSISTENT_PACKAGE_CACHE_STORE, 'readonly');
    const store = transaction.objectStore(PERSISTENT_PACKAGE_CACHE_STORE);
    const request = store.get(cacheKey);

    request.onerror = () => reject(request.error ?? new Error('Failed to read package cache'));
    request.onsuccess = () => {
      const cached: unknown = request.result;
      resolve(isCachedPackage(cached) ? cached : null);
    };
    transaction.oncomplete = () => database.close();
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error('Package cache read aborted'));
    };
  });
}

async function writePersistentCachedPackage(cacheKey: string, cached: CachedPackage): Promise<void> {
  if (cached.byteLength > MAX_SHARED_PACKAGE_CACHE_BYTES) return;

  const database = await openPersistentPackageCache();
  if (!database) return;

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PERSISTENT_PACKAGE_CACHE_STORE, 'readwrite');
    const store = transaction.objectStore(PERSISTENT_PACKAGE_CACHE_STORE);
    const request = store.put(cached, cacheKey);

    request.onerror = () => reject(request.error ?? new Error('Failed to write package cache'));
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error('Package cache write aborted'));
    };
  });
}

function snapshotPackageFiles(vfs: VirtualFS, packagePath: string): CachedPackage {
  const files: CachedPackageFile[] = [];
  let byteLength = 0;

  const visit = (absolutePath: string, relativeBase: string) => {
    for (const entry of vfs.readdirSync(absolutePath)) {
      const childPath = path.join(absolutePath, entry);
      const relativePath = relativeBase ? path.join(relativeBase, entry) : entry;
      const stats = vfs.statSync(childPath);

      if (stats.isDirectory()) {
        visit(childPath, relativePath);
        continue;
      }

      if (!stats.isFile()) continue;

      const content = vfs.readFileSync(childPath);
      const snapshot = new Uint8Array(content);
      byteLength += snapshot.byteLength;
      files.push({ relativePath, content: snapshot });
    }
  };

  visit(packagePath, '');

  return { files, byteLength };
}

function restoreCachedPackage(
  vfs: VirtualFS,
  packagePath: string,
  cached: CachedPackage
): void {
  for (const file of cached.files) {
    vfs.writeFileSync(path.join(packagePath, file.relativePath), new Uint8Array(file.content));
  }
}

export interface InstallOptions {
  registry?: string;
  save?: boolean;
  saveDev?: boolean;
  includeDev?: boolean;
  includeOptional?: boolean;
  onProgress?: (message: string) => void;
  /** Transform ESM packages to CJS after install (default: true) */
  transform?: boolean;
}

export interface InstallResult {
  installed: Map<string, ResolvedPackage>;
  added: string[];
}

/**
 * npm Package Manager for VirtualFS
 */
export class PackageManager {
  private vfs: VirtualFS;
  private registry: Registry;
  private cwd: string;

  constructor(vfs: VirtualFS, options: { cwd?: string } & RegistryOptions = {}) {
    this.vfs = vfs;
    this.registry = new Registry({
      ...options,
      cache: options.cache ?? sharedRegistryCache,
    });
    this.cwd = options.cwd || '/';
  }

  /**
   * Install a package and its dependencies
   */
  async install(
    packageSpec: string,
    options: InstallOptions = {}
  ): Promise<InstallResult> {
    const { onProgress } = options;

    // Parse package spec (name@version)
    const { name, version } = parsePackageSpec(packageSpec);

    onProgress?.(`Resolving ${name}@${version || 'latest'}...`);

    // Resolve dependencies
    const resolved = await resolveDependencies(name, version || 'latest', {
      registry: this.registry,
      includeDev: options.includeDev,
      includeOptional: options.includeOptional,
      onProgress,
    });

    // Install all resolved packages
    const added = await this.installResolved(resolved, options);

    // Update package.json if save option is set
    if (options.save || options.saveDev) {
      const pkgToAdd = resolved.get(name);
      if (pkgToAdd) {
        await this.updatePackageJson(
          name,
          `^${pkgToAdd.version}`,
          options.saveDev || false
        );
      }
    }

    onProgress?.(`Installed ${resolved.size} packages`);

    return { installed: resolved, added };
  }

  /**
   * Install all dependencies from package.json
   */
  async installFromPackageJson(options: InstallOptions = {}): Promise<InstallResult> {
    const { onProgress } = options;

    const pkgJsonPath = path.join(this.cwd, 'package.json');

    if (!this.vfs.existsSync(pkgJsonPath)) {
      throw new Error('No package.json found');
    }

    const pkgJson = JSON.parse(this.vfs.readFileSync(pkgJsonPath, 'utf8'));

    onProgress?.('Resolving dependencies...');

    // Resolve all dependencies
    const resolved = await resolveFromPackageJson(pkgJson, {
      registry: this.registry,
      includeDev: options.includeDev,
      includeOptional: options.includeOptional,
      onProgress,
    });

    // Install all resolved packages
    const added = await this.installResolved(resolved, options);

    onProgress?.(`Installed ${resolved.size} packages`);

    return { installed: resolved, added };
  }

  /**
   * Install resolved packages to node_modules
   */
  private async installResolved(
    resolved: Map<string, ResolvedPackage>,
    options: InstallOptions
  ): Promise<string[]> {
    const { onProgress } = options;
    const added: string[] = [];

    // Ensure node_modules exists
    const nodeModulesPath = path.join(this.cwd, 'node_modules');
    this.vfs.mkdirSync(nodeModulesPath, { recursive: true });

    // Filter packages that need to be installed
    const toInstall: Array<{ name: string; pkg: ResolvedPackage; pkgPath: string }> = [];

    for (const [name, pkg] of resolved) {
      const pkgPath = path.join(nodeModulesPath, name);

      // Skip if already installed with same version
      const existingPkgJson = path.join(pkgPath, 'package.json');
      if (this.vfs.existsSync(existingPkgJson)) {
        try {
          const existing = JSON.parse(
            this.vfs.readFileSync(existingPkgJson, 'utf8')
          );
          if (existing.version === pkg.version) {
            onProgress?.(`Skipping ${name}@${pkg.version} (already installed)`);
            continue;
          }
        } catch {
          // Continue with installation if package.json is invalid
        }
      }

      toInstall.push({ name, pkg, pkgPath });
    }

    // Initialize transformer if transform option is enabled (default: true)
    const shouldTransform = options.transform !== false;
    if (shouldTransform && !isTransformerReady()) {
      onProgress?.('Initializing ESM transformer...');
      await initTransformer();
    }

    // Install packages in parallel (limit concurrency to avoid overwhelming the browser)
    const CONCURRENCY = 6;
    onProgress?.(`Installing ${toInstall.length} packages...`);

    for (let i = 0; i < toInstall.length; i += CONCURRENCY) {
      const batch = toInstall.slice(i, i + CONCURRENCY);

      await Promise.all(
        batch.map(async ({ name, pkg, pkgPath }) => {
          await this.installPackage({
            name,
            pkg,
            pkgPath,
            nodeModulesPath,
            shouldTransform,
            onProgress,
          });

          added.push(name);
        })
      );
    }

    // Create .package-lock.json for tracking
    await this.writeLockfile(resolved);

    return added;
  }

  private async installPackage({
    name,
    pkg,
    pkgPath,
    nodeModulesPath,
    shouldTransform,
    onProgress,
  }: {
    name: string;
    pkg: ResolvedPackage;
    pkgPath: string;
    nodeModulesPath: string;
    shouldTransform: boolean;
    onProgress?: (message: string) => void;
  }): Promise<void> {
    const cacheKey = packageCacheKey(pkg, shouldTransform);
    const cached = readCachedPackage(cacheKey);

    if (cached) {
      onProgress?.(`  Restoring ${name}@${pkg.version} from shared cache...`);
      restoreCachedPackage(this.vfs, pkgPath, cached);
      this.createBinStubs(name, pkgPath, nodeModulesPath);
      return;
    }

    const persistentCached = await readPersistentCachedPackage(cacheKey).catch(() => null);
    if (persistentCached) {
      onProgress?.(`  Restoring ${name}@${pkg.version} from persistent cache...`);
      writeCachedPackage(cacheKey, persistentCached);
      restoreCachedPackage(this.vfs, pkgPath, persistentCached);
      this.createBinStubs(name, pkgPath, nodeModulesPath);
      return;
    }

    onProgress?.(`  Downloading ${name}@${pkg.version}...`);

    // Download and extract tarball
    await downloadAndExtract(pkg.tarballUrl, this.vfs, pkgPath, {
      stripComponents: 1, // Strip "package/" prefix
    });

    // Transform ESM to CJS
    if (shouldTransform) {
      try {
        const count = await transformPackage(this.vfs, pkgPath, onProgress);
        if (count > 0) {
          onProgress?.(`  Transformed ${count} files in ${name}`);
        }
      } catch (transformError) {
        onProgress?.(`  Warning: Transform failed for ${name}: ${transformError}`);
      }
    }

    const packageSnapshot = snapshotPackageFiles(this.vfs, pkgPath);
    writeCachedPackage(cacheKey, packageSnapshot);
    await writePersistentCachedPackage(cacheKey, packageSnapshot).catch(() => undefined);
    this.createBinStubs(name, pkgPath, nodeModulesPath);
  }

  private createBinStubs(name: string, pkgPath: string, nodeModulesPath: string): void {
    try {
      const pkgJsonPath = path.join(pkgPath, 'package.json');
      if (!this.vfs.existsSync(pkgJsonPath)) return;

      const pkgJson = JSON.parse(this.vfs.readFileSync(pkgJsonPath, 'utf8'));
      const binEntries = normalizeBin(name, pkgJson.bin);
      const binDir = path.join(nodeModulesPath, '.bin');

      for (const [cmdName, entryPath] of Object.entries(binEntries)) {
        this.vfs.mkdirSync(binDir, { recursive: true });
        const targetPath = path.join(pkgPath, entryPath);
        this.vfs.writeFileSync(path.join(binDir, cmdName), `node "${targetPath}" "$@"\n`);
      }
    } catch {
      // Non-critical — skip if bin stub creation fails
    }
  }

  /**
   * Write lockfile with resolved versions
   */
  private async writeLockfile(
    resolved: Map<string, ResolvedPackage>
  ): Promise<void> {
    const lockfile: Record<string, { version: string; resolved: string }> = {};

    for (const [name, pkg] of resolved) {
      lockfile[name] = {
        version: pkg.version,
        resolved: pkg.tarballUrl,
      };
    }

    const lockfilePath = path.join(this.cwd, 'node_modules', '.package-lock.json');
    this.vfs.writeFileSync(lockfilePath, JSON.stringify(lockfile, null, 2));
  }

  /**
   * Update package.json with new dependency
   */
  private async updatePackageJson(
    packageName: string,
    version: string,
    isDev: boolean
  ): Promise<void> {
    const pkgJsonPath = path.join(this.cwd, 'package.json');

    let pkgJson: Record<string, unknown> = {};

    if (this.vfs.existsSync(pkgJsonPath)) {
      pkgJson = JSON.parse(this.vfs.readFileSync(pkgJsonPath, 'utf8'));
    }

    const field = isDev ? 'devDependencies' : 'dependencies';

    if (!pkgJson[field]) {
      pkgJson[field] = {};
    }

    (pkgJson[field] as Record<string, string>)[packageName] = version;

    this.vfs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2));
  }

  /**
   * List installed packages
   */
  list(): Record<string, string> {
    const nodeModulesPath = path.join(this.cwd, 'node_modules');

    if (!this.vfs.existsSync(nodeModulesPath)) {
      return {};
    }

    const packages: Record<string, string> = {};
    const entries = this.vfs.readdirSync(nodeModulesPath);

    for (const entry of entries) {
      // Skip hidden files and non-package entries
      if (entry.startsWith('.')) continue;

      // Handle scoped packages (@org/pkg)
      if (entry.startsWith('@')) {
        const scopePath = path.join(nodeModulesPath, entry);
        const scopedPkgs = this.vfs.readdirSync(scopePath);

        for (const scopedPkg of scopedPkgs) {
          const pkgJsonPath = path.join(scopePath, scopedPkg, 'package.json');
          if (this.vfs.existsSync(pkgJsonPath)) {
            const pkgJson = JSON.parse(this.vfs.readFileSync(pkgJsonPath, 'utf8'));
            packages[`${entry}/${scopedPkg}`] = pkgJson.version;
          }
        }
      } else {
        const pkgJsonPath = path.join(nodeModulesPath, entry, 'package.json');
        if (this.vfs.existsSync(pkgJsonPath)) {
          const pkgJson = JSON.parse(this.vfs.readFileSync(pkgJsonPath, 'utf8'));
          packages[entry] = pkgJson.version;
        }
      }
    }

    return packages;
  }
}

/**
 * Parse a package specifier into name and version
 * Examples: "express", "express@4.18.2", "@types/node@18"
 */
function parsePackageSpec(spec: string): { name: string; version?: string } {
  // Handle scoped packages
  if (spec.startsWith('@')) {
    const slashIndex = spec.indexOf('/');
    if (slashIndex === -1) {
      throw new Error(`Invalid package spec: ${spec}`);
    }

    const afterSlash = spec.slice(slashIndex + 1);
    const atIndex = afterSlash.indexOf('@');

    if (atIndex === -1) {
      return { name: spec };
    }

    return {
      name: spec.slice(0, slashIndex + 1 + atIndex),
      version: afterSlash.slice(atIndex + 1),
    };
  }

  // Regular packages
  const atIndex = spec.indexOf('@');
  if (atIndex === -1) {
    return { name: spec };
  }

  return {
    name: spec.slice(0, atIndex),
    version: spec.slice(atIndex + 1),
  };
}

// Convenience function for quick installs
export async function install(
  packageSpec: string,
  vfs: VirtualFS,
  options?: InstallOptions
): Promise<InstallResult> {
  const pm = new PackageManager(vfs);
  return pm.install(packageSpec, options);
}

// Re-export types and modules
export { Registry } from './registry';
export type { RegistryOptions, PackageVersion, PackageManifest } from './registry';
export type { ResolvedPackage, ResolveOptions } from './resolver';
export type { ExtractOptions } from './tarball';
export { parsePackageSpec };

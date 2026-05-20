import { VirtualFS } from '../virtual-fs';
import { simpleHash } from '../utils/hash';
import { createFsShim } from '../shims/fs';
import { createBuiltinModules } from './next-api-handler';
import { createVfsRequire, VfsModule } from './vfs-require';

type ViteUserConfig = {
  plugins?: VitePluginInput;
  root?: string;
  [key: string]: unknown;
};

type VitePluginInput = VitePlugin | VitePluginInput[] | false | null | undefined;

type Hook<T extends (...args: any[]) => any> = T | { handler: T };

type VitePlugin = {
  name?: string;
  enforce?: 'pre' | 'post';
  config?: Hook<(config: ViteUserConfig, env: ViteConfigEnv) => ViteUserConfig | null | void | Promise<ViteUserConfig | null | void>>;
  configResolved?: Hook<(config: ViteResolvedConfig) => void | Promise<void>>;
  transform?: Hook<(code: string, id: string) => TransformResult | string | null | undefined | Promise<TransformResult | string | null | undefined>>;
  [key: string]: unknown;
};

type TransformResult = {
  code?: string;
  map?: unknown;
};

type ViteConfigEnv = {
  command: 'serve';
  mode: string;
  isSsrBuild: boolean;
  isPreview: boolean;
};

type ViteResolvedConfig = ViteUserConfig & {
  root: string;
  command: 'serve';
  mode: string;
  env: Record<string, string>;
  build: { ssr: boolean };
  css: { devSourcemap: boolean };
  resolve: Record<string, unknown>;
  createResolver: (options?: Record<string, unknown>) => (id: string, importer?: string) => Promise<string | null>;
  plugins: VitePlugin[];
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};

const CONFIG_NAMES = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'];

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function join(root: string, name: string): string {
  return root === '/' ? `/${name}` : `${root}/${name}`;
}

function interopDefault(value: unknown): unknown {
  if (value && typeof value === 'object' && 'default' in value) {
    return (value as { default: unknown }).default;
  }
  return value;
}

function getHook<T extends (...args: any[]) => any>(hook: Hook<T> | undefined): T | undefined {
  if (!hook) return undefined;
  return typeof hook === 'function' ? hook : hook.handler;
}

function flattenPlugins(input: VitePluginInput): VitePlugin[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.flatMap(flattenPlugins);
  }
  return [input];
}

function transformViteConfigToCjs(code: string): string {
  let transformed = code;

  transformed = transformed.replace(
    /import\s+([\w$]+)\s*,\s*\{([^}]+)\}\s+from\s+(['"])([^'"]+)\3\s*;?/g,
    (_match, defaultName: string, named: string, _quote: string, source: string) =>
      `const ${defaultName} = __viteConfigDefault(require(${JSON.stringify(source)}));\nconst {${named}} = require(${JSON.stringify(source)});`
  );

  transformed = transformed.replace(
    /import\s+([\w$]+)\s+from\s+(['"])([^'"]+)\2\s*;?/g,
    (_match, localName: string, _quote: string, source: string) =>
      `const ${localName} = __viteConfigDefault(require(${JSON.stringify(source)}));`
  );

  transformed = transformed.replace(
    /import\s+\*\s+as\s+([\w$]+)\s+from\s+(['"])([^'"]+)\2\s*;?/g,
    (_match, localName: string, _quote: string, source: string) =>
      `const ${localName} = require(${JSON.stringify(source)});`
  );

  transformed = transformed.replace(
    /import\s+\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2\s*;?/g,
    (_match, named: string, _quote: string, source: string) =>
      `const {${named}} = require(${JSON.stringify(source)});`
  );

  transformed = transformed.replace(
    /import\s+(['"])([^'"]+)\1\s*;?/g,
    (_match, _quote: string, source: string) => `require(${JSON.stringify(source)});`
  );

  return transformed.replace(/export\s+default\s+/g, 'module.exports = ');
}

function normalizeConfig(value: unknown): ViteUserConfig {
  if (!value) return {};
  return typeof value === 'object' ? value as ViteUserConfig : {};
}

async function maybeAwait<T>(value: T | Promise<T>): Promise<T> {
  return value instanceof Promise ? await value : value;
}

export class VitePluginContainer {
  private vfs: VirtualFS;
  private root: string;
  private moduleCache: Record<string, VfsModule> = {};
  private loaded:
    | { key: string; configPath: string | null; resolvedConfig: ViteResolvedConfig; plugins: VitePlugin[] }
    | null = null;

  constructor(vfs: VirtualFS, root: string) {
    this.vfs = vfs;
    this.root = root;
  }

  invalidate(): void {
    this.loaded = null;
  }

  getConfigPath(): string | null {
    for (const name of CONFIG_NAMES) {
      const path = join(this.root, name);
      if (this.vfs.existsSync(path)) {
        return path;
      }
    }
    return null;
  }

  getCacheKey(): string {
    const configPath = this.getConfigPath();
    if (!configPath) return 'no-config';

    const config = this.vfs.readFileSync(configPath, 'utf8');
    const packageJsonPath = join(this.root, 'package.json');
    const packageJson = this.vfs.existsSync(packageJsonPath)
      ? this.vfs.readFileSync(packageJsonPath, 'utf8')
      : '';

    return simpleHash(`${configPath}\n${config}\n${packageJson}`);
  }

  async load(): Promise<{ configPath: string | null; resolvedConfig: ViteResolvedConfig; plugins: VitePlugin[] }> {
    const key = this.getCacheKey();
    if (this.loaded?.key === key) {
      return this.loaded;
    }

    const configPath = this.getConfigPath();
    let userConfig: ViteUserConfig = {};

    if (configPath) {
      userConfig = await this.executeConfig(configPath);
    }

    const env: ViteConfigEnv = {
      command: 'serve',
      mode: 'development',
      isSsrBuild: false,
      isPreview: false,
    };

    const initialPlugins = flattenPlugins(userConfig.plugins);
    let mergedConfig: ViteUserConfig & { plugins: VitePlugin[] } = { ...userConfig, plugins: initialPlugins };

    for (const plugin of initialPlugins) {
      const configHook = getHook(plugin.config);
      if (!configHook) continue;

      const result = await maybeAwait(configHook.call(this.createPluginContext(plugin), mergedConfig, env));
      if (result && typeof result === 'object') {
        mergedConfig = { ...mergedConfig, ...result, plugins: flattenPlugins(result.plugins ?? mergedConfig.plugins) };
      }
    }

    const plugins = flattenPlugins(mergedConfig.plugins);
    const resolvedConfig: ViteResolvedConfig = {
      ...mergedConfig,
      root: this.root,
      command: 'serve',
      mode: 'development',
      env: {},
      build: {
        ...(typeof mergedConfig.build === 'object' && mergedConfig.build !== null ? mergedConfig.build : {}),
        ssr: false,
      },
      css: {
        ...(typeof mergedConfig.css === 'object' && mergedConfig.css !== null ? mergedConfig.css : {}),
        devSourcemap: false,
      },
      resolve: typeof mergedConfig.resolve === 'object' && mergedConfig.resolve !== null
        ? mergedConfig.resolve as Record<string, unknown>
        : {},
      createResolver: () => async (id: string, importer?: string) => this.resolveViteId(id, importer),
      plugins,
      logger: {
        info: (...args: unknown[]) => console.info('[ViteDevServer]', ...args),
        warn: (...args: unknown[]) => console.warn('[ViteDevServer]', ...args),
        error: (...args: unknown[]) => console.error('[ViteDevServer]', ...args),
      },
    };

    for (const plugin of plugins) {
      const resolvedHook = getHook(plugin.configResolved);
      if (resolvedHook) {
        await maybeAwait(resolvedHook.call(this.createPluginContext(plugin), resolvedConfig));
      }
    }

    this.loaded = { key, configPath, resolvedConfig, plugins };
    return this.loaded;
  }

  async transformCss(code: string, id: string): Promise<string> {
    const { plugins } = await this.load();
    let current = code;

    for (const plugin of plugins) {
      const transformHook = getHook(plugin.transform);
      if (!transformHook) continue;

      const result = await maybeAwait(transformHook.call(this.createPluginContext(plugin), current, id));
      if (!result) continue;

      if (typeof result === 'string') {
        current = result;
      } else if (typeof result.code === 'string') {
        current = result.code;
      }
    }

    return current;
  }

  private async executeConfig(configPath: string): Promise<ViteUserConfig> {
    const builtinModules = await createBuiltinModules(() => createFsShim(this.vfs, () => this.root));
    if (builtinModules.fs && typeof builtinModules.fs === 'object' && 'promises' in builtinModules.fs) {
      builtinModules['fs/promises'] = (builtinModules.fs as { promises: unknown }).promises;
    }
    builtinModules['@tailwindcss/oxide'] = this.createOxideShim();
    builtinModules.vite = {
      defineConfig: (config: unknown) => config,
      createIdResolver: () => async (environment: unknown, id: string, importer?: string) => {
        void environment;
        return this.resolveViteId(id, importer);
      },
    };

    const process = {
      env: { NAPI_RS_FORCE_WASI: '1' },
      cwd: () => this.root,
      platform: 'browser',
      version: 'v18.0.0',
      versions: { node: '18.0.0', v8: '11.0.0', uv: '1.0.0' },
    };
    if (builtinModules.process && typeof builtinModules.process === 'object') {
      Object.assign(builtinModules.process, process);
    }

    const requireOptions = {
      builtinModules,
      process,
      moduleCache: this.moduleCache,
    };
    builtinModules.module = {
      createRequire: (filename: string) => createVfsRequire(this.vfs, dirname(filename), requireOptions).require,
    };

    const { require } = createVfsRequire(this.vfs, dirname(configPath), requireOptions);
    try {
      const wasmUtil = require('@tybys/wasm-util') as { WASI?: unknown };
      if (wasmUtil?.WASI) {
        const BaseWASI = wasmUtil.WASI as new (options: Record<string, unknown>) => object;
        const fsShim = builtinModules.fs;
        builtinModules.wasi = {
          WASI: class VfsBackedWASI extends BaseWASI {
            constructor(options: Record<string, unknown>) {
              super({ ...options, fs: options.fs ?? fsShim });
            }
          },
        };
      }
    } catch {
      // Projects without WASI-backed dependencies do not need this optional shim.
    }

    const code = transformViteConfigToCjs(this.vfs.readFileSync(configPath, 'utf8'));
    const module = { exports: {} as unknown };
    const fn = new Function(
      'exports',
      'require',
      'module',
      '__filename',
      '__dirname',
      'process',
      '__viteConfigDefault',
      code,
    );

    fn(module.exports, require, module, configPath, dirname(configPath), process, interopDefault);

    let exported = interopDefault(module.exports);
    if (typeof exported === 'function') {
      exported = await maybeAwait((exported as (env: ViteConfigEnv) => unknown)({
        command: 'serve',
        mode: 'development',
        isSsrBuild: false,
        isPreview: false,
      }));
    }

    return normalizeConfig(exported);
  }

  private createPluginContext(plugin: VitePlugin): Record<string, unknown> {
    return {
      meta: { rollupVersion: 'browser' },
      addWatchFile: () => undefined,
      getWatchFiles: () => [],
      warn: (...args: unknown[]) => console.warn(`[vite:${plugin.name || 'plugin'}]`, ...args),
      error: (error: unknown) => {
        throw error instanceof Error ? error : new Error(String(error));
      },
      emitFile: () => '',
      parse: () => null,
      resolve: async () => null,
    };
  }

  private resolveViteId(id: string, importer?: string): string | null {
    if (!id || id.startsWith('\0') || /^[a-z]+:\/\//i.test(id)) {
      return null;
    }

    const withoutQuery = id.split('?')[0];
    const baseDir = importer ? dirname(importer.split('?')[0]) : this.root;
    const candidates: string[] = [];

    if (withoutQuery.startsWith('/')) {
      candidates.push(withoutQuery);
    } else if (withoutQuery.startsWith('./') || withoutQuery.startsWith('../')) {
      candidates.push(this.normalizePath(`${baseDir}/${withoutQuery}`));
    } else {
      candidates.push(join(this.root, withoutQuery));
      candidates.push(join(this.root, `node_modules/${withoutQuery}`));
    }

    for (const candidate of candidates) {
      if (this.vfs.existsSync(candidate)) {
        return candidate;
      }
      if (this.vfs.existsSync(`${candidate}.css`)) {
        return `${candidate}.css`;
      }
      if (this.vfs.existsSync(`${candidate}/index.css`)) {
        return `${candidate}/index.css`;
      }
    }

    return null;
  }

  private normalizePath(path: string): string {
    const parts: string[] = [];
    for (const part of path.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        parts.pop();
      } else {
        parts.push(part);
      }
    }
    return `/${parts.join('/')}`;
  }

  private createOxideShim(): { Scanner: new (options: { sources?: Array<{ base?: string; pattern?: string; negated?: boolean }> }) => unknown } {
    const vfs = this.vfs;
    const normalize = (path: string) => this.normalizePath(path);

    class Scanner {
      files: string[] = [];
      globs: Array<{ base: string; pattern: string; negated?: boolean }> = [];
      private sources: Array<{ base: string; pattern: string; negated?: boolean }>;

      constructor(options: { sources?: Array<{ base?: string; pattern?: string; negated?: boolean }> } = {}) {
        this.sources = (options.sources || [])
          .filter((source) => !source.negated)
          .map((source) => ({
            base: normalize(source.base || '/'),
            pattern: source.pattern || '**/*',
            negated: source.negated,
          }));
        this.globs = this.sources;
      }

      scan(): string[] {
        const candidates = new Set<string>();
        this.files = [];

        for (const source of this.sources) {
          this.scanPath(source.base, candidates);
        }

        return [...candidates];
      }

      private scanPath(path: string, candidates: Set<string>): void {
        if (!vfs.existsSync(path)) return;

        const stats = vfs.statSync(path);
        if (stats.isDirectory()) {
          for (const entry of vfs.readdirSync(path)) {
            if (entry === 'node_modules' || entry === '.git') continue;
            this.scanPath(normalize(`${path}/${entry}`), candidates);
          }
          return;
        }

        if (!/\.(html|js|jsx|ts|tsx|vue|svelte|mdx?|css)$/.test(path)) {
          return;
        }

        this.files.push(path);
        const content = vfs.readFileSync(path, 'utf8');
        for (const match of content.matchAll(/[A-Za-z0-9_:/!.[\]()%#-]+/g)) {
          const candidate = match[0];
          if (candidate && /[A-Za-z]/.test(candidate)) {
            candidates.add(candidate);
          }
        }
      }
    }

    return { Scanner };
  }
}

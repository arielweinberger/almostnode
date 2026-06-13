import { VirtualFS } from '../virtual-fs';
import { simpleHash } from '../utils/hash';
import { createFsShim } from '../shims/fs';
import { createBuiltinModules } from './next-api-handler';
import { createVfsRequire, VfsModule } from './vfs-require';
import { createTailwindOxideShim } from './tailwind-oxide-shim';

type ViteUserConfig = {
  plugins?: VitePluginInput;
  root?: string;
  [key: string]: unknown;
};

type VitePluginInput = VitePlugin | VitePluginInput[] | false | null | undefined;

type ViteHookFunction = (...args: never[]) => unknown;

type HookPattern = string | RegExp | HookPattern[];

type HookFilterMatcher =
  | HookPattern
  | {
      include?: HookPattern;
      exclude?: HookPattern;
    };

type TransformHookFilter = {
  id?: HookFilterMatcher;
  code?: HookFilterMatcher;
};

type Hook<T extends ViteHookFunction> = T | { handler: T; filter?: TransformHookFilter };

type VitePlugin = {
  name?: string;
  apply?: 'serve' | 'build' | ((config: ViteUserConfig, env: ViteConfigEnv) => boolean);
  applyToEnvironment?: (environment: ViteEnvironment) => boolean;
  enforce?: 'pre' | 'post';
  config?: Hook<(config: ViteUserConfig, env: ViteConfigEnv) => ViteUserConfig | null | void | Promise<ViteUserConfig | null | void>>;
  configResolved?: Hook<(config: ViteResolvedConfig) => void | Promise<void>>;
  transform?: Hook<(code: string, id: string) => TransformResult | string | null | undefined | Promise<TransformResult | string | null | undefined>>;
  vite?: {
    applyToEnvironment?: (environment: ViteEnvironment) => boolean;
  };
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
  base: string;
  command: 'serve';
  mode: string;
  env: Record<string, string>;
  isProduction: boolean;
  build: { ssr: boolean };
  css: { devSourcemap: boolean };
  server: { hmr: boolean | Record<string, unknown> };
  experimental: { bundledDev: boolean };
  resolve: Record<string, unknown>;
  createResolver: (options?: Record<string, unknown>) => (id: string, importer?: string) => Promise<string | null>;
  plugins: VitePlugin[];
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};

type ViteEnvironment = {
  name: string;
  mode: 'dev' | 'build';
  config: ViteResolvedConfig;
  moduleGraph: {
    getModuleById: (id: string) => null;
    invalidateModule: () => void;
  };
  transformRequest: (id: string) => Promise<null>;
};

const CONFIG_NAMES = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'];

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function join(root: string, name: string): string {
  return root === '/' ? `/${name}` : `${root}/${name}`;
}

function pathFromFileUrlOrPath(value: string): string {
  if (!value.startsWith('file://')) return value;
  return decodeURIComponent(new URL(value).pathname);
}

function getEnvFilesForMode(mode: string, envDir: string): string[] {
  return [
    join(envDir, '.env'),
    join(envDir, '.env.local'),
    join(envDir, `.env.${mode}`),
    join(envDir, `.env.${mode}.local`),
  ];
}

function parseEnvFile(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function loadEnvFromVfs(
  vfs: VirtualFS,
  mode: string,
  envDir: string | false,
  prefixes: string | string[] = 'VITE_',
  processEnv: Record<string, string>
): Record<string, string> {
  if (envDir === false) return {};
  if (mode === 'local') {
    throw new Error('"local" cannot be used as a mode name because it conflicts with the .local postfix for .env files.');
  }

  const prefixList = Array.isArray(prefixes) ? prefixes : [prefixes];
  const parsed: Record<string, string> = {};
  for (const filePath of getEnvFilesForMode(mode, envDir)) {
    if (!vfs.existsSync(filePath)) continue;
    const stat = vfs.statSync(filePath);
    if (!stat.isFile()) continue;
    Object.assign(parsed, parseEnvFile(vfs.readFileSync(filePath, 'utf8')));
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (prefixList.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(processEnv)) {
    if (prefixList.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }
  return env;
}

function interopDefault(value: unknown): unknown {
  if (value && typeof value === 'object' && 'default' in value) {
    return (value as { default: unknown }).default;
  }
  return value;
}

function getHook<T extends ViteHookFunction>(hook: Hook<T> | undefined): T | undefined {
  if (!hook) return undefined;
  return typeof hook === 'function' ? hook : hook.handler;
}

function getHookFilter<T extends ViteHookFunction>(hook: Hook<T> | undefined): TransformHookFilter | undefined {
  if (!hook || typeof hook === 'function') return undefined;
  return hook.filter;
}

function matchesHookPattern(value: string, pattern: HookPattern | undefined): boolean {
  if (!pattern) return true;
  if (Array.isArray(pattern)) {
    return pattern.some((item) => matchesHookPattern(value, item));
  }
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0;
    return pattern.test(value);
  }
  return value === pattern || value.includes(pattern);
}

function matchesHookFilterMatcher(value: string, matcher: HookFilterMatcher | undefined): boolean {
  if (!matcher) return true;
  if (typeof matcher === 'string' || matcher instanceof RegExp || Array.isArray(matcher)) {
    return matchesHookPattern(value, matcher);
  }

  if (matcher.exclude && matchesHookPattern(value, matcher.exclude)) {
    return false;
  }
  return matcher.include ? matchesHookPattern(value, matcher.include) : true;
}

function matchesTransformHookFilter(filter: TransformHookFilter | undefined, id: string, code: string): boolean {
  if (!filter) return true;
  return matchesHookFilterMatcher(id, filter.id) && matchesHookFilterMatcher(code, filter.code);
}

function flattenPlugins(input: VitePluginInput): VitePlugin[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.flatMap(flattenPlugins);
  }
  return [input];
}

function pluginAppliesToServe(plugin: VitePlugin, config: ViteUserConfig, env: ViteConfigEnv): boolean {
  if (!plugin.apply) return true;
  if (plugin.apply === 'serve') return true;
  if (plugin.apply === 'build') return false;
  return plugin.apply(config, env);
}

function pluginAppliesToEnvironment(plugin: VitePlugin, environment: ViteEnvironment): boolean {
  if (plugin.applyToEnvironment && !plugin.applyToEnvironment(environment)) {
    return false;
  }
  if (plugin.vite?.applyToEnvironment && !plugin.vite.applyToEnvironment(environment)) {
    return false;
  }
  return true;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

    const initialPlugins = flattenPlugins(userConfig.plugins)
      .filter((plugin) => pluginAppliesToServe(plugin, userConfig, env));
    let mergedConfig: ViteUserConfig & { plugins: VitePlugin[] } = { ...userConfig, plugins: initialPlugins };

    for (const plugin of initialPlugins) {
      const configHook = getHook(plugin.config);
      if (!configHook) continue;

      const result = await maybeAwait(configHook.call(this.createPluginContext(plugin), mergedConfig, env));
      if (result && typeof result === 'object') {
        mergedConfig = { ...mergedConfig, ...result, plugins: flattenPlugins(result.plugins ?? mergedConfig.plugins) };
      }
    }

    const plugins = flattenPlugins(mergedConfig.plugins)
      .filter((plugin) => pluginAppliesToServe(plugin, mergedConfig, env));
    const mergedServer =
      typeof mergedConfig.server === 'object' && mergedConfig.server !== null
        ? mergedConfig.server as Record<string, unknown>
        : {};
    const mergedExperimental =
      typeof mergedConfig.experimental === 'object' && mergedConfig.experimental !== null
        ? mergedConfig.experimental as Record<string, unknown>
        : {};
    const hmr = mergedServer.hmr;
    const resolvedConfig: ViteResolvedConfig = {
      ...mergedConfig,
      root: this.root,
      base: typeof mergedConfig.base === 'string' ? mergedConfig.base : '/',
      command: 'serve',
      mode: 'development',
      env: {},
      isProduction: false,
      build: {
        ...(typeof mergedConfig.build === 'object' && mergedConfig.build !== null ? mergedConfig.build : {}),
        ssr: false,
      },
      css: {
        ...(typeof mergedConfig.css === 'object' && mergedConfig.css !== null ? mergedConfig.css : {}),
        devSourcemap: false,
      },
      server: {
        ...mergedServer,
        hmr:
          typeof hmr === 'boolean' || isRecord(hmr)
            ? hmr
            : true,
      },
      experimental: {
        ...mergedExperimental,
        bundledDev: false,
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

    const environment = this.createEnvironment(resolvedConfig);
    for (const plugin of plugins) {
      const resolvedHook = getHook(plugin.configResolved);
      if (resolvedHook) {
        await maybeAwait(resolvedHook.call(this.createPluginContext(plugin, environment), resolvedConfig));
      }
    }

    this.loaded = { key, configPath, resolvedConfig, plugins };
    return this.loaded;
  }

  async transformCss(code: string, id: string): Promise<string> {
    const { resolvedConfig, plugins } = await this.load();
    const environment = this.createEnvironment(resolvedConfig);
    let current = code;

    for (const plugin of plugins) {
      const transformHook = getHook(plugin.transform);
      if (!transformHook) continue;
      if (!pluginAppliesToEnvironment(plugin, environment)) continue;
      if (!matchesTransformHookFilter(getHookFilter(plugin.transform), id, current)) continue;

      const result = await maybeAwait(transformHook.call(this.createPluginContext(plugin, environment), current, id));
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
    builtinModules['@tailwindcss/oxide'] = createTailwindOxideShim(this.vfs, (path) => this.normalizePath(path));
    const process = {
      env: { NAPI_RS_FORCE_WASI: '1' },
      cwd: () => this.root,
      platform: 'browser',
      version: 'v18.0.0',
      versions: { node: '18.0.0', v8: '11.0.0', uv: '1.0.0' },
    };
    builtinModules.vite = {
      defineConfig: (config: unknown) => config,
      createIdResolver: () => async (environment: unknown, id: string, importer?: string) => {
        void environment;
        return this.resolveViteId(id, importer);
      },
      loadEnv: (mode: string, envDir: string | false, prefixes?: string | string[]) =>
        loadEnvFromVfs(this.vfs, mode, envDir, prefixes, process.env),
      normalizePath: (path: string) => path.replace(/\\/g, '/'),
      searchForWorkspaceRoot: () => this.root,
    };
    builtinModules['vite/internal'] = {
      reactRefreshWrapperPlugin: () => ({
        name: 'vite:react-refresh-wrapper:almostnode-noop',
      }),
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
      createRequire: (filename: string) =>
        createVfsRequire(this.vfs, dirname(pathFromFileUrlOrPath(filename)), requireOptions).require,
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

  private createEnvironment(config: ViteResolvedConfig): ViteEnvironment {
    return {
      name: 'client',
      mode: 'dev',
      config,
      moduleGraph: {
        getModuleById: () => null,
        invalidateModule: () => undefined,
      },
      transformRequest: async () => null,
    };
  }

  private createPluginContext(plugin: VitePlugin, environment?: ViteEnvironment): Record<string, unknown> {
    return {
      environment,
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
      if (this.isExistingFile(candidate)) {
        return candidate;
      }
      if (this.isExistingFile(`${candidate}.css`)) {
        return `${candidate}.css`;
      }
      if (this.isExistingFile(`${candidate}/index.css`)) {
        return `${candidate}/index.css`;
      }
    }

    return null;
  }

  private isExistingFile(path: string): boolean {
    if (!this.vfs.existsSync(path)) return false;

    try {
      return this.vfs.statSync(path).isFile();
    } catch {
      return false;
    }
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

}

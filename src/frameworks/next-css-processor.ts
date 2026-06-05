import { VirtualFS } from '../virtual-fs';
import { simpleHash } from '../utils/hash';
import { createFsShim } from '../shims/fs';
import { createBuiltinModules } from './next-api-handler';
import { createVfsRequire, VfsModule } from './vfs-require';
import { createTailwindOxideShim } from './tailwind-oxide-shim';

const POSTCSS_CONFIG_NAMES = [
  'postcss.config.mjs',
  'postcss.config.js',
  'postcss.config.cjs',
];

type PostCssProcessOptions = {
  from: string;
};

type PostCssResult = {
  css: string;
};

type PostCssProcessor = {
  process: (css: string, options: PostCssProcessOptions) => PostCssResult | Promise<PostCssResult>;
};

type PostCssFactory = (plugins: unknown[]) => PostCssProcessor;
type TailwindPostCssFactory = (options?: Record<string, unknown>) => unknown;

type DefaultExport = {
  default?: unknown;
};

function join(root: string, name: string): string {
  return root === '/' ? `/${name}` : `${root}/${name}`;
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function normalizePath(path: string): string {
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

function interopDefault(value: unknown): unknown {
  if (value && typeof value === 'object' && 'default' in value) {
    return (value as DefaultExport).default;
  }
  return value;
}

function isPostCssFactory(value: unknown): value is PostCssFactory {
  return typeof value === 'function';
}

function isTailwindPostCssFactory(value: unknown): value is TailwindPostCssFactory {
  return typeof value === 'function';
}

function hasTailwindImport(css: string): boolean {
  return /@import\s+["']tailwindcss["']/.test(css);
}

export class NextCssProcessor {
  private vfs: VirtualFS;
  private root: string;
  private moduleCache: Record<string, VfsModule> = {};

  constructor(vfs: VirtualFS, root: string) {
    this.vfs = vfs;
    this.root = root;
  }

  getPostCssConfigPath(): string | null {
    for (const name of POSTCSS_CONFIG_NAMES) {
      const path = join(this.root, name);
      if (this.vfs.existsSync(path)) {
        return path;
      }
    }
    return null;
  }

  hasTailwindPostCssConfig(): boolean {
    const configPath = this.getPostCssConfigPath();
    if (!configPath) return false;

    const content = this.vfs.readFileSync(configPath, 'utf8');
    return content.includes('@tailwindcss/postcss');
  }

  shouldCompileTailwindCss(css?: string): boolean {
    if (css === undefined) return this.hasTailwindPostCssConfig();
    return hasTailwindImport(css) && this.hasTailwindPostCssConfig();
  }

  getCacheKey(): string {
    const configPath = this.getPostCssConfigPath();
    if (!configPath) return 'no-postcss-config';

    const config = this.vfs.readFileSync(configPath, 'utf8');
    const packageJsonPath = join(this.root, 'package.json');
    const packageJson = this.vfs.existsSync(packageJsonPath)
      ? this.vfs.readFileSync(packageJsonPath, 'utf8')
      : '';

    return simpleHash(`${configPath}\n${config}\n${packageJson}`);
  }

  async process(css: string, filePath: string): Promise<string> {
    if (!hasTailwindImport(css)) {
      return css;
    }
    if (!this.hasTailwindPostCssConfig()) {
      throw new Error('Tailwind CSS import found, but no postcss.config.* with @tailwindcss/postcss was found.');
    }

    const builtins = await createBuiltinModules(() => createFsShim(this.vfs, () => this.root));
    builtins['@tailwindcss/oxide'] = createTailwindOxideShim(this.vfs, normalizePath);

    const processShim = {
      env: { NAPI_RS_FORCE_WASI: '1' },
      cwd: () => this.root,
      platform: 'browser',
      version: 'v18.0.0',
      versions: { node: '18.0.0', v8: '11.0.0', uv: '1.0.0' },
    };

    if (builtins.process && typeof builtins.process === 'object') {
      Object.assign(builtins.process, processShim);
    }

    const requireOptions = {
      builtinModules: builtins,
      process: processShim,
      moduleCache: this.moduleCache,
    };

    builtins.module = {
      createRequire: (filename: string) =>
        createVfsRequire(this.vfs, dirname(filename), requireOptions).require,
    };

    const { require } = createVfsRequire(this.vfs, this.root, requireOptions);
    const postcss = interopDefault(require('postcss'));
    if (!isPostCssFactory(postcss)) {
      throw new Error('postcss did not export a processor factory');
    }

    const tailwindPostcss = interopDefault(require('@tailwindcss/postcss'));
    if (!isTailwindPostCssFactory(tailwindPostcss)) {
      throw new Error('@tailwindcss/postcss did not export a plugin factory');
    }

    const processor = postcss([tailwindPostcss({})]);
    const result = await processor.process(css, { from: filePath });
    return result.css;
  }
}

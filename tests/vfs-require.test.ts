import { describe, it, expect } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { createVfsRequire } from '../src/frameworks/vfs-require';
import {
  createBuiltinModules,
  createMockRequest,
  createMockResponse,
  executeApiHandler,
} from '../src/frameworks/next-api-handler';
import { createFsShim } from '../src/shims/fs';

// ─── Helper ──────────────────────────────────────────────────────────────────

function setupVfs() {
  const vfs = new VirtualFS();
  return vfs;
}

function createRequire(vfs: VirtualFS, fromDir = '/', builtinModules: Record<string, unknown> = {}) {
  const { require, moduleCache } = createVfsRequire(vfs, fromDir, {
    builtinModules,
    process: { env: {}, cwd: () => '/', platform: 'browser' },
  });
  return { require, moduleCache };
}

// ─── Resolution ──────────────────────────────────────────────────────────────

describe('VFS require — resolution', () => {
  it('resolves bare package import from /node_modules/', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/my-pkg', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/my-pkg/package.json',
      JSON.stringify({ name: 'my-pkg', main: 'index.js' })
    );
    vfs.writeFileSync('/node_modules/my-pkg/index.js', 'module.exports = "hello";');

    const { require } = createRequire(vfs);
    expect(require('my-pkg')).toBe('hello');
  });

  it('resolves from package.json main field', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/custom-main', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/custom-main/package.json',
      JSON.stringify({ name: 'custom-main', main: 'lib/entry.js' })
    );
    vfs.mkdirSync('/node_modules/custom-main/lib', { recursive: true });
    vfs.writeFileSync('/node_modules/custom-main/lib/entry.js', 'module.exports = 42;');

    const { require } = createRequire(vfs);
    expect(require('custom-main')).toBe(42);
  });

  it('resolves from package.json exports field', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/exports-pkg', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/exports-pkg/package.json',
      JSON.stringify({
        name: 'exports-pkg',
        exports: { '.': { require: './dist/index.cjs.js' } },
      })
    );
    vfs.mkdirSync('/node_modules/exports-pkg/dist', { recursive: true });
    vfs.writeFileSync('/node_modules/exports-pkg/dist/index.cjs.js', 'module.exports = "from-exports";');

    const { require } = createRequire(vfs);
    expect(require('exports-pkg')).toBe('from-exports');
  });

  it('resolves package exports when installed under an npm alias name', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/h3-v2/dist', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/h3-v2/package.json',
      JSON.stringify({
        name: 'h3',
        exports: {
          '.': {
            import: './dist/index.mjs',
          },
        },
      })
    );
    vfs.writeFileSync('/node_modules/h3-v2/dist/index.mjs', 'module.exports = "from-h3-alias";');

    const { require } = createRequire(vfs);

    expect(require('h3-v2')).toBe('from-h3-alias');
  });

  it('resolves package imports for package-scoped hash specifiers', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/start-server-core/dist/esm', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/start-server-core/package.json',
      JSON.stringify({
        name: 'start-server-core',
        imports: {
          '#server-fn-resolver': {
            default: './dist/esm/fake-server-fn-resolver.js',
          },
        },
      })
    );
    vfs.writeFileSync(
      '/node_modules/start-server-core/dist/esm/getServerFnById.js',
      'const resolver = require("#server-fn-resolver"); module.exports = resolver.getServerFnById;',
    );
    vfs.writeFileSync(
      '/node_modules/start-server-core/dist/esm/fake-server-fn-resolver.js',
      'exports.getServerFnById = () => "fake-resolver";',
    );

    const { require } = createRequire(vfs);
    const getServerFnById = require('start-server-core/dist/esm/getServerFnById');

    expect(typeof getServerFnById).toBe('function');
    if (typeof getServerFnById !== 'function') {
      throw new Error('getServerFnById did not resolve to a function');
    }
    expect(getServerFnById()).toBe('fake-resolver');
  });

  it('resolves scoped packages (@scope/pkg)', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/@my-scope/my-lib', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/@my-scope/my-lib/package.json',
      JSON.stringify({ name: '@my-scope/my-lib', main: 'index.js' })
    );
    vfs.writeFileSync('/node_modules/@my-scope/my-lib/index.js', 'module.exports = "scoped";');

    const { require } = createRequire(vfs);
    expect(require('@my-scope/my-lib')).toBe('scoped');
  });

  it('resolves sub-path imports (pkg/sub)', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/utils/lib', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/utils/package.json',
      JSON.stringify({ name: 'utils' })
    );
    vfs.writeFileSync('/node_modules/utils/lib/helper.js', 'module.exports = "sub-path";');

    const { require } = createRequire(vfs);
    expect(require('utils/lib/helper')).toBe('sub-path');
  });

  it('resolves relative paths', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/project/lib', { recursive: true });
    vfs.writeFileSync('/project/lib/utils.js', 'module.exports = "relative";');

    const { require } = createRequire(vfs, '/project');
    expect(require('./lib/utils')).toBe('relative');
  });

  it('resolves JSON files', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/json-pkg', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/json-pkg/package.json',
      JSON.stringify({ name: 'json-pkg', main: 'data.json' })
    );
    vfs.writeFileSync('/node_modules/json-pkg/data.json', JSON.stringify({ key: 'value' }));

    const { require } = createRequire(vfs);
    expect(require('json-pkg')).toEqual({ key: 'value' });
  });

  it('throws on missing modules', () => {
    const vfs = setupVfs();
    const { require } = createRequire(vfs);
    expect(() => require('nonexistent')).toThrow("Cannot find module 'nonexistent'");
  });

  it('skips CJS stub files starting with throw', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/esm-only', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/esm-only/package.json',
      JSON.stringify({
        name: 'esm-only',
        exports: {
          '.': {
            require: './index.cjs',
            import: './index.mjs',
          },
        },
      })
    );
    vfs.writeFileSync('/node_modules/esm-only/index.cjs', 'throw new Error("CJS not supported");');
    // ESM file with import/export will get transformed
    vfs.writeFileSync('/node_modules/esm-only/index.mjs', 'module.exports = "esm-fallback";');

    const { require } = createRequire(vfs);
    expect(require('esm-only')).toBe('esm-fallback');
  });

  it('resolves directory with index.js', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/dir-pkg/lib', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/dir-pkg/package.json',
      JSON.stringify({ name: 'dir-pkg', main: './lib' })
    );
    vfs.writeFileSync('/node_modules/dir-pkg/lib/index.js', 'module.exports = "from-index";');

    const { require } = createRequire(vfs);
    expect(require('dir-pkg')).toBe('from-index');
  });

  it('resolves literal same-directory dot requires', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/dot-pkg/lib/builder', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/dot-pkg/package.json',
      JSON.stringify({ name: 'dot-pkg', main: 'lib/builder/entry.js' })
    );
    vfs.writeFileSync(
      '/node_modules/dot-pkg/lib/builder/index.js',
      'exports.createBuilder = () => "same-directory-index";',
    );
    vfs.writeFileSync(
      '/node_modules/dot-pkg/lib/builder/entry.js',
      'const builder = require("."); module.exports = builder.createBuilder();',
    );

    const { require } = createRequire(vfs);
    expect(require('dot-pkg')).toBe('same-directory-index');
  });

  it('resolves browser field over main', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/browser-pkg', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/browser-pkg/package.json',
      JSON.stringify({ name: 'browser-pkg', main: 'node.js', browser: 'browser.js' })
    );
    vfs.writeFileSync('/node_modules/browser-pkg/node.js', 'module.exports = "node";');
    vfs.writeFileSync('/node_modules/browser-pkg/browser.js', 'module.exports = "browser";');

    const { require } = createRequire(vfs);
    expect(require('browser-pkg')).toBe('browser');
  });
});

// ─── Loading ─────────────────────────────────────────────────────────────────

describe('VFS require — loading', () => {
  it('loads and executes CJS modules', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/cjs-mod', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/cjs-mod/package.json',
      JSON.stringify({ name: 'cjs-mod', main: 'index.js' })
    );
    vfs.writeFileSync(
      '/node_modules/cjs-mod/index.js',
      'var x = 1 + 2; module.exports = { sum: x, name: "cjs" };'
    );

    const { require } = createRequire(vfs);
    expect(require('cjs-mod')).toEqual({ sum: 3, name: 'cjs' });
  });

  it('caches modules (same object returned on re-require)', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/cached-mod', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/cached-mod/package.json',
      JSON.stringify({ name: 'cached-mod', main: 'index.js' })
    );
    vfs.writeFileSync('/node_modules/cached-mod/index.js', 'module.exports = { val: Math.random() };');

    const { require } = createRequire(vfs);
    const first = require('cached-mod');
    const second = require('cached-mod');
    expect(first).toBe(second); // Same object reference
  });

  it('supports circular dependencies (partial exports)', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/lib', { recursive: true });
    vfs.writeFileSync('/lib/a.js', `
      exports.name = "a";
      var b = require("./b");
      exports.bName = b.name;
    `);
    vfs.writeFileSync('/lib/b.js', `
      exports.name = "b";
      var a = require("./a");
      exports.aName = a.name;
    `);

    const { require } = createRequire(vfs, '/lib');
    const a = require('./a') as any;
    expect(a.name).toBe('a');
    expect(a.bName).toBe('b');
  });

  it('handles nested requires (package A requires package B)', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/pkg-a', { recursive: true });
    vfs.mkdirSync('/node_modules/pkg-b', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/pkg-a/package.json',
      JSON.stringify({ name: 'pkg-a', main: 'index.js' })
    );
    vfs.writeFileSync(
      '/node_modules/pkg-b/package.json',
      JSON.stringify({ name: 'pkg-b', main: 'index.js' })
    );
    vfs.writeFileSync('/node_modules/pkg-b/index.js', 'module.exports = 100;');
    vfs.writeFileSync(
      '/node_modules/pkg-a/index.js',
      'var b = require("pkg-b"); module.exports = b + 1;'
    );

    const { require } = createRequire(vfs);
    expect(require('pkg-a')).toBe(101);
  });

  it('strips shebangs', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/shebang-pkg', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/shebang-pkg/package.json',
      JSON.stringify({ name: 'shebang-pkg', main: 'index.js' })
    );
    vfs.writeFileSync(
      '/node_modules/shebang-pkg/index.js',
      '#!/usr/bin/env node\nmodule.exports = "shebang-stripped";'
    );

    const { require } = createRequire(vfs);
    expect(require('shebang-pkg')).toBe('shebang-stripped');
  });

  it('applies ESM→CJS safety-net transform', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/esm-mod', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/esm-mod/package.json',
      JSON.stringify({ name: 'esm-mod', main: 'index.js' })
    );
    // ESM code that wasn't pre-transformed
    // transformEsmToCjsSimple converts `export default function X()` to `module.exports = function X()`
    vfs.writeFileSync(
      '/node_modules/esm-mod/index.js',
      'export default function greet() { return "hi"; }'
    );

    const { require } = createRequire(vfs);
    const mod = require('esm-mod') as any;
    // transformEsmToCjsSimple sets module.exports directly (not .default)
    expect(typeof mod).toBe('function');
    expect(mod()).toBe('hi');
  });

  it('rewrites import.meta in the ESM safety-net transform', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/esm-import-meta-mod', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/esm-import-meta-mod/package.json',
      JSON.stringify({ name: 'esm-import-meta-mod', main: 'index.js', type: 'module' })
    );
    vfs.writeFileSync(
      '/node_modules/esm-import-meta-mod/index.js',
      `export const meta = import.meta;
export const url = import.meta.url;`
    );

    const { require } = createRequire(vfs);
    const mod = require('esm-import-meta-mod');

    expect(mod).toEqual({
      meta: {
        url: 'file:///node_modules/esm-import-meta-mod/index.js',
        filename: '/node_modules/esm-import-meta-mod/index.js',
        dirname: '/node_modules/esm-import-meta-mod',
      },
      url: 'file:///node_modules/esm-import-meta-mod/index.js',
    });
  });

  it('provides __filename and __dirname to modules', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/meta-mod', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/meta-mod/package.json',
      JSON.stringify({ name: 'meta-mod', main: 'index.js' })
    );
    vfs.writeFileSync(
      '/node_modules/meta-mod/index.js',
      'module.exports = { file: __filename, dir: __dirname };'
    );

    const { require } = createRequire(vfs);
    const mod = require('meta-mod') as any;
    expect(mod.file).toBe('/node_modules/meta-mod/index.js');
    expect(mod.dir).toBe('/node_modules/meta-mod');
  });

  it('lets transformed ESM packages declare CommonJS-like names', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/esm-meta-mod', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/esm-meta-mod/package.json',
      JSON.stringify({ name: 'esm-meta-mod', main: 'index.js' })
    );
    vfs.writeFileSync(
      '/node_modules/esm-meta-mod/index.js',
      `const require = () => "local-require";
const __filename = "local-file";
const __dirname = "local-dir";
module.exports = { required: require(), file: __filename, dir: __dirname };`
    );

    const { require } = createRequire(vfs);

    expect(require('esm-meta-mod')).toEqual({
      required: 'local-require',
      file: 'local-file',
      dir: 'local-dir',
    });
  });

  it('provides import_meta to pre-transformed ESM packages', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/import-meta-mod', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/import-meta-mod/package.json',
      JSON.stringify({ name: 'import-meta-mod', main: 'index.js' })
    );
    vfs.writeFileSync(
      '/node_modules/import-meta-mod/index.js',
      `module.exports = {
        url: import_meta.url,
        file: import_meta.filename,
        dir: import_meta.dirname
      };`
    );

    const { require } = createRequire(vfs);

    expect(require('import-meta-mod')).toEqual({
      url: 'file:///node_modules/import-meta-mod/index.js',
      file: '/node_modules/import-meta-mod/index.js',
      dir: '/node_modules/import-meta-mod',
    });
  });

  it('adds Node-style default interop for CommonJS packages with __esModule', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/@babel/core', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/@babel/core/package.json',
      JSON.stringify({ name: '@babel/core', main: 'index.js', type: 'commonjs' })
    );
    vfs.writeFileSync(
      '/node_modules/@babel/core/index.js',
      `Object.defineProperty(exports, "__esModule", { value: true });
exports.template = {
  expression: function expression() {
    return "template-ok";
  }
};`
    );
    vfs.mkdirSync('/node_modules/esm-consumer', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/esm-consumer/package.json',
      JSON.stringify({ name: 'esm-consumer', main: 'index.js', type: 'module' })
    );
    vfs.writeFileSync(
      '/node_modules/esm-consumer/index.js',
      `var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && (typeof from === "object" || typeof from === "function")) {
    for (let key of __getOwnPropNames(from)) {
      if (!__hasOwnProp.call(to, key) && key !== except) {
        __defProp(to, key, {
          get: () => from[key],
          enumerable: !(desc = Object.getOwnPropertyDescriptor(from, key)) || desc.enumerable
        });
      }
    }
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (
  target = mod != null ? Object.create(__getProtoOf(mod)) : {},
  __copyProps(isNodeMode || !mod || !mod.__esModule
    ? __defProp(target, "default", { value: mod, enumerable: true })
    : target, mod)
);
var import_core = __toESM(require("@babel/core"));
module.exports = import_core.default.template.expression();`
    );

    const { require } = createRequire(vfs);

    expect(require('esm-consumer')).toBe('template-ok');
  });

  it('does not add default interop to non-extensible CommonJS exports', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/frozen-mod', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/frozen-mod/package.json',
      JSON.stringify({ name: 'frozen-mod', main: 'index.js' })
    );
    vfs.writeFileSync(
      '/node_modules/frozen-mod/index.js',
      'module.exports = Object.freeze({ resolve: () => "ok" });'
    );

    const { require } = createRequire(vfs);
    const mod = require('frozen-mod');

    expect(mod).toEqual({ resolve: expect.any(Function) });
  });

  it('provides process object to modules', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/env-mod', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/env-mod/package.json',
      JSON.stringify({ name: 'env-mod', main: 'index.js' })
    );
    vfs.writeFileSync(
      '/node_modules/env-mod/index.js',
      'module.exports = process.env.MY_VAR;'
    );

    const { require: vfsRequire } = createVfsRequire(vfs, '/', {
      builtinModules: {},
      process: { env: { MY_VAR: 'hello-env' }, cwd: () => '/' },
    });

    expect(vfsRequire('env-mod')).toBe('hello-env');
  });

  it('keeps ESM dynamic imports inside the VFS require graph', async () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/dynamic-esm', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/dynamic-esm/package.json',
      JSON.stringify({ name: 'dynamic-esm', main: 'index.js', type: 'module' })
    );
    vfs.writeFileSync(
      '/node_modules/dynamic-esm/index.js',
      `export async function loadValue() {
  const module = await import('./value.js');
  return module.value;
}`
    );
    vfs.writeFileSync('/node_modules/dynamic-esm/value.js', 'exports.value = "from-vfs";');

    const { require } = createRequire(vfs);
    const loaded = require('dynamic-esm');

    if (!loaded || typeof loaded !== 'object' || !('loadValue' in loaded)) {
      throw new Error('dynamic-esm did not export loadValue');
    }
    const loadValue = loaded.loadValue;
    if (typeof loadValue !== 'function') {
      throw new Error('dynamic-esm loadValue is not a function');
    }

    expect(await loadValue()).toBe('from-vfs');
  });

  it('keeps CJS dynamic imports inside the VFS require graph', async () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/dynamic-cjs', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/dynamic-cjs/package.json',
      JSON.stringify({ name: 'dynamic-cjs', main: 'index.js' })
    );
    vfs.writeFileSync(
      '/node_modules/dynamic-cjs/index.js',
      `module.exports = async function loadValue() {
  const module = await import('./value.js');
  return module.value;
};`
    );
    vfs.writeFileSync('/node_modules/dynamic-cjs/value.js', 'exports.value = "from-vfs-cjs";');

    const { require } = createRequire(vfs);
    const loadValue = require('dynamic-cjs');

    if (typeof loadValue !== 'function') {
      throw new Error('dynamic-cjs did not export a function');
    }

    expect(await loadValue()).toBe('from-vfs-cjs');
  });
});

// ─── Builtins priority ──────────────────────────────────────────────────────

describe('VFS require — builtins', () => {
  it('returns builtins before checking VFS', () => {
    const vfs = setupVfs();
    // Create a package with same name as a builtin
    vfs.mkdirSync('/node_modules/path', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/path/package.json',
      JSON.stringify({ name: 'path', main: 'index.js' })
    );
    vfs.writeFileSync('/node_modules/path/index.js', 'module.exports = "vfs-path";');

    const fakePathModule = { join: () => 'fake' };
    const { require } = createRequire(vfs, '/', { path: fakePathModule });
    expect(require('path')).toBe(fakePathModule);
  });

  it('strips node: prefix for builtins', () => {
    const fakeFs = { readFileSync: () => 'mock' };
    const vfs = setupVfs();
    const { require } = createRequire(vfs, '/', { fs: fakeFs });
    expect(require('node:fs')).toBe(fakeFs);
  });

  it('exposes node:assert as the callable Node default export', async () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/assert-consumer', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/assert-consumer/package.json',
      JSON.stringify({ name: 'assert-consumer', main: 'index.js', type: 'module' })
    );
    vfs.writeFileSync(
      '/node_modules/assert-consumer/index.js',
      `import assert from 'node:assert';

assert(true, 'default assert should be callable');
export const ok = typeof assert === 'function';`
    );

    const builtins = await createBuiltinModules();
    const { require } = createVfsRequire(vfs, '/', {
      builtinModules: builtins,
      process: { env: {}, cwd: () => '/' },
    });

    expect(require('assert-consumer')).toEqual({ ok: true });
  });

  it('lets resolver-style packages probe extensionless VFS files', async () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/src', { recursive: true });
    vfs.writeFileSync('/src/router.ts', 'export const routeTree = {};');
    vfs.mkdirSync('/node_modules/router-entry-resolver', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/router-entry-resolver/package.json',
      JSON.stringify({ name: 'router-entry-resolver', main: 'index.js' })
    );
    vfs.writeFileSync(
      '/node_modules/router-entry-resolver/index.js',
      `const assert = require('node:assert');
const { statSync } = require('node:fs');

module.exports = function resolveRouterEntry() {
  for (const ext of ['.ts', '.js', '.mts', '.mjs', '.tsx', '.jsx']) {
    const candidate = '/src/router' + ext;
    const stats = statSync(candidate, { throwIfNoEntry: false });
    if (stats?.isFile()) {
      assert(candidate.endsWith('.ts'), 'router should resolve to the TS source file');
      return candidate;
    }
  }
  return undefined;
};`
    );

    const builtins = await createBuiltinModules(() => createFsShim(vfs, () => '/'));
    const { require } = createVfsRequire(vfs, '/', {
      builtinModules: builtins,
      process: { env: {}, cwd: () => '/' },
    });
    const resolver = require('router-entry-resolver');

    if (typeof resolver !== 'function') {
      throw new Error('router-entry-resolver did not export a function');
    }

    expect(resolver()).toBe('/src/router.ts');
  });
});

// ─── Integration with executeApiHandler ─────────────────────────────────────

describe('VFS require — integration with executeApiHandler', () => {
  it('API handler can require() a package from VFS node_modules', async () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/my-util', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/my-util/package.json',
      JSON.stringify({ name: 'my-util', main: 'index.js' })
    );
    vfs.writeFileSync('/node_modules/my-util/index.js', 'module.exports = { greet: function(n) { return "Hello " + n; } };');

    const builtins: Record<string, unknown> = {};
    const { require: vfsRequire } = createVfsRequire(vfs, '/', {
      builtinModules: builtins,
      process: { env: {}, cwd: () => '/' },
    });

    const handlerCode = `
      var util = require('my-util');
      module.exports.default = function(req, res) {
        res.json({ message: util.greet('World') });
      };
    `;

    const req = createMockRequest('GET', '/api/test', {});
    const res = createMockResponse();
    await executeApiHandler(handlerCode, req, res, {}, builtins, vfsRequire);

    const response = res.toResponse();
    expect(JSON.parse(response.body.toString())).toEqual({ message: 'Hello World' });
  });

  it('builtins take priority over VFS packages in handler', async () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/path', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/path/package.json',
      JSON.stringify({ name: 'path', main: 'index.js' })
    );
    vfs.writeFileSync('/node_modules/path/index.js', 'module.exports = { join: function() { return "vfs"; } };');

    const builtins: Record<string, unknown> = {
      path: { join: (...args: string[]) => args.join('/') },
    };
    const { require: vfsRequire } = createVfsRequire(vfs, '/', {
      builtinModules: builtins,
      process: { env: {}, cwd: () => '/' },
    });

    const handlerCode = `
      var path = require('path');
      module.exports.default = function(req, res) {
        res.json({ result: path.join('a', 'b') });
      };
    `;

    const req = createMockRequest('GET', '/api/test', {});
    const res = createMockResponse();
    await executeApiHandler(handlerCode, req, res, {}, builtins, vfsRequire);

    const response = res.toResponse();
    expect(JSON.parse(response.body.toString())).toEqual({ result: 'a/b' });
  });

  it('works without vfsRequire (backward compat)', async () => {
    const builtins: Record<string, unknown> = {};

    const handlerCode = `
      module.exports.default = function(req, res) {
        res.json({ ok: true });
      };
    `;

    const req = createMockRequest('GET', '/api/test', {});
    const res = createMockResponse();
    await executeApiHandler(handlerCode, req, res, {}, builtins);

    const response = res.toResponse();
    expect(JSON.parse(response.body.toString())).toEqual({ ok: true });
  });

  it('throws when module not found and no vfsRequire', async () => {
    const builtins: Record<string, unknown> = {};

    const handlerCode = `
      var pkg = require('nonexistent');
      module.exports.default = function(req, res) {
        res.json({ ok: true });
      };
    `;

    const req = createMockRequest('GET', '/api/test', {});
    const res = createMockResponse();
    await expect(
      executeApiHandler(handlerCode, req, res, {}, builtins)
    ).rejects.toThrow('Module not found: nonexistent');
  });
});

// ─── CORS proxy ──────────────────────────────────────────────────────────────

describe('VFS require — CORS proxy via process.env', () => {
  it('process.env.CORS_PROXY_URL is available to loaded modules', () => {
    const vfs = setupVfs();
    vfs.mkdirSync('/node_modules/proxy-check', { recursive: true });
    vfs.writeFileSync(
      '/node_modules/proxy-check/package.json',
      JSON.stringify({ name: 'proxy-check', main: 'index.js' })
    );
    vfs.writeFileSync(
      '/node_modules/proxy-check/index.js',
      'module.exports = process.env.CORS_PROXY_URL;'
    );

    const { require: vfsRequire } = createVfsRequire(vfs, '/', {
      builtinModules: {},
      process: {
        env: { CORS_PROXY_URL: 'https://proxy.example.com/?' },
        cwd: () => '/',
      },
    });

    expect(vfsRequire('proxy-check')).toBe('https://proxy.example.com/?');
  });
});

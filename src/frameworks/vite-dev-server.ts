/**
 * ViteDevServer - Vite-compatible dev server for browser environment
 * Serves files from VirtualFS with JSX/TypeScript transformation
 */

import { DevServer, DevServerOptions, ResponseData, HMRUpdate } from '../dev-server';
import { VirtualFS } from '../virtual-fs';
import { Buffer } from '../shims/stream';
import { simpleHash } from '../utils/hash';
import { addReactRefresh as _addReactRefresh, redirectNpmImports as _redirectNpmImports } from './code-transforms';
import { bundleNpmModuleForBrowser, clearNpmBundleCache, initNpmServe } from './npm-serve';
import { ESBUILD_WASM_ESM_CDN, ESBUILD_WASM_BINARY_CDN, REACT_REFRESH_CDN, REACT_CDN, REACT_DOM_CDN } from '../config/cdn';
import { VitePluginContainer } from './vite-plugin-container';
import { importExternalModule } from '../utils/external-import';

type EsbuildRuntimeGlobal = typeof globalThis & {
  __esbuild?: typeof import('esbuild-wasm');
  __esbuildInitPromise?: Promise<void>;
  importScripts?: (...urls: string[]) => void;
};

const esbuildRuntimeGlobal = globalThis as EsbuildRuntimeGlobal;

// Check if we're in a real browser runtime (window, service worker, or worker),
// not jsdom or Node.js. AlmostNode can serve Vite requests from a worker-like
// context, so tying transforms to `window` skips npm import rewriting there.
const isBrowserWindow = typeof window !== 'undefined' &&
  typeof window.navigator !== 'undefined' &&
  'serviceWorker' in window.navigator;
const isBrowserWorker = typeof self !== 'undefined' &&
  typeof esbuildRuntimeGlobal.importScripts === 'function';
const isBrowser = isBrowserWindow || isBrowserWorker;

// Window.__esbuild type is declared in src/types/external.d.ts

/**
 * Initialize esbuild-wasm for browser transforms
 * Uses window-level singleton to prevent "Cannot call initialize more than once" errors
 */
async function initEsbuild(): Promise<void> {
  if (!isBrowser) return;

  // Check if already initialized (survives HMR)
  if (esbuildRuntimeGlobal.__esbuild) {
    return;
  }

  // Check if initialization is in progress
  if (esbuildRuntimeGlobal.__esbuildInitPromise) {
    return esbuildRuntimeGlobal.__esbuildInitPromise;
  }

  esbuildRuntimeGlobal.__esbuildInitPromise = (async () => {
    try {
      const mod = await importExternalModule<
        typeof import('esbuild-wasm') & {
          default?: typeof import('esbuild-wasm');
        }
      >(ESBUILD_WASM_ESM_CDN);

      const esbuildMod = mod.default || mod;

      try {
        await esbuildMod.initialize({
          wasmURL: ESBUILD_WASM_BINARY_CDN,
        });
        console.log('[ViteDevServer] esbuild-wasm initialized');
      } catch (initError) {
        // If esbuild is already initialized (e.g., from a previous HMR cycle),
        // the WASM is still loaded and the module is usable
        if (initError instanceof Error && initError.message.includes('Cannot call "initialize" more than once')) {
          console.log('[ViteDevServer] esbuild-wasm already initialized, reusing');
        } else {
          throw initError;
        }
      }

      esbuildRuntimeGlobal.__esbuild = esbuildMod;
    } catch (error) {
      console.error('[ViteDevServer] Failed to initialize esbuild:', error);
      esbuildRuntimeGlobal.__esbuildInitPromise = undefined;
      throw error;
    }
  })();

  return esbuildRuntimeGlobal.__esbuildInitPromise;
}

/**
 * Get the esbuild instance (after initialization)
 */
function getEsbuild(): typeof import('esbuild-wasm') | undefined {
  return isBrowser ? esbuildRuntimeGlobal.__esbuild : undefined;
}

export interface ViteDevServerOptions extends DevServerOptions {
  /**
   * Enable JSX transformation (default: true)
   */
  jsx?: boolean;

  /**
   * JSX factory function (default: 'React.createElement')
   */
  jsxFactory?: string;

  /**
   * JSX fragment function (default: 'React.Fragment')
   */
  jsxFragment?: string;

  /**
   * Auto-inject React import for JSX files (default: true)
   */
  jsxAutoImport?: boolean;
}

/**
 * React Refresh preamble - MUST run before React is loaded
 * This script is blocking to ensure injectIntoGlobalHook runs first
 */
const REACT_REFRESH_PREAMBLE = `
<script type="module">
// Block until React Refresh is loaded and initialized
// This MUST happen before React is imported
const RefreshRuntime = await import('${REACT_REFRESH_CDN}').then(m => m.default || m);

// Hook into React BEFORE it's loaded
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshRuntime$ = RefreshRuntime;

// Track registrations for debugging
window.$RefreshRegCount$ = 0;

// Register function called by transformed modules
window.$RefreshReg$ = (type, id) => {
  window.$RefreshRegCount$++;
  RefreshRuntime.register(type, id);
};

// Signature function (simplified - always returns identity)
window.$RefreshSig$ = () => (type) => type;

console.log('[HMR] React Refresh initialized');
</script>
`;

/**
 * HMR client script injected into index.html
 * Implements the import.meta.hot API and handles HMR updates
 */
const HMR_CLIENT_SCRIPT = `
<script type="module">
(function() {
  // Track hot modules and their callbacks
  const hotModules = new Map();
  const pendingUpdates = new Map();

  // Implement import.meta.hot API (Vite-compatible)
  window.__vite_hot_context__ = function createHotContext(ownerPath) {
    // Return existing context if already created
    if (hotModules.has(ownerPath)) {
      return hotModules.get(ownerPath);
    }

    const hot = {
      // Persisted data between updates
      data: {},

      // Accept self-updates
      accept(callback) {
        hot._acceptCallback = callback;
      },

      // Cleanup before update
      dispose(callback) {
        hot._disposeCallback = callback;
      },

      // Force full reload
      invalidate() {
        location.reload();
      },

      // Prune callback (called when module is no longer imported)
      prune(callback) {
        hot._pruneCallback = callback;
      },

      // Event handlers (not implemented)
      on(event, cb) {},
      off(event, cb) {},
      send(event, data) {},

      // Internal callbacks
      _acceptCallback: null,
      _disposeCallback: null,
      _pruneCallback: null,
    };

    hotModules.set(ownerPath, hot);
    return hot;
  };

  // Listen for HMR updates via postMessage (works with sandboxed iframes)
  window.addEventListener('message', async (event) => {
    // Filter for HMR messages only
    if (!event.data || event.data.channel !== 'vite-hmr') return;
    const { type, path, timestamp } = event.data;

    if (type === 'update') {
      console.log('[HMR] Update:', path);

      if (path.endsWith('.css')) {
        const normalizedPath = path.startsWith('/') ? path : '/' + path;
        const cssModuleUrl = '.' + normalizedPath + '?t=' + timestamp;

        // CSS hot reload - update stylesheet href
        const links = document.querySelectorAll('link[rel="stylesheet"]');
        links.forEach(link => {
          const href = link.getAttribute('href');
          if (href && href.includes(normalizedPath.replace(/^\\//, ''))) {
            link.href = href.split('?')[0] + '?t=' + timestamp;
          }
        });

        // Also update any injected style tags
        const styles = document.querySelectorAll('style[data-vite-dev-id]');
        styles.forEach(style => {
          const id = style.getAttribute('data-vite-dev-id');
          if (id && id.includes(normalizedPath.replace(/^\\//, ''))) {
            // Re-import the CSS module to get updated styles
            import(cssModuleUrl).catch((error) => {
              console.error('[HMR] Failed to update CSS:', error);
            });
          }
        });
      } else if (path.match(/\\.(jsx?|tsx?)$/)) {
        // JS/JSX hot reload with React Refresh
        await handleJSUpdate(path, timestamp);
      }
    } else if (type === 'full-reload') {
      console.log('[HMR] Full reload');
      location.reload();
    }
  });

  // Handle JS/JSX module updates
  async function handleJSUpdate(path, timestamp) {
    // Normalize path to match module keys
    const normalizedPath = path.startsWith('/') ? path : '/' + path;
    const hot = hotModules.get(normalizedPath);

    try {
      // Call dispose callback if registered
      if (hot && hot._disposeCallback) {
        hot._disposeCallback(hot.data);
      }

      // Enqueue React Refresh (batches multiple updates)
      if (window.$RefreshRuntime$) {
        pendingUpdates.set(normalizedPath, timestamp);

        // Schedule refresh after a short delay to batch updates
        if (pendingUpdates.size === 1) {
          setTimeout(async () => {
            try {
              // Re-import all pending modules
              for (const [modulePath, ts] of pendingUpdates) {
                const moduleUrl = '.' + modulePath + '?t=' + ts;
                await import(moduleUrl);
              }

              // Perform React Refresh
              window.$RefreshRuntime$.performReactRefresh();
              console.log('[HMR] Updated', pendingUpdates.size, 'module(s)');

              pendingUpdates.clear();
            } catch (error) {
              console.error('[HMR] Failed to apply update:', error);
              pendingUpdates.clear();
              location.reload();
            }
          }, 30);
        }
      } else {
        // No React Refresh available, fall back to page reload
        console.log('[HMR] React Refresh not available, reloading page');
        location.reload();
      }
    } catch (error) {
      console.error('[HMR] Update failed:', error);
      location.reload();
    }
  }

  console.log('[HMR] Client ready with React Refresh support');
})();
</script>
`;

const VITE_IMPORT_META_ENV_SCRIPT = `
<script>
(() => {
  const match = window.location.pathname.match(/^\\/__virtual__\\/\\d+(?:\\/|$)/);
  const baseUrl = match ? match[0].replace(/\\/$/, '') : '';
  window.__ALMOSTNODE_IMPORT_META_ENV__ = Object.freeze({
    BASE_URL: baseUrl ? baseUrl + '/' : '/',
    MODE: 'development',
    DEV: true,
    PROD: false,
    SSR: false,
  });
})();
</script>
`;

function isLocalRootAbsoluteUrl(url: string): boolean {
  return url.startsWith('/') &&
    !url.startsWith('//') &&
    !url.startsWith('/__virtual__') &&
    !url.startsWith('/_npm/');
}

function splitUrlSuffix(url: string): { pathname: string; suffix: string } {
  const suffixIndex = url.search(/[?#]/);
  if (suffixIndex === -1) {
    return { pathname: url, suffix: '' };
  }
  return {
    pathname: url.slice(0, suffixIndex),
    suffix: url.slice(suffixIndex),
  };
}

function dirname(path: string): string {
  const clean = path.split('?')[0].split('#')[0];
  const index = clean.lastIndexOf('/');
  return index <= 0 ? '/' : clean.slice(0, index);
}

function relativeFromFile(filePath: string, targetUrl: string): string {
  const { pathname, suffix } = splitUrlSuffix(targetUrl);
  const fromParts = dirname(filePath).split('/').filter(Boolean);
  const toParts = pathname.split('/').filter(Boolean);

  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }

  const prefix = fromParts.length === 0
    ? './'
    : '../'.repeat(fromParts.length);
  return `${prefix}${toParts.join('/')}${suffix}`;
}

function rewriteRootAbsoluteUrl(filePath: string, url: string): string {
  if (!isLocalRootAbsoluteUrl(url)) {
    return url;
  }
  return relativeFromFile(filePath, url);
}

function rewriteHtmlRootUrls(html: string, filePath: string): string {
  let rewritten = html.replace(
    /\b(src|href|action|poster)\s*=\s*(["'])(\/(?!\/|__virtual__)[^"']*)\2/g,
    (_match, attr: string, quote: string, url: string) =>
      `${attr}=${quote}${rewriteRootAbsoluteUrl(filePath, url)}${quote}`
  );

  rewritten = rewritten.replace(
    /\bsrcset\s*=\s*(["'])([^"']*)\1/g,
    (_match, quote: string, srcset: string) => {
      const nextSrcset = srcset
        .split(',')
        .map((candidate) => {
          const trimmed = candidate.trim();
          if (!trimmed) return trimmed;
          const [url, ...descriptor] = trimmed.split(/\s+/);
          const nextUrl = rewriteRootAbsoluteUrl(filePath, url);
          return [nextUrl, ...descriptor].join(' ');
        })
        .join(', ');
      return `srcset=${quote}${nextSrcset}${quote}`;
    }
  );

  return rewritten;
}

function rewriteJsRootUrls(code: string, filePath: string): string {
  return rewriteImportMetaEnv(code)
    .replace(
      /(\b(?:import|export)\s+(?:[^'"]*?\s+from\s*)?|\bimport\s*\(\s*)(["'])(\/(?!\/|__virtual__)[^"']+)\2/g,
      (_match, prefix: string, quote: string, url: string) =>
        `${prefix}${quote}${rewriteRootAbsoluteUrl(filePath, url)}${quote}`
    )
    .replace(
      /(\bfetch\s*\(\s*)(["'])(\/(?!\/|__virtual__)[^"']+)\2/g,
      (_match, prefix: string, quote: string, url: string) =>
        `${prefix}${quote}${rewriteRootAbsoluteUrl(filePath, url)}${quote}`
    );
}

function rewriteImportMetaEnv(code: string): string {
  return code.replace(
    /\bimport\.meta\.env\b/g,
    'window.__ALMOSTNODE_IMPORT_META_ENV__'
  );
}

function rewriteCssRootUrls(css: string, filePath: string): string {
  return css
    .replace(
      /url\(\s*(["']?)(\/(?!\/|__virtual__)[^"')]+)\1\s*\)/g,
      (_match, quote: string, url: string) =>
        `url(${quote}${rewriteRootAbsoluteUrl(filePath, url)}${quote})`
    )
    .replace(
      /(@import\s+)(["'])(\/(?!\/|__virtual__)[^"']+)\2/g,
      (_match, prefix: string, quote: string, url: string) =>
        `${prefix}${quote}${rewriteRootAbsoluteUrl(filePath, url)}${quote}`
    );
}

const EXTENSIONLESS_FILE_EXTENSIONS = [
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.json',
  '.css',
  '.html',
];

export class ViteDevServer extends DevServer {
  private watcherCleanup: (() => void) | null = null;
  private options: ViteDevServerOptions;
  private hmrTargetWindow: Window | null = null;
  private transformCache: Map<string, { code: string; hash: string }> = new Map();
  private cssTransformCache: Map<string, { code: string; hash: string }> = new Map();
  private pluginContainer: VitePluginContainer;
  private _dependencies: Record<string, string> | undefined;
  private _installedPackages: Set<string> | undefined;

  constructor(vfs: VirtualFS, options: ViteDevServerOptions) {
    super(vfs, options);
    initNpmServe(vfs);
    this.options = {
      jsx: true,
      jsxFactory: 'React.createElement',
      jsxFragment: 'React.Fragment',
      jsxAutoImport: true,
      ...options,
    };
    this.pluginContainer = new VitePluginContainer(vfs, this.root);
  }

  /**
   * Set the target window for HMR updates (typically iframe.contentWindow)
   * This enables HMR to work with sandboxed iframes via postMessage
   */
  setHMRTarget(targetWindow: Window): void {
    this.hmrTargetWindow = targetWindow;
  }

  /**
   * Handle an incoming HTTP request
   */
  async handleRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: Buffer
  ): Promise<ResponseData> {
    // Parse URL
    const urlObj = new URL(url, 'http://localhost');
    let pathname = urlObj.pathname;

    // Handle root path - serve index.html
    if (pathname === '/') {
      pathname = '/index.html';
    }

    if (pathname.startsWith('/_npm/')) {
      return this.serveNpmModule(pathname);
    }

    const requestedFilePath = this.resolvePath(pathname);
    const filePath = this.resolveExistingRequestPath(requestedFilePath);

    if (!filePath) {
      return this.notFound(pathname);
    }

    // If it's a directory, redirect to index.html
    if (this.isDirectory(filePath)) {
      if (this.exists(filePath + '/index.html')) {
        return this.serveFile(filePath + '/index.html');
      }
      return this.notFound(pathname);
    }

    // Check if file needs transformation (JSX/TS)
    if (this.needsTransform(filePath)) {
      return this.transformAndServe(filePath);
    }

    if (/\.(js|mjs)$/.test(filePath)) {
      return this.serveJsFile(filePath);
    }

    // Check if CSS is being imported as a module (needs to be converted to JS)
    // In browser context with ES modules, CSS imports need to be served as JS
    if (filePath.endsWith('.css')) {
      // Check various header formats for sec-fetch-dest
      const secFetchDest =
        headers['sec-fetch-dest'] ||
        headers['Sec-Fetch-Dest'] ||
        headers['SEC-FETCH-DEST'] ||
        '';
      const accept =
        headers['accept'] ||
        headers['Accept'] ||
        headers['ACCEPT'] ||
        '';
      const acceptsCss = accept.includes('text/css');

      // In browser, serve CSS as module when:
      // 1. Requested as a script (sec-fetch-dest: script)
      // 2. Empty dest (sec-fetch-dest: empty) - fetch() calls
      // 3. No sec-fetch-dest but in browser context and the request is not
      //    clearly a stylesheet link request.
      const isModuleImport =
        secFetchDest === 'script' ||
        secFetchDest === 'empty' ||
        (isBrowser && secFetchDest === '' && !acceptsCss);

      if (isModuleImport) {
        return this.serveCssAsModule(filePath);
      }
      // Otherwise serve as regular CSS (e.g., <link> tags with sec-fetch-dest: style)
      return this.serveCssFile(filePath);
    }

    // Check if it's HTML that needs HMR client injection
    if (filePath.endsWith('.html')) {
      return this.serveHtmlWithHMR(filePath);
    }

    // Serve static file
    return this.serveFile(filePath);
  }

  /**
   * Start file watching for HMR
   */
  startWatching(): void {
    // Watch /src directory for changes
    const srcPath = this.root === '/' ? '/src' : `${this.root}/src`;

    try {
      const watcher = this.vfs.watch(srcPath, { recursive: true }, (eventType, filename) => {
        if (eventType === 'change' && filename) {
          const fullPath = filename.startsWith('/') ? filename : `${srcPath}/${filename}`;
          this.handleFileChange(fullPath);
        }
      });

      this.watcherCleanup = () => {
        watcher.close();
      };
    } catch (error) {
      console.warn('[ViteDevServer] Could not watch /src directory:', error);
    }

    // Real Vite watches root-level entry files such as index.html and config-side
    // imports. Mirror that behavior for the file types this dev server can serve.
    try {
      const rootWatcher = this.vfs.watch(this.root, { recursive: false }, (eventType, filename) => {
        if (eventType === 'change' && filename && /\.(css|html|jsx?|tsx?)$/.test(filename)) {
          const fullPath = this.root === '/' ? `/${filename}` : `${this.root}/${filename}`;
          this.handleFileChange(fullPath);
        }
      });

      const originalCleanup = this.watcherCleanup;
      this.watcherCleanup = () => {
        originalCleanup?.();
        rootWatcher.close();
      };
    } catch {
      // Ignore if root watching fails
    }
  }

  /**
   * Handle file change event
   */
  notifyFileChanged(path: string): void {
    this.handleFileChange(path.startsWith('/') ? path : `/${path}`);
  }

  private handleFileChange(path: string): void {
    this.transformCache.delete(path);
    this.cssTransformCache.delete(path);

    const isCSS = path.endsWith('.css');
    const isJS = /\.(jsx?|tsx?)$/.test(path);
    const isContentFile = isJS || /\.(html|mdx?)$/.test(path);

    if (
      isCSS ||
      isContentFile ||
      /\/vite\.config\.(js|mjs|ts)$/.test(path) ||
      path.endsWith('/package.json')
    ) {
      this.cssTransformCache.clear();
    }

    if (/\/vite\.config\.(js|mjs|ts)$/.test(path)) {
      this.pluginContainer.invalidate();
    }

    if (path.endsWith('/package.json')) {
      this.clearInstalledPackagesCache();
    }

    if (!isCSS && isContentFile) {
      for (const cssPath of this.getCompiledTailwindCssPaths()) {
        this.sendHMRUpdate({
          type: 'update',
          path: cssPath,
          timestamp: Date.now(),
        });
      }
    }

    // Determine update type:
    // - CSS and JS/JSX/TSX files: 'update' (handled by HMR client)
    // - Other files: 'full-reload'
    const updateType = (isCSS || isJS) ? 'update' : 'full-reload';

    this.sendHMRUpdate({
      type: updateType,
      path,
      timestamp: Date.now(),
    });
  }

  /**
   * Stop the server
   */
  stop(): void {
    if (this.watcherCleanup) {
      this.watcherCleanup();
      this.watcherCleanup = null;
    }

    this.hmrTargetWindow = null;
    this.pluginContainer.invalidate();
    this.cssTransformCache.clear();

    super.stop();
  }

  /**
   * Check if a file needs transformation
   */
  private needsTransform(path: string): boolean {
    return /\.(jsx|tsx|ts)$/.test(path);
  }

  private resolveExistingRequestPath(filePath: string): string | null {
    if (this.exists(filePath)) return filePath;

    for (const extension of EXTENSIONLESS_FILE_EXTENSIONS) {
      const candidate = `${filePath}${extension}`;
      if (this.exists(candidate)) return candidate;
    }

    for (const extension of EXTENSIONLESS_FILE_EXTENSIONS) {
      const candidate = `${filePath}/index${extension}`;
      if (this.exists(candidate)) return candidate;
    }

    return null;
  }

  /**
   * Transform and serve a JSX/TS file
   */
  private async transformAndServe(filePath: string): Promise<ResponseData> {
    try {
      const content = this.vfs.readFileSync(filePath, 'utf8');
      const hash = simpleHash(content);

      // Check transform cache
      const cached = this.transformCache.get(filePath);
      if (cached && cached.hash === hash) {
        const buffer = Buffer.from(cached.code);
        return {
          statusCode: 200,
          statusMessage: 'OK',
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Content-Length': String(buffer.length),
            'Cache-Control': 'no-cache',
            'X-Transformed': 'true',
            'X-Cache': 'hit',
          },
          body: buffer,
        };
      }

      const transformed = await this.transformCode(content, filePath);

      // Cache the transform result
      this.transformCache.set(filePath, { code: transformed, hash });

      const buffer = Buffer.from(transformed);
      return {
        statusCode: 200,
        statusMessage: 'OK',
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Length': String(buffer.length),
          'Cache-Control': 'no-cache',
          'X-Transformed': 'true',
        },
        body: buffer,
      };
    } catch (error) {
      console.error('[ViteDevServer] Transform error:', error);
      const message = error instanceof Error ? error.message : 'Transform failed';
      const body = `// Transform Error: ${message}\nconsole.error(${JSON.stringify(message)});`;
      return {
        statusCode: 200, // Return 200 with error in code to show in browser console
        statusMessage: 'OK',
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'X-Transform-Error': 'true',
        },
        body: Buffer.from(body),
      };
    }
  }

  /**
   * Transform JSX/TS code to browser-compatible JavaScript
   */
  private async transformCode(code: string, filename: string): Promise<string> {
    if (!isBrowser) {
      // In test environment, just return code as-is
      return rewriteJsRootUrls(this.redirectNpmImports(code), filename);
    }

    // Initialize esbuild if needed
    await initEsbuild();

    const esbuild = getEsbuild();
    if (!esbuild) {
      throw new Error('esbuild not available');
    }

    // Determine loader based on extension
    let loader: 'js' | 'jsx' | 'ts' | 'tsx' = 'js';
    if (filename.endsWith('.jsx')) loader = 'jsx';
    else if (filename.endsWith('.tsx')) loader = 'tsx';
    else if (filename.endsWith('.ts')) loader = 'ts';

    const result = await esbuild.transform(code, {
      loader,
      format: 'esm', // Keep as ES modules for browser
      target: 'esnext',
      jsx: 'automatic', // Use React 17+ automatic runtime
      jsxImportSource: 'react',
      sourcemap: 'inline',
      sourcefile: filename,
    });

    // Add React Refresh registration for JSX/TSX files
    let transformed = result.code;
    if (/\.(jsx|tsx)$/.test(filename)) {
      transformed = this.addReactRefresh(transformed, filename);
    }

    return rewriteJsRootUrls(this.redirectNpmImports(transformed), filename);
  }

  private addReactRefresh(code: string, filename: string): string {
    return _addReactRefresh(code, filename);
  }

  private serveJsFile(filePath: string): ResponseData {
    try {
      const source = this.vfs.readFileSync(filePath, 'utf8');
      const code = rewriteJsRootUrls(this.redirectNpmImports(source), filePath);
      const buffer = Buffer.from(code);

      return {
        statusCode: 200,
        statusMessage: 'OK',
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Length': String(buffer.length),
          'Cache-Control': 'no-cache',
        },
        body: buffer,
      };
    } catch (error) {
      console.error('[ViteDevServer] CSS module error:', error);
      return this.serverError(error);
    }
  }

  /**
   * Serve CSS file as a JavaScript module that injects styles
   * This is needed because ES module imports of CSS files need to return JS
   */
  private async serveCssAsModule(filePath: string): Promise<ResponseData> {
    try {
      const css = await this.processCss(this.vfs.readFileSync(filePath, 'utf8'), filePath);

      // Create JavaScript that injects the CSS into the document
      const js = `
// CSS Module: ${filePath}
const id = ${JSON.stringify(filePath)};
const css = ${JSON.stringify(css)};
let style = Array.from(document.querySelectorAll('style[data-vite-dev-id]'))
  .find((node) => node.getAttribute('data-vite-dev-id') === id);
if (!style) {
  style = document.createElement('style');
  style.setAttribute('data-vite-dev-id', id);
  document.head.appendChild(style);
}
style.textContent = css;
export default css;
`;

      const buffer = Buffer.from(js);
      return {
        statusCode: 200,
        statusMessage: 'OK',
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Length': String(buffer.length),
          'Cache-Control': 'no-cache',
        },
        body: buffer,
      };
    } catch (error) {
      console.error('[ViteDevServer] CSS file error:', error);
      return this.serverError(error);
    }
  }

  private async serveCssFile(filePath: string): Promise<ResponseData> {
    try {
      const css = await this.processCss(this.vfs.readFileSync(filePath, 'utf8'), filePath);
      const buffer = Buffer.from(css);

      return {
        statusCode: 200,
        statusMessage: 'OK',
        headers: {
          'Content-Type': 'text/css; charset=utf-8',
          'Content-Length': String(buffer.length),
          'Cache-Control': 'no-cache',
        },
        body: buffer,
      };
    } catch (error) {
      return this.serverError(error);
    }
  }

  private async processCss(css: string, filePath: string): Promise<string> {
    const pluginKey = this.pluginContainer.getCacheKey();
    const hash = simpleHash(`${pluginKey}\n${css}`);
    const cached = this.cssTransformCache.get(filePath);
    if (cached?.hash === hash) {
      return cached.code;
    }

    let transformed = css;
    if (this.pluginContainer.getConfigPath()) {
      transformed = await this.pluginContainer.transformCss(css, filePath);
    }

    const code = rewriteCssRootUrls(transformed, filePath);
    this.cssTransformCache.set(filePath, { code, hash });
    return code;
  }

  private getDependencies(): Record<string, string> {
    if (this._dependencies) return this._dependencies;

    let deps: Record<string, string> = {};
    const pkgPath = this.root === '/' ? '/package.json' : `${this.root}/package.json`;

    try {
      if (this.vfs.existsSync(pkgPath)) {
        const pkg = JSON.parse(this.vfs.readFileSync(pkgPath, 'utf-8')) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        deps = { ...pkg.dependencies, ...pkg.devDependencies };
      }
    } catch {
      // Ignore malformed package manifests; unresolved imports will fail normally.
    }

    this._dependencies = deps;
    return deps;
  }

  private getInstalledPackages(): Set<string> {
    if (this._installedPackages) return this._installedPackages;

    const packages = new Set<string>();
    const nodeModulesDir = '/node_modules';

    try {
      if (!this.vfs.existsSync(nodeModulesDir)) {
        this._installedPackages = packages;
        return packages;
      }

      const entries = this.vfs.readdirSync(nodeModulesDir) as string[];
      for (const entry of entries) {
        if (entry.startsWith('.')) continue;

        if (entry.startsWith('@')) {
          const scopeDir = `${nodeModulesDir}/${entry}`;
          try {
            const scopeEntries = this.vfs.readdirSync(scopeDir) as string[];
            for (const scopedPackage of scopeEntries) {
              packages.add(`${entry}/${scopedPackage}`);
            }
          } catch {
            // Ignore incomplete scoped package directories.
          }
          continue;
        }

        packages.add(entry);
      }
    } catch {
      // Ignore filesystem errors; unresolved imports will fail normally.
    }

    this._installedPackages = packages;
    return packages;
  }

  clearInstalledPackagesCache(): void {
    this._dependencies = undefined;
    this._installedPackages = undefined;
    clearNpmBundleCache();
  }

  private async serveNpmModule(pathname: string): Promise<ResponseData> {
    const specifier = pathname.slice('/_npm/'.length);
    if (!specifier) {
      return this.notFound(pathname);
    }

    try {
      const code = await bundleNpmModuleForBrowser(specifier);
      return {
        statusCode: 200,
        statusMessage: 'OK',
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
        body: Buffer.from(code),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ViteDevServer] Failed to bundle npm module '${specifier}':`, message);
      return {
        statusCode: 500,
        statusMessage: 'Internal Server Error',
        headers: { 'Content-Type': 'text/plain' },
        body: Buffer.from(`Failed to bundle '${specifier}': ${message}`),
      };
    }
  }

  private redirectNpmImports(code: string): string {
    return _redirectNpmImports(
      code,
      undefined,
      this.getDependencies(),
      undefined,
      this.getInstalledPackages(),
    );
  }

  private getCompiledTailwindCssPaths(): string[] {
    const paths: string[] = [];

    const walk = (dir: string): void => {
      if (!this.exists(dir) || !this.isDirectory(dir)) return;

      for (const entry of this.vfs.readdirSync(dir) as string[]) {
        if (entry === 'node_modules' || entry === '.git') continue;

        const fullPath = dir === '/' ? `/${entry}` : `${dir}/${entry}`;
        if (this.isDirectory(fullPath)) {
          walk(fullPath);
          continue;
        }

        if (!fullPath.endsWith('.css')) continue;
        const cssFile = this.vfs.readFileSync(fullPath, 'utf8');
        if (/@import\s+["']tailwindcss["']/.test(cssFile)) {
          paths.push(fullPath);
        }
      }
    };

    walk(this.root);
    return paths;
  }

  private sendHMRUpdate(update: HMRUpdate): void {
    this.emitHMRUpdate(update);

    if (this.hmrTargetWindow) {
      try {
        this.hmrTargetWindow.postMessage({ ...update, channel: 'vite-hmr' }, '*');
      } catch {
        // Window may be closed or unavailable.
      }
    }
  }

  /**
   * Serve HTML file with HMR client script injected
   *
   * IMPORTANT: React Refresh preamble MUST be injected before any module scripts.
   * The preamble uses top-level await to block until React Refresh is loaded
   * and injectIntoGlobalHook is called. This ensures React Refresh hooks into
   * React BEFORE React is imported by any module.
   */
  private serveHtmlWithHMR(filePath: string): ResponseData {
    try {
      let content = this.vfs.readFileSync(filePath, 'utf8');
      content = rewriteHtmlRootUrls(content, filePath);

      // Inject a React import map if the HTML doesn't already have one.
      // This lets seed HTML omit the esm.sh boilerplate — the platform provides it.
      if (!content.includes('"importmap"')) {
        const importMap = `<script type="importmap">
{
  "imports": {
    "react": "${REACT_CDN}?dev",
    "react/": "${REACT_CDN}&dev/",
    "react-dom": "${REACT_DOM_CDN}?dev",
    "react-dom/": "${REACT_DOM_CDN}&dev/"
  }
}
</script>`;
        if (content.includes('</head>')) {
          content = content.replace('</head>', `${importMap}\n</head>`);
        } else if (content.includes('<head>')) {
          content = content.replace('<head>', `<head>\n${importMap}`);
        }
      }

      // Inject React Refresh preamble before any app module scripts.
      // Firefox requires all <script type="importmap"> to appear before any <script type="module">,
      // so if the HTML contains an import map, inject AFTER the last one (not right after <head>).
      const importMapRegex = /<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>[\s\S]*?<\/script>/gi;
      let lastImportMapEnd = -1;
      let match;
      while ((match = importMapRegex.exec(content)) !== null) {
        lastImportMapEnd = match.index + match[0].length;
      }

      if (lastImportMapEnd !== -1) {
        content = content.slice(0, lastImportMapEnd) + VITE_IMPORT_META_ENV_SCRIPT + content.slice(lastImportMapEnd);
        lastImportMapEnd += VITE_IMPORT_META_ENV_SCRIPT.length;
      } else if (content.includes('<head>')) {
        content = content.replace('<head>', `<head>${VITE_IMPORT_META_ENV_SCRIPT}`);
      } else if (content.includes('<html')) {
        content = content.replace(/<html[^>]*>/, `$&${VITE_IMPORT_META_ENV_SCRIPT}`);
      } else {
        content = VITE_IMPORT_META_ENV_SCRIPT + content;
      }

      if (lastImportMapEnd !== -1) {
        // Insert preamble right after the last import map </script>
        content = content.slice(0, lastImportMapEnd) + REACT_REFRESH_PREAMBLE + content.slice(lastImportMapEnd);
      } else if (content.includes('<head>')) {
        content = content.replace('<head>', `<head>${REACT_REFRESH_PREAMBLE}`);
      } else if (content.includes('<html')) {
        // If no <head>, inject after <html...>
        content = content.replace(/<html[^>]*>/, `$&${REACT_REFRESH_PREAMBLE}`);
      } else {
        // Prepend if no html tag
        content = REACT_REFRESH_PREAMBLE + content;
      }

      // Inject HMR client script before </head> or </body>
      if (content.includes('</head>')) {
        content = content.replace('</head>', `${HMR_CLIENT_SCRIPT}</head>`);
      } else if (content.includes('</body>')) {
        content = content.replace('</body>', `${HMR_CLIENT_SCRIPT}</body>`);
      } else {
        // Append at the end if no closing tag found
        content += HMR_CLIENT_SCRIPT;
      }

      const buffer = Buffer.from(content);
      return {
        statusCode: 200,
        statusMessage: 'OK',
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(buffer.length),
          'Cache-Control': 'no-cache',
        },
        body: buffer,
      };
    } catch (error) {
      return this.serverError(error);
    }
  }

}

export default ViteDevServer;

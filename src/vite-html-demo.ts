/**
 * Vite HTML Demo - Minimal Vite-style app with index.html and live reload.
 */

import { VirtualFS } from './virtual-fs';
import { ViteDevServer } from './frameworks/vite-dev-server';
import { getServerBridge } from './server-bridge';
import { Buffer } from './shims/stream';

export const VITE_HTML_DEMO_FILES: Record<string, string> = {
  '/package.json': JSON.stringify(
    {
      name: 'vite-html-browser-demo',
      version: '1.0.0',
      type: 'module',
      scripts: {
        dev: 'vite',
      },
      devDependencies: {
        vite: '^5.0.0',
      },
    },
    null,
    2
  ),
  '/index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vite HTML Demo</title>
  <script type="module" src="./src/main.js"></script>
</head>
<body>
  <main class="shell">
    <p class="eyebrow">almostnode + Vite</p>
    <h1 id="headline">Hello from index.html</h1>
    <p id="message">Edit this HTML file and save to trigger a full page reload.</p>
    <button id="theme-button" type="button">Toggle theme</button>
  </main>
</body>
</html>
`,
  '/theme.js': `export const themes = ['midnight', 'terminal'];

export function getNextTheme(currentTheme) {
  const index = themes.indexOf(currentTheme);
  return themes[(index + 1) % themes.length];
}
`,
  '/src/main.js': `import './style.css';
import { getNextTheme } from '../theme.js';

const root = document.documentElement;
const button = document.getElementById('theme-button');

root.dataset.theme = 'midnight';

button?.addEventListener('click', () => {
  root.dataset.theme = getNextTheme(root.dataset.theme || 'midnight');
});

console.log('Vite HTML demo loaded at', new Date().toLocaleTimeString());
`,
  '/src/style.css': `:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  background: #101214;
  color: #e6f8ee;
}

:root[data-theme="terminal"] {
  background: #04120b;
  color: #b7ffd8;
}

body {
  min-height: 100vh;
  margin: 0;
  display: grid;
  place-items: center;
}

.shell {
  width: min(560px, calc(100vw - 48px));
  padding: 40px;
  border: 1px solid rgba(0, 255, 136, 0.25);
  background: rgba(0, 255, 136, 0.06);
}

.eyebrow {
  margin: 0 0 12px;
  color: #00ff88;
  font: 600 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 16px;
  font-size: clamp(2rem, 8vw, 4rem);
  line-height: 0.95;
}

p {
  line-height: 1.7;
}

button {
  margin-top: 16px;
  border: 0;
  padding: 12px 18px;
  background: #00ff88;
  color: #04120b;
  font-weight: 700;
  cursor: pointer;
}
`,
};

export function createViteHtmlProject(vfs: VirtualFS): void {
  vfs.mkdirSync('/src', { recursive: true });

  for (const [path, content] of Object.entries(VITE_HTML_DEMO_FILES)) {
    vfs.writeFileSync(path, content);
  }
}

export function initViteHtmlDemo(): VirtualFS {
  const vfs = new VirtualFS();
  createViteHtmlProject(vfs);
  return vfs;
}

export async function startViteHtmlDevServer(
  vfs: VirtualFS,
  options: {
    port?: number;
    log?: (message: string) => void;
  } = {}
): Promise<{
  server: ViteDevServer;
  url: string;
  stop: () => void;
}> {
  const port = options.port || 3000;
  const log = options.log || console.log;
  const server = new ViteDevServer(vfs, { port, root: '/' });
  const bridge = getServerBridge();

  try {
    log('Initializing Service Worker...');
    await bridge.initServiceWorker();
    log('Service Worker ready');
  } catch (error) {
    log(`Warning: Service Worker failed to initialize: ${error}`);
  }

  const httpServer = createHttpServerWrapper(server);
  bridge.registerServer(httpServer, port);
  server.start();

  const url = bridge.getServerUrl(port) + '/';
  log(`Dev server running at: ${url}`);

  return {
    server,
    url,
    stop: () => {
      server.stop();
      bridge.unregisterServer(port);
    },
  };
}

function createHttpServerWrapper(devServer: ViteDevServer) {
  return {
    listening: true,
    address: () => ({ port: devServer.getPort(), address: '0.0.0.0', family: 'IPv4' }),
    async handleRequest(
      method: string,
      url: string,
      headers: Record<string, string>,
      body?: string | Buffer
    ) {
      const bodyBuffer = body
        ? typeof body === 'string'
          ? Buffer.from(body)
          : body
        : undefined;
      return devServer.handleRequest(method, url, headers, bodyBuffer);
    },
  };
}

export { VirtualFS, ViteDevServer };

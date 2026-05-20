/**
 * Vite Tailwind Demo - Vite-style app using the @tailwindcss/vite plugin pattern.
 */

import { VirtualFS } from './virtual-fs';
import { ViteDevServer } from './frameworks/vite-dev-server';
import { getServerBridge } from './server-bridge';
import { Buffer } from './shims/stream';

export const VITE_TAILWIND_DEMO_FILES: Record<string, string> = {
  '/package.json': JSON.stringify(
    {
      name: 'vite-tailwind-browser-demo',
      version: '1.0.0',
      type: 'module',
      scripts: {
        dev: 'vite',
      },
      devDependencies: {
        '@tailwindcss/vite': '^4.0.0',
        tailwindcss: '^4.0.0',
        vite: '^5.0.0',
      },
    },
    null,
    2
  ),
  '/vite.config.ts': `import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
  ],
});
`,
  '/index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vite + Tailwind Demo</title>
  <link href="/src/style.css" rel="stylesheet">
  <script type="module" src="./src/main.js"></script>
</head>
<body class="min-h-screen bg-slate-950 text-white antialiased">
  <main class="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-6 py-16">
    <p class="mb-4 text-sm font-semibold uppercase tracking-[0.35em] text-emerald-400">almostnode</p>
    <section class="rounded-3xl border border-emerald-400/20 bg-white/5 p-8 shadow-2xl shadow-emerald-950/40 backdrop-blur">
      <h1 id="headline" class="text-5xl font-black tracking-tight md:text-7xl">
        Vite + Tailwind in the browser
      </h1>
      <p class="mt-6 max-w-2xl text-lg leading-8 text-slate-300">
        This virtual Vite project uses a <code class="rounded bg-slate-900 px-2 py-1 text-emerald-300">vite.config.ts</code>
        with the <code class="rounded bg-slate-900 px-2 py-1 text-emerald-300">tailwindcss()</code> plugin and
        <code class="rounded bg-slate-900 px-2 py-1 text-emerald-300">@import "tailwindcss"</code> in CSS.
      </p>
      <div class="mt-8 flex flex-wrap gap-3">
        <button id="accent-button" class="rounded-full bg-emerald-400 px-5 py-3 font-bold text-slate-950 transition hover:bg-emerald-300">
          Change accent
        </button>
        <span id="status-pill" class="rounded-full border border-white/10 px-5 py-3 text-sm text-slate-300">
          Live reload ready
        </span>
      </div>
    </section>
  </main>
</body>
</html>
`,
  '/src/main.js': `const button = document.getElementById('accent-button');
const pill = document.getElementById('status-pill');
const accents = ['emerald', 'sky', 'fuchsia', 'amber'];
let index = 0;

button?.addEventListener('click', () => {
  index = (index + 1) % accents.length;
  pill.textContent = \`Accent: \${accents[index]}\`;
});

console.log('Vite + Tailwind demo loaded');
`,
  '/src/style.css': `@import "tailwindcss";

html {
  color-scheme: dark;
}

body {
  margin: 0;
}
`,
};

export function createViteTailwindProject(vfs: VirtualFS): void {
  vfs.mkdirSync('/src', { recursive: true });

  for (const [path, content] of Object.entries(VITE_TAILWIND_DEMO_FILES)) {
    vfs.writeFileSync(path, content);
  }
}

export function initViteTailwindDemo(): VirtualFS {
  const vfs = new VirtualFS();
  createViteTailwindProject(vfs);
  return vfs;
}

export async function startViteTailwindDevServer(
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

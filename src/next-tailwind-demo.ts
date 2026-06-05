/**
 * Next.js Tailwind v4 Demo - App Router project using the official PostCSS setup.
 */

import { VirtualFS } from './virtual-fs';
import { NextDevServer } from './frameworks/next-dev-server';
import { getServerBridge } from './server-bridge';
import { Buffer } from './shims/stream';
import { PackageManager } from './npm';

export const NEXT_TAILWIND_DEMO_FILES: Record<string, string> = {
  '/package.json': JSON.stringify(
    {
      name: 'next-tailwind-v4-browser-demo',
      version: '1.0.0',
      type: 'module',
      scripts: {
        dev: 'next dev',
      },
      devDependencies: {
        '@tailwindcss/postcss': '4.3.0',
        postcss: '8.5.15',
        tailwindcss: '4.3.0',
      },
    },
    null,
    2
  ),
  '/postcss.config.mjs': `const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
`,
  '/app/layout.jsx': `import './globals.css';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
  '/app/page.jsx': `export default function Home() {
  return (
    <main className="min-h-screen bg-slate-950 px-8 py-12 text-white">
      <section className="mx-auto max-w-3xl">
        <p className="text-sm font-semibold uppercase tracking-widest text-sky-300">
          almostnode
        </p>
        <h1 className="mt-4 text-5xl font-black tracking-tight">
          Next + Tailwind v4
        </h1>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <div id="brand-card" className="rounded-xl bg-brand-500 p-6 text-slate-950 shadow-lg">
            <p className="text-lg font-bold">CSS-first @theme token</p>
          </div>
          <div id="utility-card" className="rounded-xl bg-sky-500 p-6 text-slate-950 shadow-lg">
            <p className="text-lg font-bold">Generated utility class</p>
          </div>
          <div id="normal-card" className="normal-css-probe rounded-xl p-6 text-slate-950 shadow-lg sm:col-span-2">
            <p className="text-lg font-bold">Plain CSS still reloads too</p>
          </div>
        </div>
      </section>
    </main>
  );
}
`,
  '/app/globals.css': `@import "tailwindcss";

@theme {
  --color-brand-500: oklch(0.72 0.18 150);
}

html {
  color-scheme: dark;
}

body {
  margin: 0;
}

.normal-css-probe {
  background: oklch(0.91 0.08 95);
}
`,
};

export function createNextTailwindProject(vfs: VirtualFS): void {
  vfs.mkdirSync('/app', { recursive: true });

  for (const [path, content] of Object.entries(NEXT_TAILWIND_DEMO_FILES)) {
    vfs.writeFileSync(path, content);
  }
}

export function initNextTailwindDemo(): VirtualFS {
  const vfs = new VirtualFS();
  createNextTailwindProject(vfs);
  return vfs;
}

export async function startNextTailwindDevServer(
  vfs: VirtualFS,
  options: {
    port?: number;
    log?: (message: string) => void;
  } = {}
): Promise<{
  server: NextDevServer;
  url: string;
  stop: () => void;
}> {
  const port = options.port || 3002;
  const log = options.log || console.log;
  const server = new NextDevServer(vfs, { port, root: '/' });
  const bridge = getServerBridge();

  log('Installing Tailwind v4 PostCSS packages from package.json...');
  const packageManager = new PackageManager(vfs, { cwd: '/' });
  await packageManager.installFromPackageJson({
    includeDev: true,
    includeOptional: true,
    onProgress: log,
  });
  server.clearInstalledPackagesCache();
  log('Tailwind packages installed');

  log('Initializing Service Worker...');
  await bridge.initServiceWorker();
  log('Service Worker ready');

  const httpServer = createHttpServerWrapper(server);
  bridge.registerServer(httpServer, port);
  server.start();

  const url = bridge.getServerUrl(port) + '/';
  log(`Next.js Tailwind dev server running at: ${url}`);

  return {
    server,
    url,
    stop: () => {
      server.stop();
      bridge.unregisterServer(port);
    },
  };
}

function createHttpServerWrapper(devServer: NextDevServer) {
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

export { VirtualFS, NextDevServer };

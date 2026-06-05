import { VirtualFS } from '../virtual-fs';

export type TailwindOxideSource = {
  base?: string;
  pattern?: string;
  negated?: boolean;
};

export type TailwindOxideScannerOptions = {
  sources?: TailwindOxideSource[];
};

export interface TailwindOxideScanner {
  files: string[];
  globs: Array<{ base: string; pattern: string; negated?: boolean }>;
  scan(): string[];
}

export type TailwindOxideShim = {
  Scanner: new (options?: TailwindOxideScannerOptions) => TailwindOxideScanner;
};

function defaultNormalizePath(path: string): string {
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

export function createTailwindOxideShim(
  vfs: VirtualFS,
  normalizePath: (path: string) => string = defaultNormalizePath
): TailwindOxideShim {
  class Scanner implements TailwindOxideScanner {
    files: string[] = [];
    globs: Array<{ base: string; pattern: string; negated?: boolean }> = [];
    private sources: Array<{ base: string; pattern: string; negated?: boolean }>;

    constructor(options: TailwindOxideScannerOptions = {}) {
      this.sources = (options.sources || [])
        .filter((source) => !source.negated)
        .map((source) => ({
          base: normalizePath(source.base || '/'),
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
          this.scanPath(normalizePath(`${path}/${entry}`), candidates);
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

/**
 * Import a browser-external module URL without letting host bundlers rewrite it.
 *
 * Vite honors /* @vite-ignore *\/ comments, but Turbopack still transforms
 * external dynamic imports in library code into its own client loader. CDN ESM
 * URLs must remain native browser imports at runtime.
 */
type ExternalImporter = (specifier: string) => Promise<unknown>;

const externalImport = new Function(
  'specifier',
  'return import(specifier)'
) as ExternalImporter;

export async function importExternalModule<T>(specifier: string): Promise<T> {
  return (await externalImport(specifier)) as T;
}

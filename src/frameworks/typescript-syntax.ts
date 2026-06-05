/**
 * Strip the small TypeScript syntax subset that appears in framework config files
 * before parsing them as plain JavaScript.
 */
export function stripTypescriptSyntax(content: string): string {
  let result = content;

  // Remove import type statements, e.g. import type { Config } from "next".
  result = result.replace(/import\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]*['"]\s*;?\s*/g, '');

  // Remove regular named imports that are only used as types in config files.
  result = result.replace(/import\s+\{[^}]*\}\s+from\s+['"][^'"]*['"]\s*;?\s*/g, '');

  // Remove satisfies assertions, e.g. } satisfies NextConfig.
  result = result.replace(/\s+satisfies\s+\w+\s*$/gm, '');
  result = result.replace(/\s+satisfies\s+\w+\s*;?\s*$/gm, '');

  // Remove simple type annotations on variable declarations.
  result = result.replace(/:\s*[A-Z]\w*\s*=/g, ' =');

  // Remove const assertions.
  result = result.replace(/\s+as\s+const\s*/g, ' ');

  return result;
}

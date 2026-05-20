import { Buffer } from './stream';

export const Features = {
  Nesting: 1 << 0,
  MediaQueries: 1 << 1,
  LogicalProperties: 1 << 2,
  DirSelector: 1 << 3,
  LightDark: 1 << 4,
};

export function transform(options: { code: Uint8Array | string }): {
  code: Buffer;
  map: null;
  warnings: Array<{ message: string; loc: { line: number; column: number } }>;
} {
  const code = typeof options.code === 'string'
    ? options.code
    : Buffer.from(options.code).toString();

  return {
    code: Buffer.from(code),
    map: null,
    warnings: [],
  };
}

export function browserslistToTargets(): Record<string, number> {
  return {};
}

export default {
  Features,
  transform,
  browserslistToTargets,
};

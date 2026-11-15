// Just enough of Node's fs and path for the CSS guard tests (theme.test.ts); no @types/node dependency.
declare module 'node:fs' {
  export function readdirSync(dir: string): string[];
  export function readFileSync(file: string, encoding: 'utf8'): string;
  export function statSync(file: string): { isDirectory(): boolean };
}
declare module 'node:path' {
  const path: {
    sep: string;
    resolve(...parts: string[]): string;
    join(...parts: string[]): string;
    relative(from: string, to: string): string;
  };
  export default path;
}
declare const __dirname: string;

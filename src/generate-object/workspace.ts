import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

export function prepareWorkspace(key: string, bamlFile: string) {
  const base = resolve(tmpdir(), 'baml-runtime-cache');
  const dir = resolve(base, key);
  const srcDir = resolve(dir, 'baml_src');
  if (!existsSync(srcDir)) {
    mkdirSync(srcDir, { recursive: true });
  }
  writeFileSync(resolve(srcDir, 'schema.baml'), bamlFile, 'utf8');
  return dir;
}

export function findBinUp(startDir: string, binName: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, 'node_modules', '.bin', binName);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}


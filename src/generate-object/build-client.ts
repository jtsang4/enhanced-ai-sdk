import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createJiti } from 'jiti';
import { execFile } from './exec';
import { dlog } from './debug';

export async function buildAndLoadBamlClient(workspace: string) {
  const clientDir = resolve(workspace, 'baml_client');
  if (!existsSync(clientDir)) {
    const req = createRequire(import.meta.url);
    const reqCwd = (() => {
      try {
        return createRequire(resolve(process.cwd(), 'package.json'));
      } catch {
        return null;
      }
    })();

    const resolveBamlEntry = (): string => {
      try {
        return req.resolve('@boundaryml/baml');
      } catch {
        if (reqCwd) {
          try {
            return reqCwd.resolve('@boundaryml/baml');
          } catch {}
        }
        throw new Error(
          "Unable to resolve '@boundaryml/baml'. Make sure it is installed.",
        );
      }
    };

    const bamlEntry = resolveBamlEntry();
    dlog('Resolved @boundaryml/baml entry:', bamlEntry);

    // Walk up to find the package.json for @boundaryml/baml
    let dir = dirname(bamlEntry);
    let pkgJsonPath = '';
    let pkg: any = null;
    for (let i = 0; i < 8; i++) {
      const candidate = resolve(dir, 'package.json');
      if (existsSync(candidate)) {
        try {
          const json = JSON.parse(readFileSync(candidate, 'utf8')) as any;
          if (json?.name === '@boundaryml/baml') {
            pkgJsonPath = candidate;
            pkg = json;
            break;
          }
        } catch {}
      }
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }

    if (!pkg || !pkgJsonPath) {
      throw new Error("Could not locate package.json for '@boundaryml/baml'.");
    }

    const pkgDir = dirname(pkgJsonPath);
    const bin = (pkg as any).bin;

    let binRel: string | null = null;
    if (typeof bin === 'string') {
      binRel = bin;
    } else if (bin && typeof bin === 'object') {
      binRel =
        bin['baml-cli'] ||
        bin['baml'] ||
        (Object.keys(bin)[0] ? bin[Object.keys(bin)[0]] : null);
    }

    if (!binRel) {
      throw new Error(
        "'bin' field not found or invalid in '@boundaryml/baml' package.json.",
      );
    }

    const cliEntry = resolve(pkgDir, binRel);
    if (!existsSync(cliEntry)) {
      throw new Error(`Resolved CLI entry does not exist: ${cliEntry}`);
    }
    dlog('Executing BAML CLI (from bin in package.json):', cliEntry);

    // Always run the JS CLI with Node
    await execFile(
      process.execPath,
      [cliEntry, 'generate', '--from', './baml_src'],
      workspace,
    );
  }
  const cjsPath = resolve(clientDir, 'index.cjs');
  const jsPath = resolve(clientDir, 'index.js');
  const tsPath = resolve(clientDir, 'index.ts');
  const req2 = createRequire(import.meta.url);
  let mod: any = null;

  // Prefer TS/TSX first so that JITI alias can map '@boundaryml/baml' to the consumer's node_modules
  if (existsSync(tsPath)) {
    const alias: Record<string, string> = {};
    try {
      alias['@boundaryml/baml'] = req2.resolve('@boundaryml/baml');
    } catch {}
    const j = createJiti(import.meta.url, {
      interopDefault: true,
      esmResolve: true,
      alias,
    } as any);
    mod = j(tsPath);
  } else {
    // Fall back to index.tsx if it exists (some versions may emit tsx)
    const tsxPath = resolve(clientDir, 'index.tsx');
    if (existsSync(tsxPath)) {
      const alias: Record<string, string> = {};
      try {
        alias['@boundaryml/baml'] = req2.resolve('@boundaryml/baml');
      } catch {}
      const j = createJiti(import.meta.url, {
        interopDefault: true,
        esmResolve: true,
        alias,
      } as any);
      mod = j(tsxPath);
    } else if (existsSync(cjsPath)) {
      // Load CJS if present
      mod = req2(cjsPath);
    } else if (existsSync(jsPath)) {
      // Load ESM JS if present
      mod = await import(jsPath);
    } else {
      throw new Error('BAML client not found (no index.ts/tsx/cjs/js)');
    }
  }
  return (mod as any).b || mod;
}

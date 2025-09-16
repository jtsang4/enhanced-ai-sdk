import { execFile as _execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { generateText } from 'ai';
import jiti from 'jiti';
import { z } from 'zod';

const execFile = (file: string, args: string[], cwd: string) =>
  new Promise<void>((resolveP, rejectP) => {
    const proc = _execFile(file, args, { cwd }, (err) => {
      if (err) rejectP(err);
      else resolveP();
    });
    proc.stdout?.pipe(process.stdout);
    proc.stderr?.pipe(process.stderr);
  });

// Public API (compatible with Vercel AI SDK generateObject inputs/outputs at high level)
export interface GenerateObjectCompatOptions<S extends z.ZodType = z.ZodType> {
  model: any; // same as Vercel AI SDK model
  schema: S; // Zod schema
  prompt?: string;
  messages?: any[];
  // passthrough options
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

export interface GenerateObjectCompatResult<T> {
  object: T;
  text: string;
  usage?: any;
  finishReason?: any;
}

export async function generateObjectCompat<S extends z.ZodType>(
  opts: GenerateObjectCompatOptions<S>,
): Promise<GenerateObjectCompatResult<z.infer<S>>> {
  const { schema, model } = opts;
  if (!schema) {
    throw new Error('schema is required');
  }

  const { bamlFile, funcName } = buildBamlFromZod(schema);
  const cacheKey = createHash('sha256').update(bamlFile).digest('hex');
  const workspace = prepareWorkspace(cacheKey, bamlFile);
  const client = await buildAndLoadBamlClient(workspace);

  // Build a JSON-only instruction to help the LLM output valid JSON
  const jsonHint = buildJsonHint(schema);

  const textRes = await generateText({
    model,
    ...(opts.prompt ? { prompt: `${jsonHint}\n\n${opts.prompt}` } : {}),
    ...(opts.messages
      ? {
          messages: mergeJsonHintIntoMessages(jsonHint, opts.messages as any[]),
        }
      : {}),
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    topP: opts.topP,
  } as any);

  const text = (textRes as any).text ?? (textRes as any).output_text ?? '';
  if (!text) throw new Error('generateText returned empty text');

  const parsed = client.parse[funcName](text) as z.infer<S>;
  return {
    object: parsed,
    text,
    usage: (textRes as any).usage,
    finishReason: (textRes as any).finishReason,
  };
}

// ----- Helpers -----

function buildBamlFromZod(schema: z.ZodType) {
  const ctx: Ctx = {
    types: new Map(),
    order: [],
    enums: new Map(),
    aliases: new Map(),
    counter: 0,
  };
  const rootName = 'Root';
  const rootType = toBamlType(schema, ctx, rootName);

  const funcName = 'Gen' + rootName;
  const header = `generator typescript {\n  output_type "typescript"\n  module_format "cjs"\n}\n`;
  const types = renderTypes(ctx);
  const func = `function ${funcName}(input: string) -> ${rootType} {\n  client "openai/gpt-5"\n  prompt #"\n    {{ input }}\n    {{ ctx.output_format }}\n  "#\n}\n`;
  const bamlFile = [header, types, func].join('\n');
  return { bamlFile, funcName, rootType };
}

type Ctx = {
  types: Map<string, ClassType>;
  order: string[]; // class names in declaration order
  enums: Map<string, string[]>; // enumName -> values (identifier-safe)
  aliases: Map<string, string>; // name -> type expr
  counter: number;
};

function getKind(s: any): string {
  const def = s?._def;
  if (!def) return 'Unknown';
  const K: any = (z as any).ZodFirstPartyTypeKind;
  const tn = def.typeName ?? s.typeName;
  if (K && typeof K === 'object') {
    for (const key of Object.keys(K)) {
      if (K[key] === tn) return key;
    }
  }
  const guess = String(tn);
  const m = guess.match(/Zod[A-Za-z]+/);
  return m ? m[0] : kindOf(s);
}

function unwrapAll(s: any) {
  let schema = s;
  let optional = false;
  let nullable = false;
  for (let i = 0; i < 50; i++) {
    const k = getKind(schema);
    const def = schema?._def ?? {};
    if (k === 'ZodOptional') {
      optional = true;
      schema = def.innerType ?? def.type ?? schema;
      continue;
    }
    if (k === 'ZodNullable') {
      nullable = true;
      schema = def.innerType ?? def.type ?? schema;
      continue;
    }
    if (k === 'ZodDefault' || k === 'ZodCatch' || k === 'ZodReadonly') {
      schema = def.innerType ?? def.type ?? schema;
      continue;
    }
    if (k === 'ZodBranded') {
      schema = def.type ?? schema;
      continue;
    }
    if (k === 'ZodEffects') {
      schema = def.schema ?? schema;
      continue;
    }
    if (k === 'ZodPipeline') {
      schema = def.out ?? def.in ?? schema;
      continue;
    }
    break;
  }
  return { base: schema, optional, nullable };
}

type ClassType = {
  name: string;
  fields: {
    name: string;
    type: string;
    optional?: boolean;
    description?: string;
  }[];
};

function toBamlType(schema: z.ZodType, ctx: Ctx, hintName?: string): string {
  const { base } = unwrapAll(schema);
  const def = (base as any)._def;
  const k = getKind(base);
  // debug
  // console.debug('toBamlType kind:', k, 'def keys:', Object.keys(def || {}));
  switch (k) {
    case 'ZodObject': {
      const name = uniqueClassName(ctx, hintName || 'Obj');
      const shapeObj =
        typeof def.shape === 'function' ? def.shape() : def.shape;
      const fields: ClassType['fields'] = [];
      for (const key of Object.keys(shapeObj)) {
        const fieldSchema = shapeObj[key];
        const { base, optional, description } = unwrapModifiers(fieldSchema);
        fields.push({
          name: key,
          type: toBamlType(base, ctx, `${name}_${key}`),
          optional,
          description,
        });
      }
      ctx.types.set(name, { name, fields });
      ctx.order.push(name);
      return name;
    }
    case 'ZodString':
      return 'string';
    case 'ZodNumber': {
      const checks: any[] = def.checks || [];
      const isInt = checks.some((c) => c.kind === 'int');
      return isInt ? 'int' : 'float';
    }
    case 'ZodBoolean':
      return 'bool';
    case 'ZodNull':
      return 'null';
    case 'ZodArray': {
      // Zod v4 stores element schema at def.type (primary), but try other common keys too
      let innerSchema =
        (def as any).type ??
        (def as any).items ??
        (def as any).item ??
        (def as any).element ??
        (def as any).itemType;
      if (typeof innerSchema === 'function') {
        innerSchema = innerSchema();
      }
      const innerUnwrapped = innerSchema
        ? unwrapAll(innerSchema).base
        : undefined;
      const inner =
        innerUnwrapped && innerUnwrapped._def
          ? toBamlType(
              innerUnwrapped,
              ctx,
              hintName ? hintName + 'Item' : undefined,
            )
          : 'string';
      return `${parenIfUnion(inner)}[]`;
    }
    case 'ZodEnum': {
      const values: string[] = def.values;
      const idSafe = values.every(isIdentifier);
      const name = uniqueAliasOrEnumName(ctx, hintName || 'Enum');
      if (idSafe) {
        ctx.enums.set(name, values);
        return name;
      } else {
        ctx.aliases.set(name, values.map((v) => JSON.stringify(v)).join(' | '));
        return name;
      }
    }
    case 'ZodNativeEnum': {
      const values = Object.values(def.values).filter(
        (v) => typeof v === 'string',
      ) as string[];
      const name = uniqueAliasOrEnumName(ctx, hintName || 'Enum');
      const idSafe = values.every(isIdentifier);
      if (idSafe) ctx.enums.set(name, values);
      else
        ctx.aliases.set(name, values.map((v) => JSON.stringify(v)).join(' | '));
      return name;
    }
    case 'ZodRecord': {
      const keyType = def.keyType ?? z.string();
      const valType = def.valueType;
      const k = toBamlType(
        keyType,
        ctx,
        hintName ? hintName + 'Key' : undefined,
      );
      const v = toBamlType(
        valType,
        ctx,
        hintName ? hintName + 'Val' : undefined,
      );
      return `map<${k}, ${v}>`;
    }
    case 'ZodUnion': {
      const options: z.ZodType[] = def.options as any[];
      const parts = options.map((o, i) =>
        toBamlType(o, ctx, hintName ? hintName + 'U' + i : undefined),
      );
      return parts.join(' | ');
    }
    case 'ZodLazy': {
      const getter: () => z.ZodType = def.getter;
      return toBamlType(getter(), ctx, hintName);
    }
    default: {
      const inner =
        (def as any)?.innerType ??
        (def as any)?.schema ??
        (def as any)?.type ??
        (def as any)?.out ??
        (def as any)?.output;
      if (inner) {
        return toBamlType(inner, ctx, hintName);
      }
      throw new Error(`Unsupported Zod type: ${k}`);
    }
  }
}

function unwrapModifiers(s: z.ZodType) {
  const u = unwrapAll(s);
  const description = (s as any).description as string | undefined;
  return {
    base: u.base,
    optional: u.optional,
    nullable: u.nullable,
    description,
  };
}

function renderTypes(ctx: Ctx): string {
  const lines: string[] = [];
  ctx.enums.forEach((values, name) => {
    lines.push(`enum ${name} {`);
    values.forEach((v) => {
      lines.push(`  ${v}`);
    });
    lines.push('}');
  });
  ctx.aliases.forEach((expr, name) => {
    lines.push(`type ${name} = ${expr}`);
  });
  ctx.order.forEach((name) => {
    const cls = ctx.types.get(name)!;
    lines.push(`class ${cls.name} {`);
    cls.fields.forEach((f) => {
      const desc = f.description
        ? ` @description(${JSON.stringify(f.description)})`
        : '';
      lines.push(`  ${f.name} ${f.type}${f.optional ? '?' : ''}${desc}`);
    });
    lines.push('}');
  });
  return lines.join('\n');
}

function uniqueClassName(ctx: Ctx, base: string) {
  const clean = toPascal(base);
  let name = clean;
  while (ctx.types.has(name)) name = clean + ++ctx.counter;
  return name;
}
function uniqueAliasOrEnumName(ctx: Ctx, base: string) {
  const clean = toPascal(base);
  let name = clean;
  while (ctx.enums.has(name) || ctx.aliases.has(name))
    name = clean + ++ctx.counter;
  return name;
}
function toPascal(s: string) {
  return s
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}
function isIdentifier(s: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}
function parenIfUnion(expr: string) {
  return expr.includes('|') ? `(${expr})` : expr;
}

function kindOf(s: any): string {
  if (!s) {
    return 'Unknown';
  }
  const Z: any = z as any;
  const table: Array<[string, any]> = [
    ['ZodObject', Z.ZodObject],
    ['ZodString', Z.ZodString],
    ['ZodNumber', Z.ZodNumber],
    ['ZodBoolean', Z.ZodBoolean],
    ['ZodNull', Z.ZodNull],
    ['ZodArray', Z.ZodArray],
    ['ZodOptional', Z.ZodOptional],
    ['ZodNullable', Z.ZodNullable],
    ['ZodEnum', Z.ZodEnum],
    ['ZodNativeEnum', Z.ZodNativeEnum],
    ['ZodRecord', Z.ZodRecord],
    ['ZodUnion', Z.ZodUnion],
    ['ZodLazy', Z.ZodLazy],
    // common wrappers in zod v4
    ['ZodDefault', Z.ZodDefault],
    ['ZodCatch', Z.ZodCatch],
    ['ZodEffects', Z.ZodEffects],
    ['ZodBranded', Z.ZodBranded],
    ['ZodReadonly', Z.ZodReadonly],
    ['ZodPipeline', Z.ZodPipeline],
  ];
  for (const [name, C] of table) {
    if (C && s instanceof C) return name;
  }
  const tn = s?._def?.typeName ?? s?.typeName;
  if (tn != null) {
    if (typeof tn === 'string') {
      return tn as string;
    }
    const K = (z as any).ZodFirstPartyTypeKind;
    if (K && typeof K === 'object') {
      for (const key of Object.keys(K)) {
        if ((K as any)[key] === tn) {
          return key;
        }
      }
    }
    const guess = String(tn);
    const m = guess.match(/Zod[A-Za-z]+/);
    if (m) {
      return m[0];
    }
  }
  const cn = s?.constructor?.name;
  if (typeof cn === 'string' && cn.startsWith('Zod')) {
    return cn;
  }
  return 'Unknown';
}

function prepareWorkspace(key: string, bamlFile: string) {
  const base = resolve(tmpdir(), 'baml-runtime-cache');
  const dir = resolve(base, key);
  const srcDir = resolve(dir, 'baml_src');
  if (!existsSync(srcDir)) {
    mkdirSync(srcDir, { recursive: true });
  }
  writeFileSync(resolve(srcDir, 'schema.baml'), bamlFile, 'utf8');
  return dir;
}

async function buildAndLoadBamlClient(workspace: string) {
  const clientDir = resolve(workspace, 'baml_client');
  if (!existsSync(clientDir)) {
    // Resolve CLI from the installed @boundaryml/baml package reliably
    const req = createRequire(import.meta.url);
    let cliEntry: string | null = null;
    try {
      cliEntry = req.resolve('@boundaryml/baml/cli.js');
    } catch {
      // Fallback: try relative to CWD (consumer project)
      const candidate = resolve(
        process.cwd(),
        'node_modules',
        '@boundaryml',
        'baml',
        'cli.js',
      );
      cliEntry = existsSync(candidate) ? candidate : null;
    }
    if (cliEntry) {
      await execFile(
        process.execPath,
        [cliEntry, 'generate', '--from', './baml_src'],
        workspace,
      );
    } else {
      // Last resorts: local bin or npx
      const bin = process.platform === 'win32' ? 'baml-cli.cmd' : 'baml-cli';
      try {
        await execFile(bin, ['generate', '--from', './baml_src'], workspace);
      } catch {
        await execFile(
          process.platform === 'win32' ? 'npx.cmd' : 'npx',
          ['-y', 'baml-cli', 'generate', '--from', './baml_src'],
          workspace,
        );
      }
    }
  }
  const cjsPath = resolve(clientDir, 'index.cjs');
  const jsPath = resolve(clientDir, 'index.js');
  const tsPath = resolve(clientDir, 'index.ts');
  const req2 = createRequire(import.meta.url);
  let mod: any = null;
  if (existsSync(cjsPath)) {
    mod = req2(cjsPath);
  } else if (existsSync(jsPath)) {
    mod = await import(jsPath);
  } else if (existsSync(tsPath)) {
    const alias: Record<string, string> = {};
    try {
      alias['@boundaryml/baml'] = req2.resolve('@boundaryml/baml');
    } catch {}
    const j = jiti(import.meta.url, {
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
      const j = jiti(import.meta.url, {
        interopDefault: true,
        esmResolve: true,
        alias,
      } as any);
      mod = j(tsxPath);
    } else {
      throw new Error('BAML client not found (no index.cjs/js/ts)');
    }
  }
  return (mod as any).b || mod;
}

function buildJsonHint(schema: z.ZodType): string {
  // Lightweight, model-friendly instruction
  return `You are to output ONLY valid JSON with no extra text. The JSON must match the following structure: ${describeSchema(schema)}.`;
}

function describeSchema(s: z.ZodType): string {
  const { base } = unwrapAll(s);
  const def = (base as any)._def;
  switch (getKind(base)) {
    case 'ZodObject': {
      const shapeObj =
        typeof def.shape === 'function' ? def.shape() : def.shape;
      const parts = Object.keys(shapeObj).map((k) => {
        const field = shapeObj[k];
        const { base, optional } = unwrapModifiers(field);
        return `${k}${optional ? '?' : ''}: ${describeSchema(base)}`;
      });
      return `{ ${parts.join(', ')} }`;
    }
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodArray': {
      const innerSchema =
        (def as any).type ?? (def as any).element ?? (def as any).itemType;
      return `${describeSchema(unwrapAll(innerSchema).base)}[]`;
    }
    case 'ZodEnum':
      return (def.values as string[])
        .map((v: string) => JSON.stringify(v))
        .join(' | ');
    case 'ZodUnion':
      return (def.options as z.ZodType[]).map(describeSchema).join(' | ');
    case 'ZodRecord':
      return `{ [key: string]: ${describeSchema(def.valueType)} }`;
    case 'ZodNullable':
      return `${describeSchema(def.innerType)} | null`;
    case 'ZodOptional':
      return describeSchema(def.innerType);
    default:
      return 'unknown';
  }
}

function mergeJsonHintIntoMessages(hint: string, messages: any[]): any[] {
  const first = messages[0];
  if (!first) return [{ role: 'system', content: hint }];
  if ((first as any).role === 'system') {
    return [
      { ...first, content: `${first.content}\n\n${hint}` },
      ...messages.slice(1),
    ];
  }
  return [{ role: 'system', content: hint }, ...messages];
}

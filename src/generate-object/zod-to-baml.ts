import { z } from 'zod';

export function buildBamlFromZod(schema: z.ZodType) {
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

export type Ctx = {
  types: Map<string, ClassType>;
  order: string[]; // class names in declaration order
  enums: Map<string, string[]>; // enumName -> values (identifier-safe)
  aliases: Map<string, string>; // name -> type expr
  counter: number;
};

export function getKind(s: any): string {
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

export function unwrapAll(s: any) {
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

export type ClassType = {
  name: string;
  fields: {
    name: string;
    type: string;
    optional?: boolean;
    description?: string;
  }[];
};

export function toBamlType(
  schema: z.ZodType,
  ctx: Ctx,
  hintName?: string,
): string {
  const { base } = unwrapAll(schema);
  const def = (base as any)._def;
  const k = getKind(base);
  switch (k) {
    case 'ZodObject': {
      const name = uniqueClassName(ctx, hintName || 'Obj');
      const shapeObj =
        typeof def.shape === 'function' ? def.shape() : def.shape;
      const fields: ClassType['fields'] = [];
      for (const key of Object.keys(shapeObj)) {
        const fieldSchema = shapeObj[key];
        const { base, optional, nullable, description } =
          unwrapModifiers(fieldSchema);
        const innerType = toBamlType(base, ctx, `${name}_${key}`);
        const type = nullable ? `${parenIfUnion(innerType)} | null` : innerType;
        fields.push({
          name: key,
          type,
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
    case 'ZodLiteral': {
      const val = (def as any)?.value;
      const t = typeof val;
      if (t === 'string') return 'string';
      if (t === 'number') return Number.isInteger(val) ? 'int' : 'float';
      if (t === 'boolean') return 'bool';
      // Fallback to string for other literal types
      return 'string';
    }
    case 'ZodNull':
      return 'null';
    case 'ZodArray': {
      // Zod v4 stores element schema at def.type (primary), but try other common keys too
      let innerSchema =
        (def as any).element ??
        (def as any).type ??
        (def as any).items ??
        (def as any).item ??
        (def as any).itemType;
      if (typeof innerSchema === 'function') {
        innerSchema = innerSchema();
      }
      if ((process as any)?.env?.DEBUG_BAML) {
        try {
          const keys = Object.keys(def || {});
          const kind = innerSchema ? getKind(innerSchema as any) : 'undefined';
          console.log('[DEBUG_BAML] ZodArray inner:', { keys, kind });
        } catch {}
      }
      const innerUnwrapped = innerSchema
        ? unwrapAll(innerSchema).base
        : undefined;
      const inner =
        innerUnwrapped && (innerUnwrapped as any)._def
          ? toBamlType(
              innerUnwrapped as any,
              ctx,
              hintName ? hintName + 'Item' : undefined,
            )
          : 'string';
      return `${parenIfUnion(inner)}[]`;
    }
    case 'ZodEnum': {
      const rawValues =
        (def as any)?.values ?? (def as any)?.options ?? (base as any)?.options;
      const values: string[] = Array.isArray(rawValues)
        ? (rawValues as string[])
        : [];
      if (values.length === 0) {
        // Fallback: treat as plain string when enum values cannot be determined
        return 'string';
      }
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
      const values = Object.values((def as any)?.values ?? {}).filter(
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

export function unwrapModifiers(s: z.ZodType) {
  const u = unwrapAll(s);
  const description = (s as any).description as string | undefined;
  return {
    base: u.base,
    optional: u.optional,
    nullable: u.nullable,
    description,
  };
}

export function renderTypes(ctx: Ctx): string {
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

export function uniqueClassName(ctx: Ctx, base: string) {
  const clean = toPascal(base);
  let name = clean;
  while (ctx.types.has(name)) name = clean + ++ctx.counter;
  return name;
}
export function uniqueAliasOrEnumName(ctx: Ctx, base: string) {
  const clean = toPascal(base);
  let name = clean;
  while (ctx.enums.has(name) || ctx.aliases.has(name))
    name = clean + ++ctx.counter;
  return name;
}
export function toPascal(s: string) {
  return s
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}
export function isIdentifier(s: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}
export function parenIfUnion(expr: string) {
  return expr.includes('|') ? `(${expr})` : expr;
}

export function kindOf(s: any): string {
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

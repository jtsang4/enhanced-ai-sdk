import { z } from 'zod';
import { unwrapAll, getKind } from './zod-to-baml';

export function buildJsonHint(schema: z.ZodType): string {
  // Lightweight, model-friendly instruction
  return `You are to output ONLY valid JSON with no extra text. The JSON must match the following structure: ${describeSchema(schema)}.`;
}

export function describeSchema(s: z.ZodType): string {
  const { base } = unwrapAll(s);
  const def = (base as any)._def;
  switch (getKind(base)) {
    case 'ZodObject': {
      const shapeObj =
        typeof def.shape === 'function' ? def.shape() : def.shape;
      const parts = Object.keys(shapeObj).map((k) => {
        const field = shapeObj[k];
        const { base, optional } = unwrapAll(field);
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
      let innerSchema =
        (def as any).element ??
        (def as any).type ??
        (def as any).items ??
        (def as any).item ??
        (def as any).itemType;
      if (typeof innerSchema === 'function') innerSchema = innerSchema();
      return `${describeSchema(unwrapAll(innerSchema).base)}[]`;
    }
    case 'ZodEnum': {
      const rawValues =
        (def as any)?.values ?? (def as any)?.options ?? (base as any)?.options;
      const values: string[] = Array.isArray(rawValues)
        ? (rawValues as string[])
        : [];
      return values.length
        ? values.map((v) => JSON.stringify(v)).join(' | ')
        : 'string';
    }
    case 'ZodNativeEnum': {
      const values = Object.values((def as any)?.values ?? {}).filter(
        (v) => typeof v === 'string',
      ) as string[];
      return values.length
        ? values.map((v) => JSON.stringify(v)).join(' | ')
        : 'string';
    }
    case 'ZodLiteral': {
      const val = (def as any)?.value;
      return JSON.stringify(val);
    }
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

export function mergeJsonHintIntoMessages(
  hint: string,
  messages: any[],
): any[] {
  const first = messages[0];
  if (!first) {
    return [{ role: 'system', content: hint }];
  }
  if ((first as any).role === 'system') {
    return [
      { ...first, content: `${first.content}\n\n${hint}` },
      ...messages.slice(1),
    ];
  }
  return [{ role: 'system', content: hint }, ...messages];
}

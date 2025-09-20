import { createOpenAI } from '@ai-sdk/openai';
import { expect, test } from '@rstest/core';
import dotenv from 'dotenv';
import { z } from 'zod';
import { generateObjectCompat } from '../src/index';

dotenv.config();

const getOpenAI = () => {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY missing; tests require real model calls.');
  }
  return createOpenAI({ apiKey, baseURL });
};

// 1) Mixed primitives, arrays, optional & nullable
test('generateObjectCompat handles number/int/boolean/array/optional/nullable', async () => {
  const openai = getOpenAI();
  const schema = z.object({
    id: z.number().int(),
    rating: z.number(),
    isActive: z.boolean(),
    tags: z.array(z.string()).min(1),
    maybe: z.string().optional(),
    nick: z.string().nullable(),
  });

  const res = await generateObjectCompat({
    model: openai.chat(process.env.OPENAI_MODEL_ID!),
    schema,
    prompt:
      'Return JSON with an integer id, a float rating, a boolean isActive, a non-empty array of string tags, an optional string maybe, and a nullable string nick.',
  });

  const o = res.object;
  expect(typeof o.id).toBe('number');
  expect(Number.isInteger(o.id)).toBe(true);
  expect(typeof o.rating).toBe('number');
  expect(typeof o.isActive).toBe('boolean');
  expect(Array.isArray(o.tags)).toBe(true);
  expect(o.tags.length >= 1).toBe(true);
  if (o.maybe !== undefined) {
    expect(typeof o.maybe).toBe('string');
  }
  expect(o.nick === null || typeof o.nick === 'string').toBe(true);
});

// 2) Enum and NativeEnum
enum Role {
  Admin = 'Admin',
  User = 'User',
}

test('generateObjectCompat handles enum and native enum', async () => {
  const openai = getOpenAI();
  const schema = z.object({
    role: z.nativeEnum(Role),
    area: z.enum([
      'North America',
      'South America',
      'Europe',
      'Asia',
      'Africa',
      'Oceania',
    ]),
  });

  const res = await generateObjectCompat({
    model: openai.chat(process.env.OPENAI_MODEL_ID!),
    schema,
    prompt:
      'Choose role from ["Admin","User"]. Choose area from the given list of continents or regions.',
  });

  const o = res.object;
  expect(o.role === 'Admin' || o.role === 'User').toBe(true);
  const areas = [
    'North America',
    'South America',
    'Europe',
    'Asia',
    'Africa',
    'Oceania',
  ];
  expect(areas.includes(o.area)).toBe(true);
});

// 3) Record types (maps)

test('generateObjectCompat handles record<string, number> and optional record<string, boolean>', async () => {
  const openai = getOpenAI();
  const schema = z.object({
    metrics: z.record(z.string(), z.number()),
    flags: z.record(z.string(), z.boolean()).optional(),
  });

  const res = await generateObjectCompat({
    model: openai.chat(process.env.OPENAI_MODEL_ID!),
    schema,
    prompt:
      'Provide metrics with 2 numeric key-value pairs (e.g., {"views": 123, "likes": 45}). Optionally include flags (boolean values).',
  });

  const o = res.object as {
    metrics: Record<string, number>;
    flags?: Record<string, boolean>;
  };
  expect(typeof o.metrics).toBe('object');
  const entries = Object.entries(o.metrics);
  expect(entries.length >= 1).toBe(true);
  for (const [, v] of entries) expect(typeof v).toBe('number');
  if (o.flags) {
    for (const [, v] of Object.entries(o.flags))
      expect(typeof v).toBe('boolean');
  }
});

// 4) Array of simple strings (array handling)

test('generateObjectCompat handles array of strings', async () => {
  const openai = getOpenAI();
  const schema = z.object({
    items: z.array(z.string()).min(2),
  });

  const res = await generateObjectCompat({
    model: openai.chat(process.env.OPENAI_MODEL_ID!),
    schema,
    prompt: 'Return at least two string items in an array.',
  });

  const o = res.object as { items: string[] };
  expect(Array.isArray(o.items)).toBe(true);
  expect(o.items.length >= 2).toBe(true);
  for (const it of o.items) {
    expect(typeof it).toBe('string');
  }
});

// 5) Union types

test('generateObjectCompat handles simple discriminated union', async () => {
  const openai = getOpenAI();
  const VariantA = z.object({ type: z.literal('A'), value: z.number() });
  const VariantB = z.object({ type: z.literal('B'), value: z.string() });

  const schema = z.union([VariantA, VariantB]);

  const res = await generateObjectCompat({
    model: openai.chat(process.env.OPENAI_MODEL_ID!),
    schema,
    prompt:
      'Return either {"type":"A","value": <number>} or {"type":"B","value": <string>}. Choose one and be consistent.',
  });

  const o = res.object as any;
  expect(o.type === 'A' || o.type === 'B').toBe(true);
  if (o.type === 'A') expect(typeof o.value).toBe('number');
  if (o.type === 'B') expect(typeof o.value).toBe('string');
});

// 6) Array of objects (robust parsing)

test('generateObjectCompat handles array of objects (robust)', async () => {
  const openai = getOpenAI();
  const schema = z.object({
    items: z
      .array(z.object({ name: z.string(), count: z.number().int() }))
      .min(2),
  });

  const res = await generateObjectCompat({
    model: openai.chat(process.env.OPENAI_MODEL_ID!),
    schema,
    prompt:
      'Return at least two items. Each item must be an object with exactly these keys: "name" (string) and "count" (integer). Do not add extra keys. Ensure "name" is present for every item.',
  });

  const o = res.object as { items: Array<{ name: string; count: number }> };
  console.log('robust-array-of-objects object:', JSON.stringify(o, null, 2));
  console.log('robust-array-of-objects text:', res.text);
  expect(Array.isArray(o.items)).toBe(true);
  expect(o.items.length >= 2).toBe(true);
  for (const it of o.items) {
    expect(typeof it.name).toBe('string');
    expect(Number.isInteger(it.count)).toBe(true);
  }
});

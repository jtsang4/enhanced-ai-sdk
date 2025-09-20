import { createOpenAI } from '@ai-sdk/openai';
import { expect, test } from '@rstest/core';
import dotenv from 'dotenv';
import { z } from 'zod';
import { generateObjectCompat } from '../src/index';

dotenv.config();

test('generateObjectCompat parses simple object (real model call)', async () => {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL = process.env.OPENAI_BASE_URL;
  if (!apiKey) {
    console.warn('[skip] OPENAI_API_KEY missing; skipping real model test.');
    return;
  }

  const openai = createOpenAI({ apiKey, baseURL });

  const schema = z.object({
    name: z.string(),
    color: z.string(),
    description: z.string(),
  });

  const res = await generateObjectCompat({
    model: openai.chat(process.env.OPENAI_MODEL_ID!),
    schema,
    prompt: 'Generate a fruit with some description.',
  });

  console.log(res.object);
  console.log(res.text);
  expect(typeof res.text).toBe('string');
  expect(typeof res.object.name).toBe('string');
  expect(typeof res.object.color).toBe('string');
  expect(typeof res.object.description).toBe('string');
});

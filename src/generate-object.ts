import { createHash } from 'node:crypto';
import { generateText, type ModelMessage, type LanguageModel } from 'ai';
import { z } from 'zod';
import { buildBamlFromZod } from './generate-object/zod-to-baml';
import { prepareWorkspace } from './generate-object/workspace';
import { buildAndLoadBamlClient } from './generate-object/build-client';
import {
  buildJsonHint,
  mergeJsonHintIntoMessages,
} from './generate-object/json-hint';

// Public API (compatible with Vercel AI SDK generateObject inputs/outputs at high level)
export interface GenerateObjectCompatOptions<S extends z.ZodType = z.ZodType> {
  model: LanguageModel;
  schema: S; // Zod schema
  prompt?: string;
  messages?: ModelMessage[];
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
  if (process?.env?.DEBUG_BAML) {
    console.log('[DEBUG_BAML] Generated BAML:\n' + bamlFile);
  }
  const cacheKey = createHash('sha256').update(bamlFile).digest('hex');
  const workspace = prepareWorkspace(cacheKey, bamlFile);
  const client = await buildAndLoadBamlClient(workspace);

  // Build a JSON-only instruction to help the LLM output valid JSON
  const jsonHint = buildJsonHint(schema);

  // Simple retry wrapper to mitigate occasional timeouts
  const attempts = 3;
  let lastErr: unknown;
  let textRes: any;
  for (let i = 0; i < attempts; i++) {
    try {
      textRes = await generateText({
        model,
        ...(opts.prompt ? { prompt: `${jsonHint}\n\n${opts.prompt}` } : {}),
        ...(opts.messages
          ? {
              messages: mergeJsonHintIntoMessages(
                jsonHint,
                opts.messages as any[],
              ),
            }
          : {}),
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        topP: opts.topP,
      } as any);
      break;
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }

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

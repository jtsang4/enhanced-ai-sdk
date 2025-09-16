# enhanced-ai-sdk

A lightweight utility that makes it easy to generate structured objects from LLMs using the Vercel AI SDK models and Zod schemas — with robust parsing powered by BAML under the hood.

Why: Many LLMs don’t natively support structured output, which makes Vercel AI SDK’s `generateObject` unusable with them. This library bridges that gap so those models can still produce typed objects directly.

- Familiar API: `generateObjectCompat({ model, schema, ... })`, similar in spirit to Vercel AI SDK's `generateObject`
- Strong typing via Zod
- Works with any Vercel AI SDK–compatible model (e.g. `@ai-sdk/openai`)
- Resilient parsing: converts your Zod schema to a temporary BAML schema and uses the generated parser to parse model output

## Installation

This package has peer dependencies on the Vercel AI SDK and Zod.

```bash
# with pnpm
pnpm add enhanced-ai-sdk ai @ai-sdk/openai zod

# with npm
npm install enhanced-ai-sdk ai @ai-sdk/openai zod

# with yarn
yarn add enhanced-ai-sdk ai @ai-sdk/openai zod
```

## Quick start

```ts
import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import { generateObjectCompat } from 'enhanced-ai-sdk';

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  // Optional: point to compatible providers (e.g. DeepSeek via OpenAI-compatible gateway)
  baseURL: process.env.OPENAI_BASE_URL,
});

const schema = z.object({
  name: z.string(),
  color: z.string(),
});

const res = await generateObjectCompat({
  model: openai.chat('gpt-4o-mini'), // or any compatible model id
  schema,
  prompt: 'Generate a fruit with some description.',
});

console.log(res.object); // -> { name: string, color: string }
console.log(res.text); // raw model text
```

You can also pass `messages` (ChatML-style) instead of `prompt`.

## API

```ts
export interface GenerateObjectCompatOptions<S extends z.ZodType = z.ZodType> {
  model: any; // a Vercel AI SDK model (e.g. from @ai-sdk/openai)
  schema: S; // Zod schema describing the expected object
  prompt?: string; // optional single prompt
  messages?: any[]; // optional chat messages
  // passthrough generation options
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

export interface GenerateObjectCompatResult<T> {
  object: T; // parsed object (z.infer<typeof schema>)
  text: string; // raw model output text
  usage?: any; // provider usage (if available)
  finishReason?: any; // provider finish reason (if available)
}
```

## How it works

1. Your Zod schema is converted into a BAML schema on the fly.
2. A minimal JSON-only instruction is injected into your `prompt`/`messages` to encourage valid JSON output.
3. The LLM is called via Vercel AI SDK's `generateText`.
4. The raw text is parsed by the generated BAML client into the typed object.

The generated BAML client is cached in a temporary directory (e.g. `~/<tmp>/baml-runtime-cache`).

## Requirements

- Node.js 18+
- API credentials for your chosen model provider (e.g. `OPENAI_API_KEY`) and optional `OPENAI_BASE_URL` if using an OpenAI-compatible gateway.

## Scripts

```bash
bun run build   # build the library with rslib
bun run dev     # build in watch mode
bun run test    # run tests with rstest (skips real model test if OPENAI_API_KEY is missing)
bun run format  # format with Biome
bun run check   # lint/check with Biome
```

## Testing

There is an integration-style test that will make a real model call if `OPENAI_API_KEY` is set (and optionally `OPENAI_BASE_URL`). If the key is missing, the test is skipped.

```bash
OPENAI_API_KEY=sk-... bun run test
```

## Caveats & notes

- While the library strongly nudges the model to output JSON and uses a robust parser, LLMs can still return malformed outputs in edge cases. Errors will be thrown if parsing fails.
- `messages` vs `prompt`: if you provide both, `messages` are used and the JSON-only system hint is merged into the first system message (or prepended if none exists).
- This package is not an official Vercel AI SDK package; it simply aims to provide a familiar, convenient developer experience for structured outputs.

## License

MIT License © 2025 James Tsang. See [LICENSE](./LICENSE) for full text.

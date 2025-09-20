export { generateObjectCompat } from './generate-object';
export type {
  GenerateObjectCompatOptions,
  GenerateObjectCompatResult,
} from './generate-object';

// Only expose types for advanced usage; avoid leaking internal helpers as runtime APIs
export type { Ctx, ClassType } from './generate-object/zod-to-baml';

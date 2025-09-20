export const DEBUG = !!process.env.ENHANCED_AI_SDK_DEBUG;
export const dlog = (...args: any[]) => {
  if (DEBUG) {
    try { console.error('[enhanced-ai-sdk]', ...args); } catch {}
  }
};


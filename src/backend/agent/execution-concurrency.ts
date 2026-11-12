/** Local host override. Provider serialization and host memory holds still take precedence. */
export function executionConcurrency(fallback: number): number {
  const value = Number(process.env.OPENBOT_EXECUTION_CONCURRENCY);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

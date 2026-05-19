/**
 * Shared elapsed-time formatter. Consumed by /dev/rule-check page and the
 * commercial ReplayButton — keep them in lock-step.
 */

export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

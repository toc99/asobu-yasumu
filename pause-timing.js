// v3.13.5: a session with zero pauses must never inherit pause time from an older session.
// Pure helper, shared by game/video displays and Firestore session calculations.
export function effectivePausedMillis(profile, now = Date.now()) {
  const count = Number(profile?.pauseCount) || 0;
  if (!Number.isInteger(count) || count <= 0) return 0;
  const total = Math.max(0, Number(profile?.pauseTotalMs) || 0);
  const started = profile?.pauseStartedAt?.toMillis?.() || 0;
  return total + (started > 0 ? Math.max(0, now - started) : 0);
}

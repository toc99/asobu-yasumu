// v3.19.0: a game/video mode switch must not reset the per-cycle video allowance.
// Only completed video segments contribute here; the currently running segment is timed separately.
const MINUTE=60000;
export function recordedVideoMillis(profile){
  const raw=Number(profile?.cycleVideoUsedMs??0);
  return Number.isFinite(raw)&&raw>=0?Math.floor(raw):0;
}
export function remainingVideoMs(limitMinutes,usedMs=0){
  if(!Number.isInteger(limitMinutes)||limitMinutes<1||limitMinutes>240)
    throw new RangeError('Invalid video time limit');
  if(!Number.isFinite(usedMs)||usedMs<0)throw new RangeError('Invalid video use');
  return Math.max(0,limitMinutes*MINUTE-Math.floor(usedMs));
}
export function nextVideoUseMs(previousVideoMs,segmentMs,segmentWasVideo){
  if(!Number.isFinite(previousVideoMs)||previousVideoMs<0||!Number.isFinite(segmentMs)||segmentMs<0)
    throw new RangeError('Invalid video segment');
  return Math.floor(previousVideoMs)+(segmentWasVideo?Math.floor(segmentMs):0);
}

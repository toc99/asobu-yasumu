// UTC+9 (Japan): night carry-over may only be released after getting up in the morning.
const MIN=60000, DAY=86400000, JST_OFFSET=9*60*MIN;
export const EARLIEST_MORNING_MINUTE=5*60;
export function canResumeInMorning(nowMillis,nightEndMinute){
  if(!Number.isFinite(nowMillis)||!Number.isInteger(nightEndMinute))return false;
  const local=((nowMillis+JST_OFFSET)%DAY+DAY)%DAY;
  return local>=EARLIEST_MORNING_MINUTE*MIN && local<nightEndMinute*MIN;
}

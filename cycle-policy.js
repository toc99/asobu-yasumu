// v3.16: pure helpers for one game/video usage cycle and preserved rest debt.
export function totalCycleUseMs(carriedMs,latestMs){
  if(!Number.isFinite(carriedMs)||!Number.isFinite(latestMs)||carriedMs<0||latestMs<0)
    throw new RangeError('Negative or non-finite cycle duration');
  return Math.round(carriedMs+latestMs);
}
export function restEndWithDebt(previousRawEnd,end,carriedMs,latestMs,restDebtMs=0){
  if(!Number.isFinite(restDebtMs)||restDebtMs<0)throw new RangeError('Invalid rest debt');
  return Math.max(previousRawEnd||0,end+totalCycleUseMs(carriedMs,latestMs)+Math.round(restDebtMs));
}

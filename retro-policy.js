// v3.17.0: Distinguish self-reporting from parent-confirmed overlooked starts.
// A correction is not a violation; only confirmed notices count.
export const RETRO_WINDOW_MS=30*24*60*60*1000;
export const RETRO_PENALTY_THRESHOLD=3;
export function sameRetroSession(profile){
  return !!profile?.retroReportId && !!profile?.retroReportStartedAt?.toMillis &&
    !!profile?.startedAt?.toMillis &&
    profile.retroReportStartedAt.toMillis()===profile.startedAt.toMillis();
}
export function unresolvedNotices(reports,childId,now=Date.now()){
  return reports.filter(r=>r.childId===childId&&r.reviewStatus==='counted'&&
    !r.penaltyEventId&&typeof r.reviewedAt?.toMillis==='function'&&
    r.reviewedAt.toMillis()>=now-RETRO_WINDOW_MS&&r.reviewedAt.toMillis()<=now+60_000)
    .sort((a,b)=>a.reviewedAt.toMillis()-b.reviewedAt.toMillis()||
      String(a.reportId).localeCompare(String(b.reportId)));
}
export function availablePenalty(reports,childId,now=Date.now()){
  return unresolvedNotices(reports,childId,now).slice(0,RETRO_PENALTY_THRESHOLD);
}

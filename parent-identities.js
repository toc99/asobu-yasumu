// v3.27.0 — UID is the authoritative actor; names come from the admin-only directory.
const validUid=v=>typeof v==='string'&&v.length>0&&v.length<=128&&!v.includes('/');
export function parseParentIdentities(data){
  if(!data||!validUid(data.fatherUid)||!validUid(data.motherUid)||data.fatherUid===data.motherUid)return null;
  const effectiveFrom=Number(data.effectiveFrom?.toMillis?.()??0);
  if(!Number.isFinite(effectiveFrom)||effectiveFrom<=0)return null;
  return {fatherUid:data.fatherUid,motherUid:data.motherUid,effectiveFrom};
}
export function parentDisplayName(directory,uid){
  if(!directory||!uid)return '保護者';
  return uid===directory.fatherUid?'お父さん':uid===directory.motherUid?'お母さん':'保護者';
}
export function parentNameFor(directory,uid,at){
  return directory&&Number.isFinite(at)&&at>=directory.effectiveFrom?parentDisplayName(directory,uid):'保護者';
}
export function isParentIdentity(directory,uid){return !!directory&&!!uid&&(uid===directory.fatherUid||uid===directory.motherUid);}

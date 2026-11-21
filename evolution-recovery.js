// Identify species removed by the old evolution behavior without returning deliberately released species.
export function legacyEvolutionRecoveryCandidates(state,maxNo=1025,releasedSpecies=[]){
  if(!state?.owned||!state?.evolutionLog)return [];
  const ownedRewards=new Set(Object.values(state.owned));
  const found=new Set(),released=new Set(releasedSpecies),result=[];
  for(const [sourceRewardId,steps] of Object.entries(state.evolutionLog)){
    if(!ownedRewards.has(sourceRewardId)||!Array.isArray(steps))continue;
    for(const step of steps){
      const no=Number(step?.from),key=String(no);
      if(!Number.isInteger(no)||no<1||no>maxNo||found.has(no)||released.has(no))continue;
      if(state.owned[key]||state.reserved?.[key]||!state.seen?.[key])continue;
      found.add(no);result.push({no,sourceRewardId});
    }
  }
  return result;
}

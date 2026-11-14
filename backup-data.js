// v3.13.6: Firebase Rules allow only /pokemonInventory/older and /pokemonInventory/younger.
// A collection-wide query is rejected because security rules are not filters.
// Explicitly get each known document instead of querying the collection.
export async function loadAuthorizedPokemonInventories(dbApi, db, householdId, childIds) {
  const docs = await Promise.all(childIds.map(id =>
    dbApi.getDoc(dbApi.doc(db, 'households', householdId, 'pokemonInventory', id))
  ));
  return docs.filter(d => d.exists()).map(d => ({...d.data(), childId:d.id}));
}

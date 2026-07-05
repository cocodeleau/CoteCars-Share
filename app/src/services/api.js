export async function fetchVehicleByPlate(plate) {
  const res = await fetch(`/api/rapid-api-requests?plate=${encodeURIComponent(plate)}`);
  if (!res.ok) throw new Error('SIV lookup failed');
  return res.json();
}

export async function fetchLbcListings({ plate, km, vehicle }) {
  const params = new URLSearchParams({ plate, km });
  if (vehicle) {
    params.set('marque', vehicle.marque);
    params.set('modele', vehicle.modele);
    params.set('annee', vehicle.annee);
  }
  const res = await fetch(`/api/lbc-piloterr-requests?${params}`);
  if (!res.ok) throw new Error('LBC lookup failed');
  return res.json();
}

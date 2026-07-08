export async function fetchVehicleByPlate(plate) {
  const clean = (plate || '').replace(/[-\s]/g, '').toUpperCase();
  const res = await fetch(`/api/rapid-api-requests?plaque=${encodeURIComponent(clean)}`);
  if (!res.ok) throw new Error('SIV lookup failed');
  return res.json();
}

export async function fetchLbcListings(params) {
  const query = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''))
  );
  const res = await fetch(`/api/leboncoin?${query}`);
  if (!res.ok) throw new Error('LBC lookup failed');
  return res.json();
}

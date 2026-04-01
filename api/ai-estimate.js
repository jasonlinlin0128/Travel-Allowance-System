// Serverless function for Vercel: estimate drive time via Google Maps Directions API
// Expects POST JSON body: { input: string (destination), origin?: string }
// Requires environment variable: GOOGLE_MAPS_API_KEY

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { input, origin } = req.body || {};
    if (!input || typeof input !== 'string') {
      return res.status(400).json({ error: 'Missing input (destination) in request body' });
    }

    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) {
      return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY is not configured' });
    }

    const COMPANY_ORIGIN = "彰化縣北斗鎮四海路二段79號";
    const originParam = origin && typeof origin === 'string' && origin.trim() ? origin.trim() : COMPANY_ORIGIN;

    // Try Directions API first (gives travel time)
    const directionsParams = new URLSearchParams({
      origin: originParam,
      destination: input,
      key,
      mode: 'driving',
    });

    const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?${directionsParams.toString()}`;
    const directionsResp = await fetch(directionsUrl);
    const directionsJson = await directionsResp.json();

    if (directionsJson.status === 'OK' && Array.isArray(directionsJson.routes) && directionsJson.routes.length > 0) {
      const leg = directionsJson.routes[0].legs && directionsJson.routes[0].legs[0];
      if (leg) {
        const durationSec = (leg.duration_in_traffic && leg.duration_in_traffic.value) || (leg.duration && leg.duration.value) || 0;
        const hours = Math.round((durationSec / 3600) * 10) / 10; // 0.1h 精度
        const fullAddress = leg.end_address || input;
        return res.status(200).json({ hours, fullAddress, source: 'directions' });
      }
    }

    // Fallback: use Geocoding to get a normalized address (no travel time)
    const geocodeParams = new URLSearchParams({
      address: input,
      key,
    });
    const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?${geocodeParams.toString()}`;
    const geocodeResp = await fetch(geocodeUrl);
    const geocodeJson = await geocodeResp.json();

    if (geocodeJson.status === 'OK' && Array.isArray(geocodeJson.results) && geocodeJson.results.length > 0) {
      const formatted = geocodeJson.results[0].formatted_address;
      return res.status(200).json({ hours: 0, fullAddress: formatted, source: 'geocode' });
    }

    return res.status(502).json({ error: 'No route or geocode result from Google Maps' });
  } catch (err) {
    console.error('ai-estimate error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: String(err) });
  }
}

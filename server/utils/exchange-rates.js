// server/utils/exchange-rates.js
// Fetch live USD exchange rates from a free API and store them per-tenant.
// Base currency is USD (all DB amounts are in USD). Display currency is tenant.currency.

const CURRENCY_MAP = {
  '$': 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '₦': 'NGN',
  'GHS': 'GHS',
  'KES': 'KES',
};

/**
 * Fetch current USD exchange rates from exchangerate-api.com (free tier: 1500 req/month).
 * Returns { EUR: 0.92, GBP: 0.79, NGN: 1580, ... } where each value is "1 USD = X currency".
 */
async function fetchLiveRates() {
  const url = 'https://open.er-api.com/v6/latest/USD';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Rate API returned ${res.status}`);
    const data = await res.json();
    if (!data.rates) throw new Error('No rates in API response');
    return data.rates; // { EUR: 0.92, GBP: 0.79, NGN: 1580, ... }
  } catch (err) {
    console.error('Failed to fetch exchange rates:', err.message);
    throw new Error('Could not fetch live exchange rates. Try again later.');
  }
}

/**
 * Convert a symbol/code (from tenant.currency) to an ISO currency code.
 * Falls back to USD if unknown.
 */
function symbolToCode(symbol) {
  return CURRENCY_MAP[symbol] || 'USD';
}

/**
 * Get the exchange rate for a tenant's display currency.
 * Returns 1.0 if the currency is USD or if rates are missing.
 */
function getRateForTenant(tenant) {
  const code = symbolToCode(tenant.currency);
  if (code === 'USD') return 1.0;

  const rates = tenant.exchange_rates ? JSON.parse(tenant.exchange_rates) : {};
  return rates[code] || 1.0; // fallback to 1:1 if rate missing
}

module.exports = { fetchLiveRates, symbolToCode, getRateForTenant };

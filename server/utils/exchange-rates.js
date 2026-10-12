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

// ── Guest-geolocation currency support ──────────────────────────────────────
// Guests see prices charged by the HOTEL in the hotel's own currency, but can
// instantly switch the display to their HOME currency. Rate lookup:
//   1. Cloudflare / Truehost-class edge header  (CF-IPCountry / X-Country-Code)
//   2. Accept-Language region  (e.g. "en-NG" → Nigeria)
//   3. Explicit ?country= override (booking page currency selector)
const COUNTRY_CURRENCY = {
  US:'USD', EU:'EUR', DE:'EUR', FR:'EUR', ES:'EUR', IT:'EUR', NL:'EUR', IE:'EUR', PT:'EUR', AT:'EUR', BE:'EUR', FI:'EUR', GR:'EUR', SK:'EUR', SI:'EUR', LV:'EUR', LT:'EUR', EE:'EUR', CY:'EUR', MT:'EUR', LU:'EUR', HR:'EUR',
  GB:'GBP', NG:'NGN', GH:'GHS', KE:'KES', ZA:'ZAR', TZ:'TZS', UG:'UGX', RW:'RWF', ZM:'ZMW', ET:'ETB', EG:'EGP', MA:'MAD', CI:'XOF', SN:'XOF', CM:'XAF', DZ:'DZD', TN:'TND', LY:'LYD', MU:'MUR',AO:'AOA', 
  CA:'CAD', AU:'AUD', NZ:'NZD', IN:'INR', PK:'PKR', BD:'BDT', LK:'LKR', NP:'NPR', AE:'AED', SA:'SAR', QA:'QAR', KW:'KWD', OM:'OMR', BH:'BHD', JO:'JOD', IL:'ILS', TR:'TRY', CN:'CNY', HK:'HKD', TW:'TWD', JP:'JPY',
  KR:'KRW', SG:'SGD', MY:'MYR', TH:'THB', VN:'VND', PH:'PHP', ID:'IDR', BR:'BRL', MX:'MXN', AR:'ARS', CL:'CLP', CO:'COP', PE:'PEN', RO:'RON', PL:'PLN', CZ:'CZK', HU:'HUF', SE:'SEK', NO:'NOK', DK:'DKK', CH:'CHF',
};

// Symbol map for displaying a converted amount in an arbitrary currency.
const CURRENCY_SYMBOL = {
  USD:'$', EUR:'€', GBP:'£', NGN:'₦', GHS:'GH₵', KES:'KSh', ZAR:'R', TZS:'TSh', UGX:'USh', RWF:'FRw', ZMW:'ZK', ETB:'Br', EGP:'E£', MAD:'DH', XOF:'CFA', XAF:'FCFA',
  CAD:'C$', AUD:'A$', NZD:'NZ$', INR:'₹', PKR:'₨', BDT:'৳', LKR:'Rs', NPR:'Rs', AED:'د.إ', SAR:'﷼', QAR:'QR', KWD:'KD', OMR:'﷼', BHD:'BD', JOD:'JD', ILS:'₪', TRY:'₺',
  CNY:'¥', HKD:'HK$', TWD:'NT$', JPY:'¥', KRW:'₩', SGD:'S$', MYR:'RM', THB:'฿', VND:'₫', PHP:'₱', IDR:'Rp', BRL:'R$', MXN:'MX$', ARS:'$', CLP:'$', COP:'$', PEN:'S/', RON:'lei', PLN:'zł', CZK:'Kč', HUF:'Ft', SEK:'kr', NOK:'kr', DKK:'kr', CHF:'CHF',
};

/** Detect the ISO currency code a guest should SEE prices in.
 *  Returns null when nothing conclusive — caller keeps the hotel currency. */
function detectGuestCurrencyByCountry(country) {
  if (!country) return null;
  return COUNTRY_CURRENCY[String(country).toUpperCase()] || null;
}

function symbolFor(code) { return CURRENCY_SYMBOL[code] || (code || '$'); }

module.exports = { fetchLiveRates, symbolToCode, getRateForTenant, detectGuestCurrencyByCountry, symbolFor, COUNTRY_CURRENCY };

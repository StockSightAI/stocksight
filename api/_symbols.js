// Site tickers -> Yahoo symbols, same conventions as index.html (Y_INDEX, ySym)

export const Y_INDEX = {
  SPX: '^GSPC', IXIC: '^IXIC', DJI: '^DJI', RUT: '^RUT', VIX: '^VIX', NDX: '^NDX', MID: '^MID', SP600: '^SP600',
  FTSE: '^FTSE', NI225: '^N225', DAX: '^GDAXI', CAC40: '^FCHI', HSI: '^HSI', ASX: '^AXJO', SENSEX: '^BSESN',
  NIFTY: '^NSEI', KOSPI: '^KS11', SSEC: '000001.SS', IBEX: '^IBEX', MIB: 'FTSEMIB.MI', AEX: '^AEX', SMI: '^SSMI',
  TSX: '^GSPTSE', BVSP: '^BVSP', MERVAL: '^MERV', DXY: 'DX-Y.NYB', US10Y: '^TNX', US30Y: '^TYX',
  GOLD: 'GC=F', SILVER: 'SI=F', USOIL: 'CL=F', UKOIL: 'BZ=F', NATGAS: 'NG=F', CORN: 'ZC=F', WHEAT: 'ZW=F',
};
export const CRYPTO = new Set(['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'LTC', 'DOT', 'MATIC', 'SHIB', 'UNI',
  'ATOM', 'FIL', 'APT', 'ARB', 'OP', 'INJ', 'SUI', 'TIA', 'NEAR', 'FTM', 'ALGO', 'HBAR', 'VET', 'THETA', 'EOS', 'XLM', 'TRX',
  'BCH', 'ETC', 'XMR', 'ZEC', 'DASH', 'PEPE', 'WIF', 'BONK', 'FLOKI']);
// What a ticker typed or saved on the site can look like: AAPL, BRK.B, BTC, SPX, US10Y
export const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,9}$/;

const isCrypto = (t, k) => k === 'c' || (!k && CRYPTO.has(t));
export function ySym(t, k) {
  t = String(t || '').toUpperCase().trim();
  if (Y_INDEX[t]) return Y_INDEX[t];
  if (isCrypto(t, k)) return t + '-USD';
  return t.replace(/\./g, '-');
}

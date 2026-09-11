function parseNbkXml(xml) {
  const rates = {};
  const items = String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const [, block] of items) {
    const code = block.match(/<title>([A-Z]{3})<\/title>/)?.[1];
    const description = block.match(/<description>([\d.]+)<\/description>/)?.[1];
    const quant = Number(block.match(/<quant>(\d+)<\/quant>/)?.[1] || 1);
    if (!code || description == null || !quant) continue;
    rates[code] = Number(description) / quant;
  }
  if (!rates.USD) throw new Error('В ответе нет курса USD');
  return rates;
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function fetchKaspiRates() {
  const attempts = [
    async () => ({ ...parseNbkXml(await fetchText('/nbk-rates')), source: 'Каспи / НБРК' }),
    async () => {
      const xml = await window.buyerAPI?.fetchRatesXml?.();
      if (!xml) throw new Error('no electron');
      return { ...parseNbkXml(xml), source: 'Каспи / НБРК' };
    },
    async () => {
      const xml = await fetchText(`https://api.allorigins.win/raw?url=${encodeURIComponent('https://nationalbank.kz/rss/rates_all.xml')}`);
      return { ...parseNbkXml(xml), source: 'Каспи / НБРК' };
    },
    async () => {
      const xml = await fetchText('https://r.jina.ai/https://nationalbank.kz/rss/rates_all.xml');
      return { ...parseNbkXml(xml), source: 'Каспи / НБРК' };
    },
    async () => {
      const data = await fetchJson('https://open.er-api.com/v6/latest/USD');
      if (!data?.rates?.KZT) throw new Error('no KZT');
      const usd = Number(data.rates.KZT);
      const eur = data.rates.EUR ? usd / Number(data.rates.EUR) : undefined;
      const jpy = data.rates.JPY ? usd / Number(data.rates.JPY) : undefined;
      const krw = data.rates.KRW ? usd / Number(data.rates.KRW) : undefined;
      return { USD: usd, EUR: eur, JPY: jpy, KRW: krw, source: 'рыночный курс' };
    }
  ];
  let lastError;
  for (const attempt of attempts) {
    try {
      const rates = await attempt();
      if (Number(rates.USD) > 0) return { ...rates, fetchedAt: new Date().toISOString() };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Не удалось получить курс');
}

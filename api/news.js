const FEEDS = [
  { source: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { source: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ENTITIES[e])
    .replace(/<[^>]+>/g, '')
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
}

const isHttp = u => /^https?:\/\//i.test(u);

function parse(xml, source) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(([, item]) => {
    const media = item.match(/<media:content[^>]*url="([^"]+)"/i);
    const link = tag(item, 'link');
    return {
      title: tag(item, 'title'),
      link: isHttp(link) ? link : '',
      source,
      published: Date.parse(tag(item, 'pubDate')) || 0,
      image: media && isHttp(media[1]) ? media[1] : '',
    };
  }).filter(i => i.title && i.link);
}

export default async function handler(req, res) {
  const results = await Promise.allSettled(FEEDS.map(async f => {
    const r = await fetch(f.url, { headers: { 'User-Agent': 'Mozilla/5.0 StockSight' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`${f.source} ${r.status}`);
    return parse(await r.text(), f.source);
  }));

  const seen = new Set();
  const items = results
    .flatMap(r => (r.status === 'fulfilled' ? r.value : []))
    .sort((a, b) => b.published - a.published)
    .filter(i => {
      const key = i.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
  res.status(items.length ? 200 : 502).json({ items });
}

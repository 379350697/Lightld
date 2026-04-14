/**
 * Quick test: fetch GMGN token security info for a given mint address.
 * Usage: npx tsx scripts/test-gmgn-token.ts <mint_address>
 */
const mint = process.argv[2] || '7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs';
const url = `https://gmgn.ai/defi/quotation/v1/tokens/sol/${mint}`;

console.log(`Fetching GMGN token info for: ${mint}`);
console.log(`URL: ${url}\n`);

const response = await fetch(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://gmgn.ai/'
  }
});

console.log(`Status: ${response.status}`);

if (!response.ok) {
  console.error('Request failed:', response.statusText);
  const text = await response.text();
  console.error('Body:', text.slice(0, 500));
  process.exit(1);
}

const json = await response.json();
console.log('\n=== FULL RESPONSE ===');
console.log(JSON.stringify(json, null, 2).slice(0, 5000));

// Try to find security-related fields
const data = (json as any)?.data;
if (data) {
  console.log('\n=== KEY SECURITY FIELDS ===');
  const fields = ['sniper_count', 'sniper_ratio', 'snipers', 'bluechip', 'bluechip_ratio', 
    'bluechip_owner_percentage', 'rug_ratio', 'rug_pull', 'audit', 'audit_score',
    'is_mint_renounced', 'mint_authority', 'freeze_authority',
    'top_10_holder_rate', 'dev_token_burn_amount'];
  for (const f of fields) {
    if (data[f] !== undefined) {
      console.log(`  ${f}: ${JSON.stringify(data[f])}`);
    }
  }
  // Deep search for keywords
  const jsonStr = JSON.stringify(data);
  for (const kw of ['sniper', 'bluechip', 'rug', 'audit', 'security']) {
    const re = new RegExp(`"[^"]*${kw}[^"]*"\\s*:`, 'gi');
    const matches = jsonStr.match(re);
    if (matches) {
      console.log(`  [keyword "${kw}" found in]: ${[...new Set(matches)].join(', ')}`);
    }
  }
}

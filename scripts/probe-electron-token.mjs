// List recent electron-pkce* records in Supabase site_settings.
import fs from 'node:fs';

const envText = fs.readFileSync('G:/HU/.env.local', 'utf8');
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sbUrl = env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const sbKey = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };

const res = await fetch(
  `${sbUrl}/rest/v1/site_settings?select=id,value&or=(id.ilike.electron-pkce:*,id.ilike.electron-pkce-lookup:*)&order=id.desc&limit=15`,
  { headers: H },
);
const rows = await res.json();
console.log('status:', res.status, 'count:', Array.isArray(rows) ? rows.length : rows);
for (const r of rows ?? []) {
  const v = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
  console.log(' ', r.id, '→', v?.slice(0, 140));
}

import fs from 'node:fs';

const envText = fs.readFileSync('G:/HU/.env.local', 'utf8');
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sbUrl = env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const sbKey = env.SUPABASE_SERVICE_ROLE_KEY;
console.log('sbUrl:', sbUrl, '| key present:', Boolean(sbKey));
if (!sbUrl || !sbKey) process.exit(1);

const H = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

// 1. grab a real profile id
const profRes = await fetch(`${sbUrl}/rest/v1/profiles?select=id&limit=1`, { headers: H });
const prof = await profRes.json();
console.log('profile fetch status:', profRes.status, 'rows:', Array.isArray(prof) ? prof.length : prof);
if (!Array.isArray(prof) || !prof[0]) { console.log('NO PROFILE — cannot test'); process.exit(1); }
const userId = prof[0].id;

// 2. upsert the one-time PKCE record the website would create
const challenge = Buffer.from('test-verifier-abc').toString(); // placeholder, replaced below
const crypto = await import('node:crypto');
const realChallenge = crypto.createHash('sha256').update('test-verifier-abc').digest('base64url');
const recId = `electron-pkce:probe-${Date.now()}`;
const upRes = await fetch(`${sbUrl}/rest/v1/site_settings`, {
  method: 'POST',
  headers: { ...H, Prefer: 'resolution=merge-duplicates' },
  body: JSON.stringify({ id: recId, value: { userId, state: 'probe-state', codeChallenge: realChallenge } }),
});
console.log('record upsert status:', upRes.status);

// 3. ask the LOCAL bridge to exchange it
const ex = await fetch('http://127.0.0.1:7180/electron/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: recId.split(':')[1], state: 'probe-state', code_verifier: 'test-verifier-abc' }),
});
console.log('bridge exchange status:', ex.status, 'body:', await ex.text());

// 4. clean up
await fetch(`${sbUrl}/rest/v1/site_settings?id=eq.${encodeURIComponent(recId)}`, { method: 'DELETE', headers: H });
console.log('cleanup done');

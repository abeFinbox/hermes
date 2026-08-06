import { emptyRequest, newId, type KV, type StepRequest, type FormDataField } from './types';

// Flags that consume the following token as their value but that we don't map
// to anything — we skip the value so it isn't mistaken for the URL.
const CONSUME_IGNORE = new Set([
  '-o', '--output', '-m', '--max-time', '--connect-timeout', '-x', '--proxy',
  '-c', '--cookie-jar', '-E', '--cert', '--key', '-w', '--write-out',
  '--resolve', '--retry', '-T', '--upload-file', '--cacert', '--capath',
  '--limit-rate', '--max-redirs', '-y', '--speed-time', '-Y', '--speed-limit',
]);

/**
 * Tokenize a shell-ish command respecting single quotes (literal), double
 * quotes (with a few escapes) and backslash escaping — enough for the cURL
 * commands browsers' "Copy as cURL" and Hermes' own export produce.
 */
function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inArg = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (inArg) { out.push(cur); cur = ''; inArg = false; }
      i++;
      continue;
    }
    inArg = true;
    if (c === "'") {
      i++;
      while (i < s.length && s[i] !== "'") cur += s[i++];
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) {
          cur += s[i + 1];
          i += 2;
          continue;
        }
        cur += s[i++];
      }
      i++;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < s.length) { cur += s[i + 1]; i += 2; } else { i++; }
      continue;
    }
    cur += c;
    i++;
  }
  if (inArg) out.push(cur);
  return out;
}

export interface ParsedCurl {
  request: StepRequest;
  name: string;
}

/** Parse a cURL command into a Hermes StepRequest. Throws on obviously-bad input. */
export function parseCurl(input: string): ParsedCurl {
  const cleaned = input.trim().replace(/\\\r?\n/g, ' ').replace(/^\$\s+/, '');
  const tokens = tokenize(cleaned);
  if (!tokens.length || tokens[0].toLowerCase() !== 'curl') {
    throw new Error('Not a cURL command — it must start with "curl".');
  }
  tokens.shift();

  const req = emptyRequest();
  const headers: KV[] = [];
  const dataParts: string[] = [];
  const formData: FormDataField[] = [];
  let method = '';
  let dataMode: '' | 'raw' | 'form' | 'formdata' = '';
  let url = '';
  let basicUser: string | null = null;
  let basicPass = '';
  let getFlag = false;

  const addHeader = (raw: string) => {
    const idx = raw.indexOf(':');
    if (idx > 0) headers.push({ key: raw.slice(0, idx).trim(), value: raw.slice(idx + 1).trim(), enabled: true });
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const val = () => tokens[++i] ?? '';
    if (t === '-X' || t === '--request') { method = val().toUpperCase(); continue; }
    if (t === '-H' || t === '--header') { addHeader(val()); continue; }
    if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-ascii' || t === '--data-binary') {
      dataParts.push(val());
      if (!dataMode) dataMode = 'raw';
      continue;
    }
    if (t === '--data-urlencode') { dataParts.push(val()); dataMode = 'form'; continue; }
    if (t === '-F' || t === '--form') {
      const f = val();
      const eq = f.indexOf('=');
      if (eq > 0) {
        const key = f.slice(0, eq);
        const raw = f.slice(eq + 1);
        const isFile = raw.startsWith('@');
        formData.push({
          id: newId(), key, type: isFile ? 'file' : 'text',
          value: isFile ? '' : raw, fileId: '', enabled: true,
        });
      }
      dataMode = 'formdata';
      continue;
    }
    if (t === '-u' || t === '--user') {
      const u = val();
      const ci = u.indexOf(':');
      basicUser = ci >= 0 ? u.slice(0, ci) : u;
      basicPass = ci >= 0 ? u.slice(ci + 1) : '';
      continue;
    }
    if (t === '--url') { url = val(); continue; }
    if (t === '-G' || t === '--get') { getFlag = true; continue; }
    if (t === '-I' || t === '--head') { method = 'HEAD'; continue; }
    if (t === '-A' || t === '--user-agent') { headers.push({ key: 'User-Agent', value: val(), enabled: true }); continue; }
    if (t === '-e' || t === '--referer') { headers.push({ key: 'Referer', value: val(), enabled: true }); continue; }
    if (t === '-b' || t === '--cookie') { headers.push({ key: 'Cookie', value: val(), enabled: true }); continue; }
    if (t.startsWith('-')) { if (CONSUME_IGNORE.has(t)) val(); continue; } // unknown flag: boolean or skip its value
    if (!url) url = t; // first positional is the URL
  }

  if (!url) throw new Error('No URL found in the cURL command.');

  // form-data with -G, or query moves — keep simple: -G appends data to the query
  if (getFlag && dataParts.length) {
    const qs = dataParts.join('&');
    url += (url.includes('?') ? '&' : '?') + qs;
    dataParts.length = 0;
  }

  req.method = method || (dataParts.length || formData.length ? 'POST' : 'GET');
  req.url = url;
  req.headers = headers;

  const ctype = (headers.find((h) => h.key.toLowerCase() === 'content-type')?.value || '').toLowerCase();
  if (formData.length) {
    req.body = { mode: 'form-data', content: '', formData };
  } else if (dataParts.length) {
    const content = dataParts.join('&');
    let mode: StepRequest['body']['mode'] = 'raw';
    if (ctype.includes('json')) mode = 'json';
    else if (ctype.includes('x-www-form-urlencoded') || dataMode === 'form') mode = 'form';
    else if (/^\s*[{[]/.test(content)) mode = 'json'; // best-effort JSON detection
    req.body = { mode, content };
  }

  if (basicUser !== null) {
    req.auth = { type: 'basic', username: basicUser, password: basicPass };
  }

  return { request: req, name: deriveName(url, req.method) };
}

function deriveName(url: string, method: string): string {
  try {
    // tolerate {{vars}} by blanking them for name derivation only
    const u = new URL(url.replace(/\{\{[^}]+\}\}/g, 'x'));
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg ? `${method} ${seg}` : `${method} ${u.hostname}`;
  } catch {
    return `${method} request`;
  }
}

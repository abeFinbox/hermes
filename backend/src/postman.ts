import { newId, emptyRequest, type Step, type StepRequest, type KV } from './types.js';

/**
 * Minimal Postman Collection v2.0/v2.1 importer.
 * Normalizes the item tree into editable Steps, preserving folder paths
 * and original pm scripts (events) without executing them.
 */

export interface TreeNode {
  type: 'folder' | 'request';
  name: string;
  method?: string;
  url?: string;
  stepId?: string; // links tree node to the generated step
  children?: TreeNode[];
}

export interface ImportResult {
  name: string;
  steps: Step[];
  tree: TreeNode[];
  variables: Array<{ key: string; value: string }>;
}

function asKVList(list: unknown): KV[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((h: any) => h && typeof h.key === 'string')
    .map((h: any) => ({ key: h.key, value: String(h.value ?? ''), enabled: !h.disabled }));
}

function urlToString(url: unknown): string {
  if (typeof url === 'string') return url;
  if (url && typeof url === 'object') {
    const u = url as any;
    if (typeof u.raw === 'string' && u.raw) return u.raw;
    const protocol = u.protocol ? `${u.protocol}://` : '';
    const host = Array.isArray(u.host) ? u.host.join('.') : (u.host ?? '');
    const port = u.port ? `:${u.port}` : '';
    const path = Array.isArray(u.path) ? '/' + u.path.join('/') : (u.path ? `/${u.path}` : '');
    const query = Array.isArray(u.query) && u.query.length
      ? '?' + u.query.filter((q: any) => !q.disabled).map((q: any) => `${q.key}=${q.value ?? ''}`).join('&')
      : '';
    return `${protocol}${host}${port}${path}${query}`;
  }
  return '';
}

function queryFromUrl(url: unknown): KV[] {
  if (url && typeof url === 'object' && Array.isArray((url as any).query)) {
    return (url as any).query
      .filter((q: any) => q && typeof q.key === 'string')
      .map((q: any) => ({ key: q.key, value: String(q.value ?? ''), enabled: !q.disabled }));
  }
  return [];
}

function bodyFromPostman(body: any): StepRequest['body'] {
  if (!body || !body.mode) return { mode: 'none', content: '' };
  switch (body.mode) {
    case 'raw': {
      const lang = body.options?.raw?.language;
      return { mode: lang === 'json' ? 'json' : 'raw', content: String(body.raw ?? '') };
    }
    case 'urlencoded': {
      const pairs = (body.urlencoded || [])
        .filter((p: any) => !p.disabled)
        .map((p: any) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value ?? '')}`)
        .join('&');
      return { mode: 'form', content: pairs };
    }
    case 'formdata': {
      // multipart. text parts carry their value; file parts keep the key but need a
      // file re-attached from the store (Postman collections don't ship the bytes).
      const formData = (body.formdata || [])
        .filter((p: any) => p.key)
        .map((p: any) => ({
          id: newId(),
          key: String(p.key),
          type: p.type === 'file' ? 'file' : 'text',
          value: p.type === 'file' ? '' : String(p.value ?? ''),
          fileId: '',
          enabled: !p.disabled,
        })) as StepRequest['body']['formData'];
      return { mode: 'form-data', content: '', formData };
    }
    case 'graphql':
      return { mode: 'json', content: JSON.stringify(body.graphql ?? {}, null, 2) };
    default:
      return { mode: 'raw', content: typeof body[body.mode] === 'string' ? body[body.mode] : JSON.stringify(body[body.mode] ?? '', null, 2) };
  }
}

function authFromPostman(auth: any): StepRequest['auth'] {
  if (!auth || !auth.type || auth.type === 'noauth') return { type: 'none' };
  const grab = (list: any[], key: string) => {
    const item = Array.isArray(list) ? list.find((x) => x.key === key) : undefined;
    return item ? String(item.value ?? '') : '';
  };
  if (auth.type === 'bearer') return { type: 'bearer', token: grab(auth.bearer, 'token') };
  if (auth.type === 'basic') return { type: 'basic', username: grab(auth.basic, 'username'), password: grab(auth.basic, 'password') };
  return { type: 'none' };
}

function requestFromPostman(r: any): StepRequest {
  if (typeof r === 'string') {
    return { ...emptyRequest(), url: r };
  }
  return {
    method: String(r.method || 'GET').toUpperCase(),
    url: urlToString(r.url),
    headers: asKVList(r.header),
    params: queryFromUrl(r.url),
    body: bodyFromPostman(r.body),
    auth: authFromPostman(r.auth),
  };
}

function walk(items: any[], folderPath: string[], steps: Step[], tree: TreeNode[]) {
  for (const item of items || []) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.item)) {
      const node: TreeNode = { type: 'folder', name: String(item.name || 'Folder'), children: [] };
      tree.push(node);
      walk(item.item, [...folderPath, node.name], steps, node.children!);
    } else if (item.request) {
      const request = requestFromPostman(item.request);
      const step: Step = {
        id: newId(),
        name: String(item.name || request.url || 'Request'),
        enabled: true,
        folderPath: folderPath.join(' / '),
        request,
        sourceRequest: JSON.parse(JSON.stringify(request)),
        validations: { visual: [], script: '' },
        captures: { visual: [], script: '' },
        postmanEvents: Array.isArray(item.event) ? item.event : undefined,
      };
      steps.push(step);
      tree.push({ type: 'request', name: step.name, method: request.method, url: request.url, stepId: step.id });
    }
  }
}

export function importCollection(raw: any): ImportResult {
  if (!raw || typeof raw !== 'object') throw new Error('Not a JSON object');
  const info = raw.info;
  const schema: string = info?.schema || '';
  if (!info || !Array.isArray(raw.item)) {
    throw new Error('Not a Postman collection: missing "info" or "item"');
  }
  if (schema && !/collection\/v2\.[01]/.test(schema)) {
    throw new Error(`Unsupported schema (${schema}); only Postman collection v2.0/v2.1 is supported`);
  }
  const steps: Step[] = [];
  const tree: TreeNode[] = [];
  walk(raw.item, [], steps, tree);
  const variables = Array.isArray(raw.variable)
    ? raw.variable.filter((v: any) => v && typeof v.key === 'string').map((v: any) => ({ key: v.key, value: String(v.value ?? '') }))
    : [];
  return { name: String(info.name || 'Imported collection'), steps, tree, variables };
}

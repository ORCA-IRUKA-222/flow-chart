// テスト用の、GitHub の contents API の最小限のまね。
// sha が合わない書き込みは 409 / 422 で拒否する（本物と同じ）。
import http from 'node:http';
import { createHash } from 'node:crypto';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

export async function startFakeGitHub({ token = 'good-token', repo = 'owner/data', isPrivate = true, port = 0 } = {}) {
  const files = new Map(); // path -> { text, sha }
  const commits = [];
  const server = http.createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match, Accept',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Expose-Headers': 'ETag',
    };
    const send = (status, body, headers = {}) => {
      const data = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json', ...cors, ...headers });
      res.end(data);
    };
    if (req.method === 'OPTIONS') return send(204);
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: 'Bad credentials' });
    const url = new URL(req.url, 'http://x');
    const base = `/repos/${repo}`;
    if (url.pathname === base) return send(200, { full_name: repo, private: isPrivate, permissions: { push: true } });
    if (!url.pathname.startsWith(`${base}/contents/`)) return send(404, { message: 'Not Found' });
    const path = decodeURIComponent(url.pathname.slice(`${base}/contents/`.length));
    let body = null;
    if (req.method === 'PUT' || req.method === 'DELETE') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    }

    if (req.method === 'GET') {
      // ディレクトリ
      const children = [...files.entries()].filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'));
      if (children.length) {
        const list = children.map(([p, f]) => ({ type: 'file', name: p.split('/').pop(), path: p, sha: f.sha }));
        const etag = `"${sha1(JSON.stringify(list))}"`;
        if (req.headers['if-none-match'] === etag) return send(304, undefined, { ETag: etag });
        return send(200, list, { ETag: etag });
      }
      const f = files.get(path);
      if (!f) return send(404, { message: 'Not Found' });
      if ((req.headers.accept || '').includes('raw')) return send(200, f.text, { 'Content-Type': 'text/plain' });
      const big = Buffer.byteLength(f.text) > 1_000_000;
      const b64 = Buffer.from(f.text).toString('base64').replace(/.{60}/g, '$&\n');
      return send(200, { type: 'file', path, sha: f.sha, size: Buffer.byteLength(f.text), encoding: big ? 'none' : 'base64', content: big ? '' : b64 });
    }
    if (req.method === 'PUT') {
      const cur = files.get(path);
      if (cur && !body.sha) return send(422, { message: '"sha" wasn\'t supplied.' });
      if (cur && body.sha !== cur.sha) return send(409, { message: `${path} does not match ${body.sha}` });
      if (!cur && body.sha) return send(409, { message: 'sha does not match' });
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      const f = { text, sha: sha1(`${path}\n${text}\n${commits.length}`) };
      files.set(path, f);
      commits.push(body.message);
      return send(cur ? 200 : 201, { content: { path, sha: f.sha } });
    }
    if (req.method === 'DELETE') {
      const cur = files.get(path);
      if (!cur) return send(404, { message: 'Not Found' });
      if (body.sha !== cur.sha) return send(409, { message: 'sha does not match' });
      files.delete(path);
      commits.push(body.message);
      return send(200, { commit: {} });
    }
    return send(405, { message: 'method' });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    port: server.address().port,
    api: `http://127.0.0.1:${server.address().port}`,
    files,
    commits,
    /** 他の端末が書き込んだことにする */
    write(path, data) {
      const text = JSON.stringify(data);
      files.set(path, { text, sha: sha1(`${path}\n${text}\n${commits.length}`) });
      commits.push('external');
    },
    read(path) {
      const f = files.get(path);
      return f ? JSON.parse(f.text) : null;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

// 直接起動したとき（ブラウザのテスト用）
if (process.argv[1] && process.argv[1].endsWith('fake-github.js')) {
  const gh = await startFakeGitHub({ port: Number(process.env.PORT) || 8802 });
  console.log(`fake GitHub API: ${gh.api}`);
}

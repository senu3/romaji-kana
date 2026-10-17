import { createKanaEngineClient } from './kana-engine-client.mjs';

export function kanaEnginePlugin() {
  const client = createKanaEngineClient();
  function install(server) {
    server.middlewares.use('/api/kana-engine', async (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
      let bytes = 0;
      const chunks = [];
      try {
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) { res.statusCode = 403; res.end(); return; }
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 128 * 1024) throw new Error('Request too large');
          chunks.push(chunk);
        }
        const result = await client.request(JSON.parse(Buffer.concat(chunks).toString()));
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
      } catch (error) {
        res.statusCode = 503; res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: String(error.message || error) }));
      }
    });
    server.httpServer?.once('close', () => client.close());
  }
  return { name: 'kana-engine', configureServer: install, configurePreviewServer: install, closeBundle: () => client.close() };
}

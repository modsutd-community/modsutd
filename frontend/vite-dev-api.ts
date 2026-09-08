import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadEnv, type Plugin } from 'vite';

// Runs the api/ handlers under `npm run dev`.
//
// Vite serves static files and nothing else, so every /api/* call 404s locally -
// which reads exactly like a broken feature ("could not open the thread (HTTP
// 404)") when the code is fine and there is simply no function behind it. In
// production Vercel runs these; this makes dev behave the same.
//
// `apply: 'serve'` keeps it out of every build. Nothing here ships.
export function devApi(): Plugin {
  return {
    name: 'modsutd-dev-api',
    apply: 'serve',
    configureServer(server) {
      // Handlers read process.env directly, exactly as they do on Vercel. Load
      // .env / .env.local with no prefix filter so MODSUTD_BOT_TOKEN and friends
      // work without VITE_ - which they must never carry, since that would
      // inline them into the public bundle.
      //
      // One place only: `.env.local` at the repo ROOT, not this directory. The
      // python tools and the relays want overlapping vars, and two files meant
      // the same token pasted twice and drifting. A real shell variable wins.
      const env = loadEnv(server.config.mode, path.resolve(server.config.root, '..'), '');
      for (const [k, v] of Object.entries(env)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }

      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/api/')) return next();

        const name = url.split('?')[0].slice('/api/'.length).replace(/\/$/, '');
        if (!/^[a-z0-9-]+$/.test(name)) return next();
        // The relays live at the repo ROOT, not under frontend/. Vercel's
        // Root Directory cannot reach above itself, so a project rooted at
        // frontend/ could serve them but could never build - the build reads
        // /data and .github/ISSUE_TEMPLATE, both above it.
        const file = path.resolve(server.config.root, '..', 'api', `${name}.js`);
        if (!existsSync(file)) return next();

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');

        // Vercel parses a JSON body for you; the handlers assume req.body.
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          body = undefined;
        }

        // Minimal stand-in for Vercel's response object - status().json() is all
        // the handlers use.
        const shim = {
          statusCode: 200,
          status(code: number) {
            res.statusCode = code;
            return shim;
          },
          json(payload: unknown) {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(payload));
          },
        };

        try {
          const mod = await server.ssrLoadModule(file);
          await (mod.default as (rq: unknown, rs: unknown) => unknown)(
            Object.assign(req, { body }),
            shim,
          );
        } catch (e) {
          server.config.logger.error(`[dev-api] ${name}: ${(e as Error).message}`);
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: `dev handler threw: ${(e as Error).message}` }));
        }
      });
    },
  };
}

import express from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedAdmin } from './db.js';
import { authRouter, usersRouter, requireAuth, enforcePermissions } from './auth.js';
import { collectionsRouter } from './routes/collections.js';
import { suitesRouter } from './routes/suites.js';
import { variablesRouter } from './routes/variables.js';
import { environmentsRouter } from './routes/environments.js';
import { runsRouter } from './routes/runs.js';
import { docsRouter } from './routes/docs.js';
import { filesRouter } from './routes/files.js';
import { metricsRouter } from './routes/metrics.js';
import { heraRouter } from './routes/hera.js';
import { mockRouter } from './mock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4000;

seedAdmin();

const app = express();
app.disable('x-powered-by');
// Suite bundles embed file blobs as base64, so they get a larger ceiling than
// the rest of the API. Mounted first: body-parser marks the body as read, so
// the 20mb parser below skips this path instead of rejecting it at 20mb.
app.use('/api/suites/import-bundle', express.json({ limit: '64mb' }));
app.use(express.json({ limit: '20mb' })); // postman collections can be large
app.use(cookieParser());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);

// Protected data API — requireAuth then role-based enforcePermissions. Grouped
// under one mount so enforcePermissions sees paths relative to /api.
const protectedApi = express.Router();
protectedApi.use(requireAuth, enforcePermissions);
protectedApi.use('/collections', collectionsRouter);
protectedApi.use('/suites', suitesRouter);
protectedApi.use('/variables', variablesRouter);
protectedApi.use('/environments', environmentsRouter);
protectedApi.use('/runs', runsRouter);
protectedApi.use('/docs', docsRouter);
protectedApi.use('/files', filesRouter);
protectedApi.use('/metrics', metricsRouter);
protectedApi.use('/hera', heraRouter);
app.use('/api', protectedApi);

// demo target API for trying out suites without an external service
app.use('/mock', mockRouter);

// serve built frontend in production (single-container deployment)
const dist = join(__dirname, '..', '..', 'frontend', 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/(api|mock)\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err?.message || 'Internal error' });
});

app.listen(PORT, () => console.log(`[hermes] backend listening on http://localhost:${PORT}`));

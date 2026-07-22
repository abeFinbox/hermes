import { Router } from 'express';
import os from 'node:os';

export const metricsRouter = Router();

// Rolling buffer of process resource samples, so a freshly-opened UI gets
// ~2 minutes of history instantly instead of an empty graph.
interface Sample {
  t: number; // epoch ms
  cpu: number; // process CPU % of one core over the sample window (0–100)
  rss: number; // bytes
  heapUsed: number; // bytes
}

const SAMPLE_MS = 2000;
const MAX_SAMPLES = 60;
const samples: Sample[] = [];

let lastCpu = process.cpuUsage();
let lastAt = process.hrtime.bigint();

function takeSample() {
  const nowCpu = process.cpuUsage();
  const nowAt = process.hrtime.bigint();
  const elapsedUs = Number(nowAt - lastAt) / 1000;
  const usedUs = nowCpu.user - lastCpu.user + (nowCpu.system - lastCpu.system);
  lastCpu = nowCpu;
  lastAt = nowAt;
  const cpu = elapsedUs > 0 ? Math.min(100, Math.max(0, (usedUs / elapsedUs) * 100)) : 0;
  const mem = process.memoryUsage();
  samples.push({ t: Date.now(), cpu: Math.round(cpu * 10) / 10, rss: mem.rss, heapUsed: mem.heapUsed });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

takeSample();
setInterval(takeSample, SAMPLE_MS).unref(); // unref: never keeps the process alive

metricsRouter.get('/', (_req, res) => {
  res.json({ samples, totalMem: os.totalmem(), sampleMs: SAMPLE_MS });
});

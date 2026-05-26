// src/main.ts
// Entry point for skillos_x_robot.
// Sets up HAL, loads skills + memory stores, starts WebSocket + HTTP servers,
// exposes REST API for dashboard, and waits for commands.

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws';

import type { Landmark, WsMessage } from './types';
import { SimulatorHAL } from './hal';
import { createBackend, type Backend, type BackendType } from './backend';
import { loadSkills } from './skills';
import { MemoryStore } from './memory';
import { SessionTraceRecorder } from './session_trace';
import { DreamEngine } from './dream';
import { Agent } from './agent';
import { createIOAdapter, DemoStubIOAdapter } from './io';

// ── Load env ───────────────────────────────────────────────────

dotenv.config();

// ── CLI args ───────────────────────────────────────────────────

const args = process.argv.slice(2);
const useStub = args.includes('--stub');
const useDemo = args.includes('--demo') || useStub;
const taskIdx = args.indexOf('--task');
const defaultTask = taskIdx >= 0 && args[taskIdx + 1]
  ? args[taskIdx + 1]
  : 'You are a facility patrol robot. Begin your patrol route: visit each checkpoint (server room, emergency exit, supply closet, main entrance), observe and report status at each. If you encounter staff, greet them and ask for instructions. Log your patrol findings in memory.';

const backendIdx = args.indexOf('--backend');
const backendType: BackendType = (backendIdx >= 0 && args[backendIdx + 1]
  ? args[backendIdx + 1] as BackendType
  : (process.env.AGENT_BACKEND as BackendType) || 'gemma4');

const wsPort = parseInt(process.env.SIM_WS_PORT || '9091', 10);
const httpPort = parseInt(process.env.SIM_HTTP_PORT || '9092', 10);

// ── Default arena landmarks ────────────────────────────────────

const ARENA_LANDMARKS: Landmark[] = [
  { id: 'server_room',      label: 'Server Room',      x: 0.0,  y: 1.6,  type: 'door' },
  { id: 'emergency_exit',   label: 'Emergency Exit',   x: -1.5, y: 1.5,  type: 'door' },
  { id: 'supply_closet',    label: 'Supply Closet',    x: 1.3,  y: -0.5, type: 'door' },
  { id: 'main_entrance',    label: 'Main Entrance',    x: -1.0, y: -1.2, type: 'door' },
  { id: 'guard_carlos',     label: 'Carlos',           x: 0.5,  y: 0.3,  type: 'person' },
  { id: 'fire_extinguisher', label: 'Fire Extinguisher', x: -0.8, y: 0.5, type: 'object' },
];

// ── WebSocket server ───────────────────────────────────────────

const wss = new WebSocketServer({ port: wsPort });
const wsClients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
});

function broadcast(msg: WsMessage): void {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// ── HTTP helpers ───────────────────────────────────────────────

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  console.log(`
  ┌────────────────────────────────────────────────┐
  │  skillos_x_robot — skill-driven agent          │
  │  Dashboard: http://localhost:${httpPort}            │
  │  WebSocket: ws://localhost:${wsPort}               │
  │  Backend: ${backendType.padEnd(36)}│
  │  Mode: ${(useDemo ? 'demo (stub I/O)' : 'interactive').padEnd(38)}│
  └────────────────────────────────────────────────┘
  `);

  // I/O adapter
  const io = createIOAdapter(useDemo ? 'demo' : 'console');

  // HAL
  const hal = new SimulatorHAL({
    landmarks: ARENA_LANDMARKS,
    io,
    startPosition: { x: -0.5, y: -1.0, heading: 90 },
    observeRadius: 3.5,
  });

  // Backend
  const backend: Backend = createBackend(backendType);

  // Skills
  const skillsDir = path.resolve(__dirname, '../skills');
  const skills = loadSkills(skillsDir);
  console.log(`  [main] Loaded ${skills.length} skill(s) from ${skillsDir}`);

  // Memory stores
  const memoryDir = process.env.MEMORY_DIR
    ? path.resolve(process.env.MEMORY_DIR)
    : path.resolve(__dirname, '../memory');
  let memoryStores = MemoryStore.loadAll(memoryDir);
  console.log(`  [main] Loaded ${memoryStores.size} memory store(s) from ${memoryDir}`);

  // Session trace recorder
  const tracesDir = process.env.TRACES_DIR
    ? path.resolve(process.env.TRACES_DIR)
    : path.resolve(__dirname, '../traces');
  const recorder = new SessionTraceRecorder(tracesDir);

  // ── State ──────────────────────────────────────────────────

  let agentRunning = false;
  let dreamRunning = false;
  let runNumber = 0;

  // ── Run session ────────────────────────────────────────────

  async function runSession(sessionTask: string): Promise<void> {
    agentRunning = true;
    runNumber++;

    try {
      // Reload memory stores (picks up dream-consolidated data)
      memoryStores = MemoryStore.loadAll(memoryDir);

      // Reset HAL position
      hal.reset();
      const initPos = hal.getPosition();
      broadcast({ type: 'pose', x: initPos.x, y: initPos.y, heading: initPos.heading });

      // Set demo run number
      if (io instanceof DemoStubIOAdapter) {
        io.setRunNumber(runNumber);
      }

      // Create fresh agent
      const agent = new Agent({
        backend,
        hal,
        skills,
        memoryStores,
        maxTurns: 50,
        broadcast,
      });

      const result = await agent.run(sessionTask);

      // Save session trace
      const tracePath = recorder.save(
        {
          timestamp: new Date().toISOString(),
          task: sessionTask,
          outcome: result.outcome,
          durationMs: result.durationMs,
          turns: result.turns,
          model: backend.getModel(),
          skillsLoaded: result.skillsLoaded,
          memoryReads: result.memoryReads,
          memoryWrites: result.memoryWrites,
        },
        result.messages,
      );
      console.log(`  [main] Session trace saved to ${tracePath}`);
    } catch (err) {
      console.error(`  [main] Agent error: ${err}`);
      broadcast({ type: 'halt', status: 'error' });
    } finally {
      agentRunning = false;
    }
  }

  // ── HTTP server with REST API ──────────────────────────────

  const simHtmlPath = path.resolve(__dirname, '../sim/sim2d.html');

  const httpServer = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = new URL(req.url || '/', `http://localhost:${httpPort}`);
    const pathname = url.pathname;

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    try {
      // ── Serve dashboard ──────────────────────────────────
      if (pathname === '/' && method === 'GET') {
        fs.readFile(simHtmlPath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end('not found');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data);
        });
        return;
      }

      // ── GET /api/status ──────────────────────────────────
      if (pathname === '/api/status' && method === 'GET') {
        jsonResponse(res, {
          running: agentRunning,
          dreaming: dreamRunning,
          runNumber,
          backend: backendType,
          model: backend.getModel(),
        });
        return;
      }

      // ── GET /api/skills ──────────────────────────────────
      if (pathname === '/api/skills' && method === 'GET') {
        jsonResponse(res, skills.map(s => ({
          name: s.meta.name,
          description: s.meta.description,
        })));
        return;
      }

      // ── GET /api/skills/:name ────────────────────────────
      const skillMatch = pathname.match(/^\/api\/skills\/(.+)$/);
      if (skillMatch && method === 'GET') {
        const name = decodeURIComponent(skillMatch[1]);
        const skill = skills.find(s => s.meta.name === name);
        if (!skill) {
          jsonResponse(res, { error: `Skill "${name}" not found` }, 404);
          return;
        }
        jsonResponse(res, {
          name: skill.meta.name,
          description: skill.meta.description,
          instructions: skill.instructions,
        });
        return;
      }

      // ── GET /api/memory ──────────────────────────────────
      if (pathname === '/api/memory' && method === 'GET') {
        const stores: Array<Record<string, unknown>> = [];
        for (const [name, store] of memoryStores) {
          const docs = store.list();
          stores.push({
            name,
            description: store.getManifest().description,
            access: store.getManifest().access,
            documents: docs.length,
          });
        }
        jsonResponse(res, stores);
        return;
      }

      // ── GET /api/memory/:store ───────────────────────────
      const storeMatch = pathname.match(/^\/api\/memory\/([^/]+)$/);
      if (storeMatch && method === 'GET') {
        const storeName = decodeURIComponent(storeMatch[1]);
        const store = memoryStores.get(storeName);
        if (!store) {
          jsonResponse(res, { error: `Store "${storeName}" not found` }, 404);
          return;
        }
        const docs = store.list();
        jsonResponse(res, {
          name: storeName,
          manifest: store.getManifest(),
          documents: docs,
        });
        return;
      }

      // ── GET /api/memory/:store/:path ─────────────────────
      const docMatch = pathname.match(/^\/api\/memory\/([^/]+)\/(.+)$/);
      if (docMatch && method === 'GET') {
        const storeName = decodeURIComponent(docMatch[1]);
        const docPath = decodeURIComponent(docMatch[2]);
        const store = memoryStores.get(storeName);
        if (!store) {
          jsonResponse(res, { error: `Store "${storeName}" not found` }, 404);
          return;
        }
        const doc = store.read(docPath);
        if (!doc) {
          jsonResponse(res, { error: `Document "${docPath}" not found` }, 404);
          return;
        }
        jsonResponse(res, doc);
        return;
      }

      // ── GET /api/traces ──────────────────────────────────
      if (pathname === '/api/traces' && method === 'GET') {
        const transcripts = SessionTraceRecorder.loadTranscripts(tracesDir, 50);
        jsonResponse(res, transcripts.map(t => ({
          timestamp: t.meta.timestamp,
          task: t.meta.task,
          outcome: t.meta.outcome,
          turns: t.meta.turns,
          durationMs: t.meta.durationMs,
          model: t.meta.model,
          skillsLoaded: t.meta.skillsLoaded,
          memoryReads: t.meta.memoryReads,
          memoryWrites: t.meta.memoryWrites,
          summary: t.summary,
        })));
        return;
      }

      // ── POST /api/run ────────────────────────────────────
      if (pathname === '/api/run' && method === 'POST') {
        if (agentRunning) {
          jsonResponse(res, { error: 'Agent is already running' }, 409);
          return;
        }
        const body = await readBody(req);
        let parsed: { task?: string } = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* default */ }
        const sessionTask = parsed.task || defaultTask;

        // Respond immediately, run in background
        jsonResponse(res, { status: 'started', runNumber: runNumber + 1, task: sessionTask });

        // Run asynchronously
        runSession(sessionTask).catch(err => {
          console.error(`  [main] Async run error: ${err}`);
        });
        return;
      }

      // ── POST /api/dream ──────────────────────────────────
      if (pathname === '/api/dream' && method === 'POST') {
        if (dreamRunning) {
          jsonResponse(res, { error: 'Dream consolidation is already running' }, 409);
          return;
        }
        if (agentRunning) {
          jsonResponse(res, { error: 'Cannot dream while agent is running' }, 409);
          return;
        }
        dreamRunning = true;
        broadcast({ type: 'dream_progress', stage: 'starting', detail: 'Initializing dream engine...' });

        try {
          const dreamBackend = createBackend(backendType, { maxTokens: 4096 });
          const engine = new DreamEngine(
            { memoryDir, tracesDir, outputStore: 'consolidated', maxTranscripts: 100 },
            dreamBackend,
          );

          broadcast({ type: 'dream_progress', stage: 'consolidating', detail: 'Processing transcripts and memories...' });
          const result = await engine.dream();
          broadcast({ type: 'dream_complete', result });

          // Reload memory stores
          memoryStores = MemoryStore.loadAll(memoryDir);

          jsonResponse(res, result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          jsonResponse(res, { error: message }, 500);
        } finally {
          dreamRunning = false;
        }
        return;
      }

      // ── POST /api/reset ──────────────────────────────────
      if (pathname === '/api/reset' && method === 'POST') {
        if (agentRunning) {
          jsonResponse(res, { error: 'Cannot reset while agent is running' }, 409);
          return;
        }
        if (dreamRunning) {
          jsonResponse(res, { error: 'Cannot reset while dreaming' }, 409);
          return;
        }

        // Delete all documents from writable stores (keep manifests)
        for (const [, store] of memoryStores) {
          const docs = store.list();
          for (const doc of docs) {
            store.delete(doc.path);
          }
        }

        // Delete consolidated store directory if it exists
        const consolidatedDir = path.join(memoryDir, 'consolidated');
        if (fs.existsSync(consolidatedDir)) {
          fs.rmSync(consolidatedDir, { recursive: true });
        }

        // Clear traces
        if (fs.existsSync(tracesDir)) {
          const traceFiles = fs.readdirSync(tracesDir).filter(f => f.endsWith('.md'));
          for (const f of traceFiles) {
            fs.unlinkSync(path.join(tracesDir, f));
          }
        }

        // Reload memory stores
        memoryStores = MemoryStore.loadAll(memoryDir);
        runNumber = 0;

        // Reset HAL
        hal.reset();
        const pos = hal.getPosition();
        broadcast({ type: 'pose', x: pos.x, y: pos.y, heading: pos.heading });

        jsonResponse(res, { status: 'reset', stores: memoryStores.size });
        return;
      }

      // ── 404 ──────────────────────────────────────────────
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      console.error(`  [main] HTTP error: ${err}`);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    }
  });

  httpServer.listen(httpPort);

  // Broadcast initial pose
  const initPos = hal.getPosition();
  broadcast({ type: 'pose', x: initPos.x, y: initPos.y, heading: initPos.heading });

  console.log(`  [main] Dashboard ready. Open http://localhost:${httpPort} to begin.`);
  console.log(`  [main] Waiting for commands via dashboard...\n`);

  // Keep process alive — servers stay open
  // Process exits via Ctrl+C
}

main().catch(console.error);

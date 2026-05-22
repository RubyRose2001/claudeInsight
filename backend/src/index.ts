import { buildApp } from './app.js';
import { liveSessionManager } from './services/liveSessionManager.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || 'localhost';

async function start() {
  const app = await buildApp();

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, cleaning up live pty sessions...`);
    try {
      liveSessionManager.killAll();
    } catch (e) {
      console.error('killAll error:', e);
    }
    try {
      await app.close();
    } catch (e) {
      console.error('app.close error:', e);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`Server running at http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();

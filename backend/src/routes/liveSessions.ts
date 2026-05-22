/**
 * 活跃会话路由
 * HTTP: 创建 / 列出 / 详情 / 终止
 * WebSocket: 双向 IO（input / output / resize / exit）
 */

import { FastifyPluginAsync } from 'fastify';
import { liveSessionManager } from '../services/liveSessionManager.js';
import type {
  CreateLiveSessionRequest,
  LiveSessionDownMessage,
  LiveSessionUpMessage,
} from '../types/liveSession.js';

const liveSessionsRoutes: FastifyPluginAsync = async (fastify) => {
  /** GET /api/live-sessions - 列出当前内存中所有 pty */
  fastify.get('/', async () => {
    return liveSessionManager.list();
  });

  /** GET /api/live-sessions/:id - 单条详情 */
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const info = liveSessionManager.getInfo(request.params.id);
    if (!info) {
      reply.code(404);
      return { error: 'live session not found' };
    }
    return info;
  });

  /** POST /api/live-sessions - 创建新 pty */
  fastify.post<{ Body: CreateLiveSessionRequest }>('/', async (request, reply) => {
    const body = request.body ?? ({} as CreateLiveSessionRequest);
    if (!body.projectPath) {
      reply.code(400);
      return { error: 'projectPath is required' };
    }
    try {
      const info = await liveSessionManager.create(body);
      return info;
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** DELETE /api/live-sessions/:id - 终止 pty */
  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const ok = liveSessionManager.kill(request.params.id);
    if (!ok) {
      reply.code(404);
      return { error: 'live session not found' };
    }
    return { success: true };
  });

  /**
   * WebSocket /api/live-sessions/:id/ws
   * 协议见 src/types/liveSession.ts
   */
  fastify.get<{ Params: { id: string } }>(
    '/:id/ws',
    { websocket: true },
    (socket, request) => {
      const handle = liveSessionManager.get(request.params.id);
      if (!handle) {
        try {
          socket.close(4004, 'live session not found');
        } catch {
          // ignore
        }
        return;
      }

      const send = (msg: LiveSessionDownMessage) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(msg));
        }
      };

      // 入场：发当前会话信息
      send({ type: 'ready', info: handle.info });

      // Replay 近期输出缓冲，让重新接入的 xterm 把屏幕状态（光标位置、
      // alt buffer、mouse reporting 等模式）追到 Claude Code 当前的状态。
      // JS 单线程，这里读 buffer 再 subscribe 是原子的，不会丢中间帧。
      if (handle.outputBuffer.length > 0) {
        send({ type: 'output', data: handle.outputBuffer });
      }

      const onData = (data: string) => send({ type: 'output', data });
      const onExit = (code: number) => {
        send({ type: 'exit', code });
        try {
          socket.close(1000);
        } catch {
          // ignore
        }
      };

      handle.emitter.on('data', onData);
      handle.emitter.once('exit', onExit);

      // 若会话已经退出（极端竞态），立即通知并关闭
      if (handle.info.status === 'exited') {
        onExit(handle.info.exitCode ?? 0);
      }

      socket.on('message', (raw: Buffer) => {
        let msg: LiveSessionUpMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === 'input') {
          liveSessionManager.write(request.params.id, msg.data);
        } else if (msg.type === 'resize') {
          liveSessionManager.resize(request.params.id, msg.cols, msg.rows);
        }
      });

      // 连接关闭：只解订阅，不杀 pty（切 tab 时保留会话）
      socket.on('close', () => {
        handle.emitter.off('data', onData);
        handle.emitter.off('exit', onExit);
      });
    },
  );
};

export default liveSessionsRoutes;

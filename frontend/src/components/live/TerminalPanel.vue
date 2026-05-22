<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { openLiveSessionWs } from '@/api/liveSessions';
import { useLiveSessionStore } from '@/stores/liveSessionStore';
import type { LiveSessionDownMessage } from '@/types/liveSession';

const props = defineProps<{ liveId: string }>();

const termEl = ref<HTMLDivElement | null>(null);
const liveSessionStore = useLiveSessionStore();

let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let ws: WebSocket | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeTimer: number | null = null;
let dataDisposable: { dispose: () => void } | null = null;
let exited = false;

function teardown() {
  if (resizeTimer !== null) {
    window.clearTimeout(resizeTimer);
    resizeTimer = null;
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (termEl.value) {
    termEl.value.removeEventListener('contextmenu', onContextMenu);
  }
  if (dataDisposable) {
    dataDisposable.dispose();
    dataDisposable = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
    ws = null;
  }
  if (term) {
    try {
      term.dispose();
    } catch {
      // ignore
    }
    term = null;
  }
  fitAddon = null;
  exited = false;
}

function sendResize() {
  if (!fitAddon || !term || !ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    fitAddon.fit();
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  } catch {
    // ignore
  }
}

function scheduleResize() {
  if (resizeTimer !== null) {
    window.clearTimeout(resizeTimer);
  }
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null;
    sendResize();
  }, 100);
}

function setup(liveId: string) {
  if (!termEl.value) return;

  term = new Terminal({
    fontFamily:
      "'JetBrains Mono','Fira Code','SF Mono',Monaco,'Cascadia Code',Consolas,'Liberation Mono',Menlo,monospace",
    fontSize: 13,
    cursorBlink: true,
    convertEol: false,
    scrollback: 5000,
    rightClickSelectsWord: false,
    theme: {
      background: '#0b0b0e',
      foreground: '#e5e7eb',
    },
  });

  // Ctrl+C 有选中时复制并阻止发 SIGINT;无选中则照常发 ^C。
  // Ctrl+V 自己读剪贴板 + preventDefault 阻止浏览器再触发 paste 事件,
  // 否则 xterm 的原生 paste handler 会再发一次,导致双倍粘贴。
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const key = e.key.toLowerCase();
    if (e.ctrlKey && !e.altKey && key === 'c') {
      const sel = term?.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
        term?.clearSelection();
        return false;
      }
    }
    if (e.ctrlKey && !e.altKey && key === 'v') {
      e.preventDefault();
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data: text }));
          }
        })
        .catch(() => {});
      return false;
    }
    return true;
  });

  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(termEl.value);

  // 等浏览器把 flex 容器尺寸 layout 完再 fit，否则 cols/rows 算错,
  // pty 按错的尺寸渲染 TUI，光标会跑到 Claude Code 输入框外面去。
  requestAnimationFrame(() => {
    try {
      fitAddon?.fit();
    } catch {
      // ignore
    }
    sendResize();
  });

  ws = openLiveSessionWs(liveId);

  ws.addEventListener('open', () => {
    sendResize();
  });

  ws.addEventListener('message', (ev) => {
    let msg: LiveSessionDownMessage;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      sendResize();
    } else if (msg.type === 'output') {
      term?.write(msg.data);
    } else if (msg.type === 'exit') {
      exited = true;
      term?.writeln(`\r\n\x1b[2m[process exited code=${msg.code}]\x1b[0m`);
      liveSessionStore.markExited(liveId, msg.code);
    }
  });

  ws.addEventListener('close', () => {
    if (!exited) {
      term?.writeln('\r\n\x1b[2m[connection closed]\x1b[0m');
    }
  });

  dataDisposable = term.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  // 不拦截 wheel 事件：让 xterm.js 走默认逻辑。
  // 正常 buffer 下它会滚 scrollback；alt buffer 下如果 TUI（Claude Code）启用了
  // 鼠标上报（DECSET 1000/1006 等），xterm 会把滚轮编码成转义序列转发，
  // 由 TUI 自己决定怎么滚。之前手动转方向键既没在 Claude Code 里实现滚屏，
  // 又会和它的鼠标上报打架。

  // 右键直接粘贴剪贴板内容,绕开 TUI 的鼠标上报。
  termEl.value.addEventListener('contextmenu', onContextMenu);

  resizeObserver = new ResizeObserver(() => scheduleResize());
  resizeObserver.observe(termEl.value);
}

function onContextMenu(e: MouseEvent) {
  e.preventDefault();
  navigator.clipboard
    .readText()
    .then((text) => {
      if (text && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: text }));
      }
    })
    .catch(() => {});
}

onMounted(() => {
  setup(props.liveId);
});

onBeforeUnmount(() => {
  teardown();
});
</script>

<template>
  <div class="relative h-full w-full bg-[#0b0b0e]">
    <div ref="termEl" class="h-full w-full"></div>
    <div
      class="pointer-events-none absolute bottom-1 right-2 text-[10px] text-white/30 select-none"
    >
      Ctrl+C 复制 · Ctrl+V / 右键 粘贴
    </div>
  </div>
</template>

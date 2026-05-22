<script setup lang="ts">
/**
 * 目录选择 Modal
 * - 浏览整台机器的目录结构(后端做实际 readdir)
 * - 起步路径默认 home;支持面包屑/上级/Home 跳转
 * - 支持地址栏手动输入路径并回车跳转(Mac 上 `~` 会展开为 home)
 * - Windows 上 cwd 为空时显示盘符列表
 */
import { ref, computed, watch, nextTick } from 'vue';
import { Folder, ArrowUp, Home, Loader2, AlertCircle, HardDrive, CornerDownLeft } from 'lucide-vue-next';
import Dialog from '@/components/ui/Dialog.vue';
import { fsApi, type FsBrowseEntry } from '@/api/fs';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'select', path: string): void;
}>();

const cwd = ref<string>('');
const parent = ref<string | null>(null);
const entries = ref<FsBrowseEntry[]>([]);
const isDriveList = ref(false);
const home = ref<string>('');
const platformName = ref<string>('');

const loading = ref(false);
const error = ref<string | null>(null);

/** 地址栏手输框的双向绑定值。每次成功 load 后会同步成 cwd。 */
const pendingPath = ref<string>('');
const addressInput = ref<HTMLInputElement | null>(null);

const isWindows = computed(() => platformName.value === 'win32');
const sep = computed(() => (isWindows.value ? '\\' : '/'));

/** 面包屑:把 cwd 拆成可点击片段,每段对应跳到那一层的绝对路径 */
const crumbs = computed<{ label: string; path: string }[]>(() => {
  if (isDriveList.value || !cwd.value) return [];
  if (isWindows.value) {
    // 例:"C:\Users\ASUS\Desktop" -> ["C:\", "Users", "ASUS", "Desktop"]
    const parts = cwd.value.split(/\\+/).filter(Boolean);
    const out: { label: string; path: string }[] = [];
    if (parts.length === 0) return out;
    const first = parts[0]!; // 如 "C:"
    out.push({ label: `${first}\\`, path: `${first}\\` });
    let acc = `${first}\\`;
    for (let i = 1; i < parts.length; i++) {
      acc = `${acc}${parts[i]}\\`;
      out.push({ label: parts[i]!, path: acc.replace(/\\$/, '') });
    }
    return out;
  }
  // POSIX: "/Users/ASUS/Desktop" -> ["/", "Users", "ASUS", "Desktop"]
  const parts = cwd.value.split('/').filter(Boolean);
  const out: { label: string; path: string }[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const p of parts) {
    acc = `${acc}/${p}`;
    out.push({ label: p, path: acc });
  }
  return out;
});

/** 把 `~` 或 `~/foo` 展开成 home/foo(只在 POSIX 上有意义,Win 也兼容) */
function expandTilde(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed === '~') return home.value || trimmed;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return home.value ? `${home.value}${trimmed.slice(1)}` : trimmed;
  }
  return trimmed;
}

async function load(path: string) {
  loading.value = true;
  error.value = null;
  try {
    const res = await fsApi.browse(path);
    cwd.value = res.cwd;
    parent.value = res.parent;
    entries.value = res.entries;
    isDriveList.value = res.isDriveList;
    platformName.value = res.platform;
    home.value = res.home;
    // 同步地址栏(盘符列表时清空,免得用户以为可以提交空路径)
    pendingPath.value = res.isDriveList ? '' : res.cwd;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

function enter(entry: FsBrowseEntry) {
  void load(entry.path);
}

function goUp() {
  // Windows 在盘符根时 parent === "",触发盘符列表;故只在 null 时拦截
  if (parent.value === null) return;
  void load(parent.value);
}

function goHome() {
  void load(home.value || '');
}

function goCrumb(p: string) {
  void load(p);
}

/** 用户在地址栏回车或点 "跳转":展开 ~ 后送给后端;失败由 load 写到 error */
function submitAddress() {
  const expanded = expandTilde(pendingPath.value);
  if (!expanded) return;
  void load(expanded);
}

function confirm() {
  if (isDriveList.value || !cwd.value) return;
  emit('select', cwd.value);
  emit('update:open', false);
}

function cancel() {
  emit('update:open', false);
}

// 首次打开时加载默认目录(空 path → 后端默认 home,Win 上空也可走盘符;两端约定走 home)
watch(
  () => props.open,
  (val) => {
    if (val) {
      error.value = null;
      void load('');
      // 打开后把焦点放进地址栏,方便用户直接粘贴
      void nextTick(() => addressInput.value?.focus());
    }
  },
  { immediate: true },
);
</script>

<template>
  <Dialog
    :open="props.open"
    @update:open="(v) => emit('update:open', v)"
    title="选择项目目录"
    size="lg"
  >
    <div class="space-y-3">
      <!-- 工具栏:Home / 上级 / 面包屑 -->
      <div class="flex items-center gap-1 flex-wrap">
        <button
          @click="goHome"
          class="p-1.5 rounded-md hover:bg-muted text-muted-foreground transition-colors"
          title="回到 Home"
        >
          <Home class="w-4 h-4" />
        </button>
        <button
          @click="goUp"
          :disabled="parent === null"
          class="p-1.5 rounded-md hover:bg-muted text-muted-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="上级目录"
        >
          <ArrowUp class="w-4 h-4" />
        </button>
        <div class="flex-1 min-w-0 px-2 py-1 text-sm font-mono bg-muted/40 rounded-md border border-border overflow-x-auto whitespace-nowrap">
          <template v-if="isDriveList">
            <span class="text-muted-foreground">此电脑</span>
          </template>
          <template v-else-if="crumbs.length > 0">
            <template v-for="(c, idx) in crumbs" :key="c.path">
              <!-- 根 crumb(C:\ 或 /)自带分隔符,所以从 idx >= 2 起才在前面加 sep -->
              <span v-if="idx >= 2" class="mx-0.5 text-muted-foreground">{{ sep }}</span>
              <button
                @click="goCrumb(c.path)"
                class="hover:text-primary hover:underline"
              >
                {{ c.label }}
              </button>
            </template>
          </template>
          <span v-else class="text-muted-foreground">—</span>
        </div>
      </div>

      <!-- 地址栏:手动输入或粘贴路径,回车跳转(支持 ~ 展开) -->
      <div class="flex items-center gap-2">
        <input
          ref="addressInput"
          v-model="pendingPath"
          @keydown.enter.prevent="submitAddress"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :placeholder="isWindows ? '例如 C:\\Users\\me\\projects' : '例如 /Users/me/projects 或 ~/projects'"
          class="flex-1 min-w-0 px-2 py-1 text-sm font-mono bg-background border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <button
          @click="submitAddress"
          :disabled="!pendingPath.trim() || loading"
          class="px-2 py-1 rounded-md text-xs border border-border hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
          title="跳转到该路径(回车)"
        >
          <CornerDownLeft class="w-3.5 h-3.5" />
          跳转
        </button>
      </div>

      <!-- 错误 -->
      <div
        v-if="error"
        class="flex items-start gap-2 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-xs"
      >
        <AlertCircle class="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span class="break-all">{{ error }}</span>
      </div>

      <!-- 列表 -->
      <div class="border border-border rounded-md bg-card/40 h-80 overflow-y-auto">
        <div
          v-if="loading"
          class="h-full flex items-center justify-center text-muted-foreground"
        >
          <Loader2 class="w-5 h-5 animate-spin" />
        </div>
        <div
          v-else-if="entries.length === 0 && !error"
          class="h-full flex items-center justify-center text-sm text-muted-foreground"
        >
          {{ isDriveList ? '未发现可用盘符' : '空目录' }}
        </div>
        <ul v-else class="py-1">
          <li v-for="e in entries" :key="e.path">
            <button
              @click="enter(e)"
              class="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/60 transition-colors text-sm"
            >
              <component
                :is="isDriveList ? HardDrive : Folder"
                class="w-4 h-4 flex-shrink-0 text-muted-foreground"
              />
              <span class="truncate">{{ e.name }}</span>
            </button>
          </li>
        </ul>
      </div>

      <!-- 已选路径回显 -->
      <div class="text-xs text-muted-foreground">
        将在以下目录创建会话:
        <span class="font-mono text-foreground break-all">
          {{ isDriveList || !cwd ? '(请进入一个具体目录)' : cwd }}
        </span>
      </div>
    </div>

    <template #footer>
      <button
        @click="cancel"
        class="px-3 py-1.5 rounded-md text-sm border border-border hover:bg-muted transition-colors"
      >
        取消
      </button>
      <button
        @click="confirm"
        :disabled="isDriveList || !cwd || loading"
        class="px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        选择此目录
      </button>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { useOperationsStore } from '~/stores/operations'

const store = useOperationsStore()
const route = useRoute()
const open = ref(false)
const pendingFollowUps = computed(() => store.followUps.filter((item) => item.status === '待处理'))
const nav = [
  { to: '/', label: '状态看板', icon: 'i-heroicons-chart-bar-square' },
  { to: '/permits', label: '作业许可', icon: 'i-heroicons-clipboard-document-check' },
  { to: '/devices', label: '隔离与锁定', icon: 'i-heroicons-lock-closed' },
  { to: '/audit', label: '审计记录', icon: 'i-heroicons-clock' },
]
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar" :class="{ open }">
      <div class="brand"><span>风</span><div><b>风场作业许可台</b><small>LOCKOUT CONTROL</small></div></div>
      <nav>
        <NuxtLink v-for="item in nav" :key="item.to" :to="item.to" :class="{ active: route.path === item.to }"><UIcon :name="item.icon" /><span>{{ item.label }}</span></NuxtLink>
      </nav>
      <div class="site-card"><span class="pulse" /><div><b>海州湾 H2 风电场</b><small>统一重算链路在线</small></div></div>
    </aside>
    <div class="content">
      <header class="topbar">
        <UButton class="mobile-menu" icon="i-heroicons-bars-3" color="gray" variant="ghost" @click="open = !open" />
        <div><b>运行中 · A 区集电线路检修</b><span class="muted desktop-only">值班负责人：李骁 · 2026-09-30</span></div>
        <span class="flex-1" />
        <UBadge :color="store.connection === '在线' ? 'green' : 'amber'" variant="subtle">{{ store.connection }}</UBadge>
        <UButton v-if="store.connection === '在线'" size="sm" color="gray" variant="outline" icon="i-heroicons-signal-slash" @click="store.markOffline">模拟断网</UButton>
        <template v-else>
          <UButton size="sm" color="gray" variant="outline" icon="i-heroicons-bolt" @click="store.simulateRemoteIntent">模拟对端推进</UButton>
          <UButton size="sm" color="amber" variant="soft" icon="i-heroicons-arrow-path" @click="store.reconnect">重连合并 ({{ store.outbox.length }})</UButton>
        </template>
        <UButton to="/#coordination" size="sm" :color="pendingFollowUps.length ? 'red' : 'gray'" :variant="pendingFollowUps.length ? 'soft' : 'ghost'" icon="i-heroicons-user-group">
          待协调 {{ pendingFollowUps.length }}
        </UButton>
        <UButton icon="i-heroicons-plus" color="primary" @click="navigateTo('/permits?new=1')">新建许可</UButton>
      </header>
      <main class="main"><slot /></main>
    </div>
  </div>
</template>

<style scoped>
.app-shell{min-height:100vh;display:flex}.sidebar{width:236px;background:#0f172a;color:#e2e8f0;padding:18px 12px;display:flex;flex-direction:column;position:sticky;top:0;height:100vh}.brand{display:flex;gap:11px;align-items:center;padding:4px 8px 22px;border-bottom:1px solid #233047}.brand>span{display:grid;place-items:center;width:38px;height:38px;border-radius:8px;background:#0891b2;font-weight:800}.brand b,.brand small{display:block}.brand small{font-size:9px;color:#7f8c9f;letter-spacing:1px}.sidebar nav{display:grid;gap:5px;padding:16px 0;flex:1}.sidebar a{display:flex;gap:10px;align-items:center;padding:11px 12px;border-radius:7px;color:#aebbd0;text-decoration:none;font-size:14px}.sidebar a:hover,.sidebar a.active{background:#1e293b;color:#fff}.sidebar a.active{box-shadow:inset 3px 0 #22d3ee}.site-card{display:flex;align-items:center;gap:10px;background:#151f31;border:1px solid #263247;border-radius:8px;padding:12px}.site-card b,.site-card small{display:block;font-size:13px}.site-card small{color:#8290a7;margin-top:4px}.pulse{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 4px #165e35}.content{min-width:0;flex:1}.topbar{height:68px;background:#fff;border-bottom:1px solid #dfe5ec;display:flex;align-items:center;gap:10px;padding:0 22px;position:sticky;top:0;z-index:20}.topbar span{font-size:12px}.main{padding:22px}.mobile-menu{display:none}
@media(max-width:1100px){.desktop-only{display:none}}@media(max-width:900px){.sidebar{position:fixed;left:-250px;z-index:50;transition:.2s}.sidebar.open{left:0}.content{width:100%}.mobile-menu{display:inline-flex}.main{padding:14px}.topbar{padding:0 12px;gap:6px}}
</style>

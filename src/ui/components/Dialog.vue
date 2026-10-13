<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { closeDialog, dialog } from '../dialog'
import { pushBack } from '../backStack'

const input = ref<HTMLInputElement | null>(null)
let off: (() => void) | null = null
watch(() => dialog.open, async (o) => {
  off?.()
  off = o ? pushBack(() => closeDialog(null)) : null
  if (o && dialog.opts.input) {
    await nextTick()
    input.value?.focus()
  }
})
const ok = () => closeDialog(dialog.opts.input ? dialog.value : '')
</script>

<template>
  <Teleport to="body">
    <Transition name="dlg">
      <div v-if="dialog.open" class="backdrop" @click.self="closeDialog(null)">
        <form class="dlg" role="alertdialog" :aria-label="dialog.opts.title" @submit.prevent="ok">
          <h2>{{ dialog.opts.title }}</h2>
          <p v-if="dialog.opts.message" class="msg">{{ dialog.opts.message }}</p>
          <input v-if="dialog.opts.input" ref="input" v-model="dialog.value" class="field"
            :class="{ mono: dialog.opts.input.password }"
            :type="dialog.opts.input.password ? 'password' : 'text'" :placeholder="dialog.opts.input.placeholder"
            autocomplete="off" autocapitalize="off" spellcheck="false" />
          <div class="btns">
            <button type="button" class="text-btn" @click="closeDialog(null)">{{ dialog.opts.cancel ?? '取消' }}</button>
            <button type="submit" class="text-btn" :class="dialog.opts.danger ? 'danger' : 'accent'"
              :disabled="!!dialog.opts.input && !dialog.value">{{ dialog.opts.ok ?? '确定' }}</button>
          </div>
        </form>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(15, 12, 10, 0.4);
}
.dlg {
  width: min(100%, 380px);
  padding: 20px 18px 10px;
  border-radius: 22px;
  background: var(--bg);
  box-shadow: 0 20px 60px -20px rgba(0, 0, 0, 0.45);
}
h2 { margin: 0 4px 8px; font-size: 18px; }
.msg { margin: 0 4px 14px; color: var(--muted); font-size: 15px; line-height: 1.6; white-space: pre-line; }
.field { margin-bottom: 8px; }
.btns { display: flex; justify-content: flex-end; gap: 4px; margin-top: 6px; }
.dlg-enter-active, .dlg-leave-active { transition: opacity 0.18s; }
.dlg-enter-active .dlg { transition: transform 0.3s var(--spring); }
.dlg-enter-from, .dlg-leave-to { opacity: 0; }
.dlg-enter-from .dlg { transform: scale(0.92); }
</style>

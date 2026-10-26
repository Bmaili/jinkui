<script setup lang="ts">
/**
 * 九宫格图案（1.0.9 起）。按住拖过各个点，松手时发出 done(点的序列，0–8 按行编号)。
 * 跨过中间没连过的点时自动连上（core/pattern.ts 的 addPoint，和安卓锁屏一样）。
 * status = 'error' 时线条变红；resetKey 变了就清空。
 */
import { computed, ref, watch } from 'vue'
import { addPoint } from '../../core/pattern'

const props = defineProps<{ disabled?: boolean; status?: '' | 'error' | 'busy'; resetKey?: number }>()
const emit = defineEmits<{ done: [seq: number[]] }>()

const SIZE = 300
const STEP = 100
const at = (p: number) => ({ x: STEP / 2 + (p % 3) * STEP, y: STEP / 2 + Math.floor(p / 3) * STEP })
const DOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((p) => ({ p, ...at(p) }))
/** 手指离点的中心多近算碰到（viewBox 单位） */
const HIT = 34

const seq = ref<number[]>([])
const finger = ref<{ x: number; y: number } | null>(null)
const drawing = ref(false)
const svg = ref<SVGSVGElement | null>(null)

watch(() => props.resetKey, () => {
  seq.value = []
  finger.value = null
  drawing.value = false
})

function local(e: PointerEvent) {
  const r = svg.value!.getBoundingClientRect()
  return { x: ((e.clientX - r.left) / r.width) * SIZE, y: ((e.clientY - r.top) / r.height) * SIZE }
}

function hit(pt: { x: number; y: number }) {
  for (const d of DOTS) if ((d.x - pt.x) ** 2 + (d.y - pt.y) ** 2 <= HIT * HIT) seq.value = addPoint(seq.value, d.p)
}

function down(e: PointerEvent) {
  if (props.disabled) return
  e.preventDefault()
  svg.value?.setPointerCapture?.(e.pointerId)
  seq.value = []
  drawing.value = true
  const pt = local(e)
  finger.value = pt
  hit(pt)
}

function move(e: PointerEvent) {
  if (!drawing.value) return
  const pt = local(e)
  finger.value = pt
  hit(pt)
}

function up() {
  if (!drawing.value) return
  drawing.value = false
  finger.value = null
  if (seq.value.length) emit('done', [...seq.value])
}

const path = computed(() => seq.value.map((p, i) => `${i ? 'L' : 'M'}${at(p).x} ${at(p).y}`).join(' '))
const tail = computed(() => {
  const last = seq.value[seq.value.length - 1]
  if (last === undefined || !finger.value) return ''
  return `M${at(last).x} ${at(last).y} L${finger.value.x} ${finger.value.y}`
})
</script>

<template>
  <svg ref="svg" class="pad" :class="[status, { disabled }]" :viewBox="`0 0 ${SIZE} ${SIZE}`" role="img" aria-label="图案"
    @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @lostpointercapture="up">
    <path v-if="seq.length > 1" class="line" :d="path" />
    <path v-if="tail" class="line tail" :d="tail" />
    <g v-for="d in DOTS" :key="d.p" :class="{ on: seq.includes(d.p) }">
      <circle class="halo" :cx="d.x" :cy="d.y" r="26" />
      <circle class="dot" :cx="d.x" :cy="d.y" r="7" />
    </g>
  </svg>
</template>

<style scoped>
.pad { display: block; width: min(78vw, 300px); aspect-ratio: 1; margin: 0 auto; touch-action: none; user-select: none; -webkit-user-select: none; }
.pad.disabled { opacity: 0.5; }
.dot { fill: var(--faint); transition: fill 0.15s, r 0.15s; }
.halo { fill: transparent; stroke: transparent; stroke-width: 1.5; transition: fill 0.15s, stroke 0.15s; }
.on .dot { fill: var(--accent); r: 9; }
.on .halo { fill: color-mix(in srgb, var(--accent) 12%, transparent); stroke: color-mix(in srgb, var(--accent) 45%, transparent); }
.line { fill: none; stroke: var(--accent); stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; opacity: 0.75; }
.tail { opacity: 0.4; }
.error .on .dot { fill: var(--danger); }
.error .on .halo { fill: color-mix(in srgb, var(--danger) 12%, transparent); stroke: color-mix(in srgb, var(--danger) 45%, transparent); }
.error .line { stroke: var(--danger); }
.busy { opacity: 0.6; }
</style>

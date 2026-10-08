import { ref } from 'vue'

/** Order of mounted <Modal> instances (last = top-most). Only the top-most handles ESC / traps focus. */
const stack = ref<symbol[]>([])

export function pushModal(id: symbol): void {
  stack.value = [...stack.value, id]
}

export function removeModal(id: symbol): void {
  stack.value = stack.value.filter((s) => s !== id)
}

export function isTopModal(id: symbol): boolean {
  return stack.value[stack.value.length - 1] === id
}

export function modalDepth(): number {
  return stack.value.length
}

import type { Component } from 'vue'

/** Option of <Select>. */
export interface SelectOption<V extends string | number = string> {
  value: V
  label: string
  disabled?: boolean
}

/** Segment of <SegmentedControl>. */
export interface Segment<V extends string | number = string> {
  value: V
  label?: string
  icon?: Component
  title?: string
  disabled?: boolean
}

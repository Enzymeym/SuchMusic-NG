<script setup lang="ts">
import { PropType } from 'vue'
import { NMenu, MenuOption } from 'naive-ui'

const props = defineProps({
  options: {
    type: Array as PropType<MenuOption[]>,
    required: true
  },
  value: {
    type: String,
    default: undefined
  },
  collapsed: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:value'])

const handleUpdateValue = (key: string, item: MenuOption) => {
  emit('update:value', key, item)
}
</script>

<template>
  <n-menu
    data-sidebar
    :options="props.options"
    :value="props.value"
    :collapsed="props.collapsed"
    :collapsed-width="64"
    :collapsed-icon-size="22"
    @update:value="handleUpdateValue"
  />
</template>


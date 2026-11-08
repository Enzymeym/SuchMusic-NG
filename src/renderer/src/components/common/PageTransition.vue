<template>
  <!--
    注意：这里**不能**加 mode="out-in"。
    本组件包在 <keep-alive> 外层（见 MainLayout），out-in 需要等离场元素的 leave
    过渡结束才渲染新页面；而离场页面会被 keep-alive 移进离屏容器，leave 的
    afterLeave 回调随之丢失，Vue 就永远停在「全部离场、一个都没进场」的状态：
    内容区只剩一个注释节点，之后所有页面都空白。
    改为默认（同时）过渡后，两个页面在 300ms 内交叉淡入淡出，见下方 leave-active 的
    绝对定位处理，避免纵向堆叠。
  -->
  <transition name="fade-slide">
    <slot />
  </transition>
</template>

<style>
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}

/* 离场页面脱离文档流，否则会和新页面在纵向堆叠、把新页面挤出可视区 */
.fade-slide-leave-active {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.fade-slide-enter-from {
  opacity: 0;
  transform: translateX(10px);
}

.fade-slide-leave-to {
  opacity: 0;
  transform: translateX(-10px);
}
</style>

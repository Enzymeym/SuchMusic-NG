<script setup lang="ts">
/**
 * 背景渲染组件 - 基于 @applemusic-like-lyrics/core
 */
import {
  type AbstractBaseRenderer,
  type BaseRenderer,
  BackgroundRender as CoreBackgroundRender,
  MeshGradientRenderer,
} from "@applemusic-like-lyrics/core";
import { useTemplateRef, shallowRef, onMounted, onBeforeUnmount, watch } from "vue";
import { onFftData } from "../../../audio/audio-engine";


export interface BackgroundRenderProps {
  /** 设置背景专辑资源 (图片URL、Image对象或Video对象) */
  album?: string | HTMLImageElement | HTMLVideoElement;
  /** 设置专辑资源是否为视频 */
  albumIsVideo?: boolean;
  /** 设置当前背景动画帧率，默认为 30 */
  fps?: number;
  /** 设置当前播放状态，默认为 true */
  playing?: boolean;
  /** 设置当前动画流动速度，默认为 2 */
  flowSpeed?: number;
  /** 设置是否根据“是否有歌词”调整效果，默认为 true */
  hasLyric?: boolean;
  /** 低频音量大小 [0.0-1.0]，默认为 1.0 */
  lowFreqVolume?: number;
  /**
   * 音乐响应强度（0 表示关闭动态响应，使用固定的 lowFreqVolume）。
   * 大于 0 时组件会自行订阅 FFT，用实时低频能量驱动背景起伏。
   */
  audioReactive?: number;
  /** 渲染缩放比例，默认为 0.5 */
  renderScale?: number;
  /** 渲染器类，默认为 MeshGradientRenderer */
  renderer?: new (...args: ConstructorParameters<typeof BaseRenderer>) => BaseRenderer;
}

export interface BackgroundRenderRef {
  bgRender?: AbstractBaseRenderer;
  wrapperEl: HTMLDivElement | null;
}

const props = withDefaults(defineProps<BackgroundRenderProps>(), {
  fps: 30,
  playing: true,
  flowSpeed: 2,
  hasLyric: true,
  lowFreqVolume: 1.0,
  audioReactive: 0,
  renderScale: 0.5,
  renderer: () => MeshGradientRenderer,
  albumIsVideo: false,
});

const wrapperRef = useTemplateRef<HTMLDivElement>("wrapper-ref");

// 外部类实例
const bgRenderRef = shallowRef<AbstractBaseRenderer>();

/**
 * 音频响应：Mesh 渲染器只接受一个「当时」的 lowFreqVolume（core 内部再 /10
 * 转成着色器 u_volume），自己不会去取音频数据。开启音乐响应后由本组件订阅
 * 统一 FFT 回调（Web Audio / WASAPI 两种输出模式都由 audioEngine 统一提供），
 * 取低频段能量做「起音快、回落慢」的平滑后直接写进渲染器。
 *
 * 刻意不每帧回写 prop：FFT 回调约 30 次/秒，走响应式会让父组件反复重渲染。
 */
const BASS_BIN_COUNT = 8;
let bassLevel = 0;
let fftCleanup: (() => void) | null = null;

const stopAudioReactive = () => {
  fftCleanup?.();
  fftCleanup = null;
  bassLevel = 0;
  // 退订后回到固定音量，避免背景停在某一帧的低频强度上
  bgRenderRef.value?.setLowFreqVolume(props.lowFreqVolume);
};

const startAudioReactive = () => {
  if (fftCleanup) return;
  fftCleanup = onFftData((spectrum) => {
    // 前 8 个 bin（fftSize=256）覆盖约 0-1.4kHz，基本就是底鼓与贝斯的范围
    const count = Math.min(BASS_BIN_COUNT, spectrum.length);
    if (count === 0) return;
    let sum = 0;
    for (let i = 0; i < count; i++) sum += spectrum[i];
    const target = Math.min(1, (sum / count) * 1.6);
    bassLevel += (target - bassLevel) * (target > bassLevel ? 0.6 : 0.12);
    bgRenderRef.value?.setLowFreqVolume(bassLevel * props.audioReactive);
  });
};

const syncAudioReactive = () => {
  if (props.audioReactive > 0 && props.playing && bgRenderRef.value) startAudioReactive();
  else stopAudioReactive();
};

/**
 * 统一更新状态
 */
const updateRendererState = () => {
  const renderer = bgRenderRef.value;
  if (!renderer) return;

  // 设置专辑封面
  if (props.album) {
    renderer.setAlbum(props.album, props.albumIsVideo);
  }
  // 基础参数
  renderer.setFPS(props.fps);
  renderer.setFlowSpeed(props.flowSpeed);
  renderer.setRenderScale(props.renderScale);
  renderer.setLowFreqVolume(props.lowFreqVolume);
  renderer.setHasLyric(props.hasLyric);
  // 播放状态
  if (props.playing) {
    renderer.resume();
  } else {
    renderer.pause();
  }
};

onMounted(() => {
  if (wrapperRef.value) {
    // 初始化渲染器核心
    bgRenderRef.value = CoreBackgroundRender.new(props.renderer);
    // 配置 Canvas 样式
    const el = bgRenderRef.value.getElement();
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.display = "block";
    wrapperRef.value.appendChild(el);
    updateRendererState();
    syncAudioReactive();
  }
});

onBeforeUnmount(() => {
  stopAudioReactive();
  const renderer = bgRenderRef.value;
  if (renderer) {
    bgRenderRef.value = undefined;
    // 立即销毁：释放渲染器内部的 rAF 循环与 WebGL/Canvas 资源。
    // 原实现将 dispose 放入 500ms 延时定时器，但 onUnmounted 会同步把它 clearTimeout，
    // 导致 dispose() 永远不会执行，rAF 资源在页面切换后持续泄漏。
    renderer.dispose();
  }
});

watch(
  () => props.album,
  (val) => {
    if (val) {
      bgRenderRef.value?.setAlbum(val, props.albumIsVideo);
    }
  },
);

watch(
  () => props.fps,
  (val) => {
    bgRenderRef.value?.setFPS(val);
  },
);

watch(
  () => props.playing,
  (isPlaying) => {
    if (isPlaying) {
      bgRenderRef.value?.resume();
    } else {
      bgRenderRef.value?.pause();
    }
    syncAudioReactive();
  },
);

watch(
  () => props.audioReactive,
  () => {
    syncAudioReactive();
  },
);

watch(
  () => props.flowSpeed,
  (val) => {
    bgRenderRef.value?.setFlowSpeed(val);
  },
);

watch(
  () => props.renderScale,
  (val) => {
    bgRenderRef.value?.setRenderScale(val);
  },
);

watch(
  () => props.lowFreqVolume,
  (val) => {
    bgRenderRef.value?.setLowFreqVolume(val);
  },
);

watch(
  () => props.hasLyric,
  (val) => {
    bgRenderRef.value?.setHasLyric(val);
  },
);

defineExpose({
  bgRender: bgRenderRef,
  wrapperEl: wrapperRef,
});
</script>

<template>
  <div
    ref="wrapper-ref"
    class="background-render-wrapper"
    style="display: contents"
    aria-hidden="true"
  />
</template>

<style scoped lang="scss">
.background-render-wrapper {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
}
</style>
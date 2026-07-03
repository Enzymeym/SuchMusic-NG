/// <reference types="vitest/globals" />
import { webAudioEngine } from './audio-engine'
import { usePlayerStore } from '../stores/playerStore'

// 模拟 AudioContext
class MockAudioContext {
  currentTime = 0
  destination = {}
  createGain() {
    return {
      connect: () => {},
      gain: { value: 1, cancelScheduledValues: () => {}, setValueAtTime: () => {}, linearRampToValueAtTime: () => {} }
    }
  }
  createDynamicsCompressor() {
    return {
      connect: () => {},
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 }
    }
  }
  createBiquadFilter() {
    return {
      connect: () => {},
      type: 'peaking',
      frequency: { value: 0 },
      Q: { value: 0 },
      gain: { value: 0 }
    }
  }
  createBufferSource() {
    return {
      buffer: null,
      connect: () => {},
      start: () => {},
      stop: () => {},
      disconnect: () => {},
      onended: null
    }
  }
  createMediaElementSource() {
    return {
      connect: () => {}
    }
  }
  createBuffer() {
    return {
      duration: 10,
      getChannelData: () => new Float32Array(44100)
    }
  }
  decodeAudioData() {
    return Promise.resolve({
      duration: 10,
      getChannelData: () => new Float32Array(44100)
    })
  }
  resume() {
    return Promise.resolve()
  }
  suspend() {
    return Promise.resolve()
  }
}

// 模拟 HTMLAudioElement
class MockAudioElement {
  src = ''
  preload = 'auto'
  crossOrigin = 'anonymous'
  currentTime = 0
  duration = 10
  paused = true
  onloadedmetadata = null
  ontimeupdate = null
  onended = null
  onerror = null
  
  play() {
    this.paused = false
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }
}

// 模拟 window 对象
Object.defineProperty(window, 'AudioContext', {
  value: MockAudioContext
})

Object.defineProperty(window, 'Audio', {
  value: MockAudioElement
})

describe('WebAudioEngine Preload Tests', () => {
  let playerStore
  let preloadCallbackMock
  
  beforeEach(() => {
    // 重置播放器状态
    playerStore = usePlayerStore()
    playerStore.resetPreloadState()
    
    // 清除之前的预加载
    webAudioEngine.clearPreload()
    
    // 模拟预加载回调
    preloadCallbackMock = vi.fn()
    webAudioEngine.addPreloadCallback(preloadCallbackMock)
  })
  
  afterEach(() => {
    // 移除预加载回调
    webAudioEngine.removePreloadCallback(preloadCallbackMock)
  })
  
  test('should trigger preload callback with loading status when preload starts', async () => {
    const mockSong = {
      id: 1,
      title: 'Test Song',
      artist: 'Test Artist',
      url: 'https://example.com/test.mp3'
    }
    
    // 开始预加载
    const preloadPromise = webAudioEngine.preloadNextSong(mockSong)
    
    // 等待一小段时间，确保回调被触发
    await new Promise(resolve => setTimeout(resolve, 100))
    
    // 验证回调被触发，状态为 loading
    expect(preloadCallbackMock).toHaveBeenCalledWith('loading')
    
    // 等待预加载完成
    await preloadPromise
  })
  
  test('should trigger preload callback with loaded status when preload succeeds', async () => {
    const mockSong = {
      id: 1,
      title: 'Test Song',
      artist: 'Test Artist',
      url: 'https://example.com/test.mp3'
    }
    
    // 开始预加载
    await webAudioEngine.preloadNextSong(mockSong)
    
    // 验证回调被触发，状态为 loaded
    expect(preloadCallbackMock).toHaveBeenCalledWith('loaded')
  })
  
  test('should trigger preload callback with error status when preload fails', async () => {
    const mockSong = {
      id: 1,
      title: 'Test Song',
      artist: 'Test Artist',
      // 没有 URL 或 filePath，应该失败
    }
    
    // 开始预加载
    await webAudioEngine.preloadNextSong(mockSong)
    
    // 验证回调被触发，状态为 error
    expect(preloadCallbackMock).toHaveBeenCalledWith('error', expect.any(String))
  })
  
  test('should clear preload resources when clearPreload is called', () => {
    const mockSong = {
      id: 1,
      title: 'Test Song',
      artist: 'Test Artist',
      url: 'https://example.com/test.mp3'
    }
    
    // 开始预加载
    webAudioEngine.preloadNextSong(mockSong)
    
    // 清除预加载
    webAudioEngine.clearPreload()
    
    // 验证没有预加载的歌曲
    expect(webAudioEngine.hasPreloadedSong()).toBe(false)
  })
  
  test('should return false when hasPreloadedSong is called without preload', () => {
    // 清除预加载
    webAudioEngine.clearPreload()
    
    // 验证没有预加载的歌曲
    expect(webAudioEngine.hasPreloadedSong()).toBe(false)
  })
  
  test('should handle preload retry logic', async () => {
    const mockSong = {
      id: 1,
      title: 'Test Song',
      artist: 'Test Artist',
      // 没有 URL 或 filePath，应该失败
    }
    
    // 开始预加载
    await webAudioEngine.preloadNextSong(mockSong)
    
    // 验证回调被触发多次（包括重试）
    expect(preloadCallbackMock).toHaveBeenCalledTimes(4) // loading + 3 retries + error
  })
})

/**
 * 双音频引擎路由器
 * 
 * 根据音频文件格式自动选择使用 symphonia 引擎还是 FFmpeg 引擎。
 * 
 * 引擎选择策略：
 * - symphonia 引擎（默认）：MP3, FLAC, AAC, WAV, OGG, Opus
 * - FFmpeg 引擎（扩展）：DSF, DFF, WavPack, APE, AC3, DTS, TrueHD, AIFF, WMA, TTA
 * 
 * 所有音效处理（EQ、压缩器、限制器、等响度、虚拟低频、软限幅）
 * 均在 Web Audio API 处理链中执行，与底层解码引擎无关。
 */

/**
 * FFmpeg 独占支持的格式扩展名列表
 */
const FFMPEG_EXCLUSIVE_EXTENSIONS = [
  'dsf', 'dff',      // DSD 格式
  'wv', 'wavpack',   // WavPack
  'ape', 'mac',      // Monkey's Audio
  'ac3',             // AC-3
  'dts',             // DTS
  'thd', 'truehd',   // TrueHD
  'aiff', 'aif',     // AIFF
  'wma',             // WMA
  'tta',             // TTA
];

/**
 * symphonia 支持的格式扩展名列表
 */
const SYMPHONIA_EXTENSIONS = [
  'mp3', 'flac', 'aac', 'm4a', 'wav', 'wave', 'ogg', 'oga', 'opus',
];

/**
 * 音频引擎类型
 */
export type AudioEngineType = 'symphonia' | 'ffmpeg';

/**
 * 根据文件路径确定应使用的音频引擎
 * 
 * # 参数
 * - `filePath`: 音频文件路径
 * 
 * # 返回值
 * 返回 'symphonia' 或 'ffmpeg'
 */
export function selectEngineByPath(filePath: string): AudioEngineType {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';

  if (FFMPEG_EXCLUSIVE_EXTENSIONS.includes(ext)) {
    return 'ffmpeg';
  }

  // 默认使用 symphonia（包括未知格式）
  return 'symphonia';
}

/**
 * 根据文件扩展名确定应使用的音频引擎
 * 
 * # 参数
 * - `extension`: 文件扩展名（不含点号）
 * 
 * # 返回值
 * 返回 'symphonia' 或 'ffmpeg'
 */
export function selectEngineByExtension(extension: string): AudioEngineType {
  const ext = extension.toLowerCase();

  if (FFMPEG_EXCLUSIVE_EXTENSIONS.includes(ext)) {
    return 'ffmpeg';
  }

  return 'symphonia';
}

/**
 * 检查格式是否需要 FFmpeg 引擎
 * 
 * # 参数
 * - `filePath`: 音频文件路径
 * 
 * # 返回值
 * 返回 true 表示该格式需要 FFmpeg 引擎
 */
export function requiresFfmpeg(filePath: string): boolean {
  return selectEngineByPath(filePath) === 'ffmpeg';
}

/**
 * 获取文件扩展名支持的引擎列表
 * 
 * # 参数
 * - `extension`: 文件扩展名
 * 
 * # 返回值
 * 返回支持的引擎类型数组，长度 ≥ 1
 */
export function getSupportedEngines(extension: string): AudioEngineType[] {
  const ext = extension.toLowerCase();

  if (FFMPEG_EXCLUSIVE_EXTENSIONS.includes(ext)) {
    return ['ffmpeg'];
  }

  // symphonia 支持的格式，FFmpeg 也可作为备选
  if (SYMPHONIA_EXTENSIONS.includes(ext)) {
    return ['symphonia', 'ffmpeg'];
  }

  // 未知格式，尝试两个引擎
  return ['symphonia', 'ffmpeg'];
}

/**
 * 双引擎解码器类
 * 
 * 封装了两个引擎的加载和解码逻辑，
 * 对外提供统一的解码接口。
 */
export class DualEngineDecoder {
  private engineType: AudioEngineType = 'symphonia';
  private ffmpegEngineId: string | null = null;

  /**
   * 根据文件路径初始化合适的解码器
   * 
   * # 参数
   * - `filePath`: 音频文件路径
   * 
   * # 返回值
   * 返回选定的引擎类型
   */
  async initForFile(filePath: string): Promise<AudioEngineType> {
    this.engineType = selectEngineByPath(filePath);

    if (this.engineType === 'ffmpeg') {
      try {
        const result = await window.api.ffmpegEngine.create();
        if (result.success) {
          this.ffmpegEngineId = result.engineId!;
          console.log('[DualEngine] FFmpeg 引擎已初始化:', this.ffmpegEngineId);
        }
      } catch (err) {
        console.error('[DualEngine] FFmpeg 引擎初始化失败:', err);
        // 回退到 symphonia
        this.engineType = 'symphonia';
      }
    }

    return this.engineType;
  }

  /**
   * 加载音频文件并返回流信息
   * 
   * # 参数
   * - `filePath`: 音频文件路径
   * 
   * # 返回值
   * 返回包含流信息和引擎类型的结果
   */
  async loadFile(filePath: string): Promise<{
    success: boolean;
    streamInfo?: any;
    engineType: AudioEngineType;
    error?: string;
  }> {
    await this.initForFile(filePath);

    if (this.engineType === 'ffmpeg') {
      const result = await window.api.ffmpegEngine.load(filePath);
      return { ...result, engineType: 'ffmpeg' };
    }

    // 使用默认 symphonia 引擎
    const result = await window.api.audioEngine.load(filePath);
    return { ...result, engineType: 'symphonia' };
  }

  /**
   * 获取当前使用的引擎类型
   * 
   * # 返回值
   * 返回当前引擎类型
   */
  getEngineType(): AudioEngineType {
    return this.engineType;
  }

  /**
   * 释放资源
   */
  async dispose(): Promise<void> {
    if (this.ffmpegEngineId) {
      try {
        await window.api.ffmpegEngine.destroy();
        this.ffmpegEngineId = null;
      } catch (err) {
        console.warn('[DualEngine] 销毁 FFmpeg 引擎失败:', err);
      }
    }
  }
}

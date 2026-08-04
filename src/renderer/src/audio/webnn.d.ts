// WebNN（Web Machine Learning）API 的最小类型声明
// 仅覆盖本项目所需部分，完整规范见 https://www.w3.org/TR/webnn/
// 注意：WebNN 为实验性特性，类型宽松以兼容各版本实现差异

/** WebNN 设备类型 */
export type MLDeviceType = 'cpu' | 'gpu' | 'npu'

/** 创建上下文时的选项 */
export interface MLContextOptions {
  /** 设备类型，缺省由浏览器自行选择 */
  deviceType?: MLDeviceType
}

/** 算子支持情况查询结果（简化声明，兼容新旧实现） */
export interface MLSupportLimits {
  /**
   * 支持的算子集合
   * 新实现为对象形式（键为算子名，如 { conv2d: {...} }），
   * 旧实现为字符串数组，这里声明为联合类型以兼容
   */
  ops?: string[] | Record<string, unknown>
  [key: string]: unknown
}

/** WebNN 上下文，用于构建/编译/执行模型 */
export interface MLContext {
  /**
   * 查询算子支持情况
   * 老实现可能不存在该方法，因此声明为可选
   */
  opSupportLimits?: () => MLSupportLimits
}

/** WebNN 入口 */
export interface ML {
  /**
   * 创建上下文
   * 部分实现为同步返回，这里声明为联合类型以兼容
   */
  createContext(options?: MLContextOptions): MLContext | Promise<MLContext>
}

declare global {
  interface Navigator {
    /**
     * WebNN 入口，仅在 Chromium 启用 WebMachineLearningNeuralNetwork 特性后存在，
     * 因此声明为可选
     */
    ml?: ML
  }
}

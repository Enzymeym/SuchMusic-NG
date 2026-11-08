/**
 * 把插件返回值收敛为可跨 IPC 传输的纯数据。
 *
 * 实现已抽到 `src/shared/plugin/serialize.ts`（洛雪 / 澜音 / Such v2 共用），
 * 本文件保留转发以维持既有 import 路径。
 */
export { toSerializable } from '../../../shared/plugin/serialize'

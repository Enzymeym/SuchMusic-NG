/**
 * `@grant` 校验
 *
 * 单独成文件是为了避免 suchApi / suchSystem 互相 import 造成循环依赖。
 */
import type { PluginGrant } from '../../shared/plugin/types'

/** 最小上下文约束：只要求带 grants 与插件名 */
export interface GrantContext {
  header: { name: string; grants: string[] }
}

/** 校验 `@grant`，未声明直接拒绝 */
export function requireGrant(ctx: GrantContext, grant: PluginGrant): void {
  if (!ctx.header.grants.includes(grant)) {
    throw new Error(
      `插件「${ctx.header.name}」未声明 @grant ${grant}，无法使用该能力（请在插件头补充）`
    )
  }
}

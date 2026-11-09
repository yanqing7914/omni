// 「手机控制」设置分区冻结（2026-11-09 用户定）：只藏设置页入口，页面与 AI 侧手机工具保留。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/client/index.ts', 'utf8')

describe('手机控制入口冻结', () => {
  it('冻结开关为 true', () => {
    expect(source).toMatch(/export const PHONE_CONTROL_FROZEN = true\b/)
  })

  it('分区注册被开关包住，不会无条件注册', () => {
    const block = source.split("id: 'android-phone-control'")[0]!.split('\n').slice(-6).join('\n')
    expect(block, '注册前必须先判断 PHONE_CONTROL_FROZEN').toContain('if (!PHONE_CONTROL_FROZEN) {')
  })

  it('页面组件仍在（解冻只改一处）', () => {
    expect(source).toContain("import { PhoneControlSection } from './dev-section/phone-control.tsx'")
  })
})

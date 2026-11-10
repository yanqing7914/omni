/**
 * 更新入口的样式：右下角浮动胶囊 + 抽屉「更多」行右侧的圆形按钮 + 检查提示。
 *
 * 颜色一律取自 `--dsw-*` 主题变量（深色胶囊用 toast 那组「深底浅字」token），
 * 不写死色值，保证浅色/深色主题都跟随。位置避开输入框/发送键：
 * 右侧 16px、底部 `safe-area + 88px`。
 */
export const UPDATE_ENTRY_CSS: string = `
/* ── 右下角浮动胶囊 ─────────────────────────────────────────────── */
.dsh-update-entry {
  position: fixed;
  right: 16px;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 88px);
  z-index: 2147482000;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  max-width: calc(100vw - 32px);
  pointer-events: none;
}

.dsh-update-entry-button {
  pointer-events: auto;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  min-height: 40px;
  padding: 8px 16px 8px 8px;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-toast-bg);
  color: var(--dsw-alias-toast-label);
  box-shadow: var(--dsw-elevation-prominent);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
  transition: transform 80ms ease, opacity 80ms ease;
  -webkit-tap-highlight-color: transparent;
}

.dsh-update-entry-button:active:not(:disabled) {
  transform: translateY(1px);
  opacity: 0.86;
}

.dsh-update-entry-button:disabled {
  cursor: default;
  opacity: 0.92;
}

.dsh-update-entry-icon {
  flex: none;
  display: block;
}

.dsh-update-entry-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dsh-update-entry-reason {
  box-sizing: border-box;
  max-width: 100%;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--dsw-alias-toast-bg);
  color: var(--dsw-alias-toast-label);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: auto;
}

/* ── 抽屉「更多」行右侧的圆形按钮 ─────────────────────────────── */
.dsh-drawer-update {
  position: relative;
  flex: none;
  margin-left: auto;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.dsh-drawer-update:active {
  background: var(--dsw-alias-interactive-bg-hover);
}

.dsh-drawer-update[data-update-available='true'] {
  color: var(--dsw-alias-label-primary);
}

.dsh-drawer-update-dot {
  display: none;
  position: absolute;
  top: 10px;
  right: 10px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary);
}

.dsh-drawer-update[data-update-available='true'] .dsh-drawer-update-dot {
  display: block;
}

/* ── 检查结果提示 ──────────────────────────────────────────────── */
.dsh-update-notice {
  position: fixed;
  left: 50%;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 88px);
  z-index: 2147482001;
  box-sizing: border-box;
  max-width: calc(100vw - 32px);
  padding: 8px 14px;
  border-radius: 999px;
  background: var(--dsw-alias-toast-bg);
  color: var(--dsw-alias-toast-label);
  box-shadow: var(--dsw-elevation-prominent);
  font-size: 12px;
  line-height: 18px;
  text-align: center;
  transform: translateX(-50%);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`

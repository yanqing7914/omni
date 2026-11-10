/**
 * 「扩展」分区样式：技能 / 插件两个 tab 共用的行骨架。
 *
 * 颜色、边框、圆角一律取本代自适应 `--dsw-alias-*` / `--dsw-radius-*` 令牌，
 * 与设置页其它分区同一套亮暗取值；不写任何硬编码色值。
 * 手机上单列、动作按钮在行尾，行高不低于 48px，保证可点区域。
 */
export const EXTENSIONS_CSS: string = `
[data-plugin='dev-extensions'] {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.dsh-ext-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}

.dsh-ext-tab {
  box-sizing: border-box;
  flex: 1 1 0;
  min-height: 44px;
  padding: 0 8px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 14px;
  line-height: 20px;
  cursor: pointer;
}

.dsh-ext-tab[aria-selected='true'] {
  border-bottom-color: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-label-primary);
}

.dsh-ext-tab:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.dsh-ext-panel,
.dsh-ext-segment {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.dsh-ext-panel {
  padding-top: 4px;
}

.dsh-ext-search-wrap {
  display: block;
}

.dsh-ext-search {
  box-sizing: border-box;
  width: 100%;
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 20px;
}

.dsh-ext-search::placeholder {
  color: var(--dsw-alias-label-secondary);
}

.dsh-ext-search:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-link));
  outline-offset: 2px;
}

.dsh-ext-segment-title {
  margin: 8px 0 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
}

.dsh-ext-category {
  margin: 8px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
}

.dsh-ext-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.dsh-ext-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
}

.dsh-ext-row {
  box-sizing: border-box;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  padding: 12px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}

.dsh-ext-main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.dsh-ext-titleline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.dsh-ext-name {
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  overflow-wrap: anywhere;
}

.dsh-ext-desc {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

.dsh-ext-badge {
  flex: none;
  padding: 1px 6px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
}

.dsh-ext-badge[data-source='user'] {
  border-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
}

.dsh-ext-badge[data-source='bundled'] {
  border-color: var(--dsw-alias-border-l4);
  color: var(--dsw-alias-label-secondary);
}

.dsh-ext-badge[data-compat='ok'] {
  border-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
}

.dsh-ext-badge[data-compat='desktop'] {
  border-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-primary);
}

.dsh-ext-badge[data-compat='native'] {
  border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-state-business-primary);
}

.dsh-ext-badge[data-compat='unknown'] {
  border-color: var(--dsw-alias-border-l4);
  color: var(--dsw-alias-label-secondary);
}

.dsh-ext-actions {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: flex-end;
  min-width: 0;
}

.dsh-ext-actions .dsh-dev-btn {
  min-height: 40px;
}

.dsh-ext-confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.dsh-ext-confirm-text {
  flex: 1 1 100%;
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  text-align: right;
  overflow-wrap: anywhere;
}

.dsh-ext-confirm .dsh-dev-btn {
  min-height: 40px;
}

.dsh-ext-error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.dsh-ext-error .dsh-dev-btn {
  min-height: 40px;
}

.dsh-ext-row-error {
  margin: 4px 0 0;
}

.dsh-ext-load-more {
  box-sizing: border-box;
  width: 100%;
  min-height: 44px;
  margin-top: 4px;
}

.dsh-ext-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 639px) {
  .dsh-ext-row {
    align-items: stretch;
  }
}
`

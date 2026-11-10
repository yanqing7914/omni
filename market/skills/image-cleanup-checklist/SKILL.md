---
name: image-cleanup-checklist
description: Use when the user wants a photo or product image cleaned up, cropped, or made presentable, and needs a concrete checklist of what to fix. Produces an actionable revision list rather than editing the file.
user-invocable: true
---

# 图片整理清单

用于「这张图能不能用」「怎么修」这类请求：先看图，再给出**可执行**的修改清单。
应用当前没有图像编辑工具，清单是给用户或外部修图工具执行的，不要声称已改好。

## 检查顺序

1. **主体**：是否完整、是否被裁切、是否居中。
2. **背景**：是否干净、是否有杂物、边缘是否毛糙。
3. **曝光与色偏**：过曝/欠曝、白平衡偏黄或偏蓝。
4. **清晰度**：是否糊、是否有噪点、是否需要锐化。
5. **尺寸与比例**：目标平台要求（头像 1:1、商品主图 1:1 或 3:4、封面 16:9）。
6. **文字与水印**：是否有不该出现的文字、时间戳、他人水印。
7. **合规**：证件号、门牌号、车牌、二维码等敏感信息是否可见。

## 输出

按「必须改 / 建议改 / 可以不改」三档列，每条写清位置（左上/中部/边缘）和具体做法
（例如「主体右侧留白过多，裁到主体占画面 70%」）。最后给一句总结：这张图现在能不能直接用。

## 边界

- 不帮助伪造、篡改证件、票据、聊天记录、转账截图等任何用于欺骗的图片。
- 发现疑似证件或个人敏感信息时，先提醒用户打码，再做其它建议。

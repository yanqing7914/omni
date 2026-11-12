---
name: image-style-prompt
description: Use when the user wants to restyle or re-render an image (watercolor, anime, oil painting, cyberpunk, product-photo style and so on) and needs a prompt to paste into an image tool. Produces a structured prompt; it does not edit the picture itself.
user-invocable: true
---

# 图片风格改写提示词

这个技能产出的是**给图像工具用的提示词**，不是直接改图。当前应用里没有图像生成或编辑工具，
所以不要声称「已经改好了」，也不要假装图片已生成。

## 先问清楚

- 原图指哪一张（应用里能读到的截图或用户发来的图）。
- 目标风格，用一句话说清（例如「日式水彩」「赛博朋克霓虹」「电商白底商品图」）。
- 哪些东西**必须保持**：人物长相、五官、姿势、服装颜色、商品外形、logo 位置。
- 用途与尺寸：头像 / 商品主图 / 封面，是否需要方形、是否要留白。

## 输出格式

给一段可以直接粘贴的提示词，按这个顺序写：

1. **主体**：谁/什么，姿态、表情、服装。
2. **保持项**：明确列出「保持面部特征与服装不变」「保持商品外形与 logo 不变」。
3. **风格**：画种、笔触、色彩倾向、参考年代或流派。
4. **构图与镜头**：远近、视角、留白、主体占比。
5. **光影与质感**：光源方向、色温、材质（哑光/高光/磨砂）。
6. **画面比例与分辨率**。
7. **负面提示**：变形、多手多指、文字乱码、水印、过度磨皮、塑料感。

同时给一句**中文说明**，告诉用户这段提示词里哪几个词可以微调（例如「把 watercolor 换成
oil painting 就是油画风」）。

## 边界

- 不描述真实人物的身份，不生成对特定个人的丑化或伪造内容。
- 商品图不要伪造品牌、认证标识或功效宣称。
- 用户提到「用某某工具」时，按那个工具的语法调整（例如是否需要 `--ar`、`--style`）。

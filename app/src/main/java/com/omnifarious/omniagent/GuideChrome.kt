package com.omnifarious.omniagent

import android.graphics.Typeface
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity

/** Native startup / fallback screen: brand, live status, diagnostics, actions. */
internal class GuideChrome(
  val root: LinearLayout,
  val brandBlock: View,
  val cardBlock: View,
  val actionBlock: View,
  val engineStatus: TextView,
  val statusHint: TextView,
  val statusDot: View,
  val crashBanner: TextView,
  val progressBar: ProgressBar,
  /**
   * 进度区**唯一**的文本行：确定态是「42% · 预计还需 3 分钟」，不确定态是阶段句。
   *
   * 为什么不是三个 TextView（阶段句 / 百分比 / 剩余时间各一枚）：三枚并排会让同一件事
   * 在同一屏上出现三处读数，正是用户反馈的「信息多、层次乱」。数字仍只来自
   * RuntimeExtractProgress（见 formatProgressLine），这里只负责承载一行文本。
   */
  val progressText: TextView,
  val logSummary: TextView,
  val logSection: View,
  val copyLog: TextView,
  val shareLog: TextView,
  val primaryButton: Button,
  val consoleButton: Button,
  val updateButton: Button,
  /**
   * 更新块的状态行（版本号 / 下载进度 / 失败原文）与下载按钮（检查、下载两枚各发各的动作）。
   *
   * 为什么这两枚**不在本文件挂任何父节点**：更新块住在管理中心，管理中心面板由
   * GuideManagementController 搭建。每枚控件只有一个父节点，由使用者决定归属，构建期先认领会让
   * 别处 addView 直接抛 IllegalStateException；而中心的"检查更新"是按需搬进去的，搬与不搬都要能编译、能单测。
   */
  val apkStatus: TextView,
  val apkDownload: Button,
  /**
   * 0.15.0：更新卡的**次入口**（文字链接），与主按钮二选一承担动作。
   *
   * 为什么不复用 apkDownload：用户口径是「主按钮只有一个，另一个降为卡内右侧的轻量
   * 文字链接」。同一枚控件既要当等宽主按钮又要当文字链接，只能靠运行时改 LayoutParams ——
   * 那会在每次状态切换时重排整张卡，滚动位置也会跳。两枚各自静态，由 [UpdateCardLayout]
   * 决定谁出现。
   */
  val apkSecondaryLink: TextView,
  /** Secondary startup action: retry the engine, or open the repair assistant. */
  val repairButton: Button,
  val runtimeChip: TextView,
  val storageChip: TextView,
  val versionLabel: TextView,
  val homeContent: View,
  val managementHost: FrameLayout,
  val gear: android.widget.ImageButton,
)

internal class GuideCallbacks(
  val onStartEngine: () -> Unit,
  val onOpenConsole: () -> Unit,
  val onCheckUpdate: () -> Unit,
  /** 下载按钮：只做「开始下载 / 续继安装」，与检查按钮各自硬绑定，不再由一枚按钮推断下一步。 */
  val onDownloadUpdate: () -> Unit,
  val onGrantStorage: () -> Unit,
  val onCopyLog: () -> Unit,
  val onShareLog: () -> Unit,
  val onManagement: () -> Unit = {},
  val onRepairAssistant: () -> Unit = {},
)

internal fun buildGuideChrome(activity: ComponentActivity, callbacks: GuideCallbacks): GuideChrome {
  val res = activity.resources
  fun dp(v: Float) = (v * res.displayMetrics.density).toInt()
  fun dim(id: Int) = res.getDimension(id)
  fun dpix(id: Int) = res.getDimensionPixelSize(id)
  fun color(id: Int) = activity.getColor(id)
  fun typeMedium() = Typeface.create("sans-serif-medium", Typeface.NORMAL)

  val hairline = (res.displayMetrics.density).toInt().coerceAtLeast(1)

  val root = LinearLayout(activity).apply {
    orientation = LinearLayout.VERTICAL
    setBackgroundColor(color(R.color.ds_bg))
    visibility = View.GONE
  }

  val content = LinearLayout(activity).apply {
    orientation = LinearLayout.VERTICAL
    // 竖排内容在视口内垂直居中；ScrollView 的 fillViewport 会把不足一屏的内容撑到一屏高，
    // 这里才有可分配的多余高度。左右 32dp 是「状态与进度直接落在页面上」的最小安全边距。
    gravity = Gravity.CENTER
    setPadding(dpix(R.dimen.ds_space_32), dpix(R.dimen.ds_space_24), dpix(R.dimen.ds_space_32), dpix(R.dimen.ds_space_24))
  }

  // —— Brand：竖排居中（图标 → 标题 → 副标题 → 版本号）——
  // 横排（图标 + 标题列 + 版本 pill 同处一行）是上一版的形态：三件事挤在一条基线上，
  // 首屏第一眼读不出主次。竖排让「图标—名字—一句话」自成一个视觉锚点，且天然居中。
  val iconPlate = FrameLayout(activity).apply {
    layoutParams = LinearLayout.LayoutParams(dpix(R.dimen.ds_guide_logo_plate), dpix(R.dimen.ds_guide_logo_plate))
    background = DsUi.roundRect(
      color(R.color.ds_surface),
      dim(R.dimen.ds_radius_icon),
      color(R.color.ds_hairline),
      hairline,
    )
    addView(ImageView(activity).apply {
      setImageResource(R.mipmap.ic_launcher)
      layoutParams = FrameLayout.LayoutParams(
        dpix(R.dimen.ds_guide_logo_mark), dpix(R.dimen.ds_guide_logo_mark), Gravity.CENTER,
      )
    })
  }

  val titleView = TextView(activity).apply {
    text = activity.getString(R.string.app_name)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 27f)
    setTextColor(color(R.color.ds_text_primary))
    typeface = typeMedium()
    letterSpacing = 0f
    gravity = Gravity.CENTER
    layoutParams = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    ).apply { topMargin = dpix(R.dimen.ds_space_20) }
  }

  // 能力说明就是副标题：首屏只保留这一句话，不再另起一行「内嵌运行时」+ 解释行。
  // 文案仍是 ds_brand_explain（中英成对），内容按用户选定的方向收敛成一句可读的事实陈述。
  val subtitleView = TextView(activity).apply {
    text = activity.getString(R.string.ds_brand_explain)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    setTextColor(color(R.color.ds_text_secondary))
    gravity = Gravity.CENTER
    setLineSpacing(0f, 1.25f)
    layoutParams = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    ).apply { topMargin = dpix(R.dimen.ds_space_8) }
  }

  val versionLabel = TextView(activity).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    setTextColor(color(R.color.ds_text_tertiary))
    typeface = typeMedium()
    gravity = Gravity.CENTER
    background = DsUi.roundRect(
      color(R.color.ds_surface),
      dim(R.dimen.ds_radius_pill),
      color(R.color.ds_hairline),
      hairline,
    )
    setPadding(dp(10f), dp(4f), dp(10f), dp(4f))
    // S1-14：长版本号（v0.13.7fx-1、带后缀的验收包 v0.14.1-SN-1-13）此前**无 ellipsize**，
    // 在窄屏上会把左侧标题挤成两行。单行 + 省略号 + 宽度上限（屏幕 34%），标题优先。
    maxLines = 1
    ellipsize = TextUtils.TruncateAt.END
    maxWidth = (res.displayMetrics.widthPixels * 0.34f).toInt()
    layoutParams = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    ).apply { topMargin = dpix(R.dimen.ds_space_12) }
  }

  val brandBlock = LinearLayout(activity).apply {
    orientation = LinearLayout.VERTICAL
    gravity = Gravity.CENTER_HORIZONTAL
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    lp.bottomMargin = dpix(R.dimen.ds_space_40)
    layoutParams = lp
  }
  brandBlock.addView(iconPlate)
  brandBlock.addView(titleView)
  brandBlock.addView(subtitleView)
  brandBlock.addView(versionLabel)
  content.addView(brandBlock)

  // —— Status：不再有卡片外观 ——
  // 上一版把状态、说明、进度、日志全部装进一张圆角描边卡：用户反馈「不美观」的直接来源是
  // 一张深色/浅色底块把本可以留白的内容切成两截。现在容器只负责纵向排列，背景/描边/圆角
  // 全部由页面画布（ds_bg）承担，内容直接落在页面上。
  val card = LinearLayout(activity).apply {
    orientation = LinearLayout.VERTICAL
    gravity = Gravity.CENTER_HORIZONTAL
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    lp.bottomMargin = dpix(R.dimen.ds_space_16)
    layoutParams = lp
  }

  val statusDot = View(activity).apply {
    layoutParams = LinearLayout.LayoutParams(dpix(R.dimen.ds_dot), dpix(R.dimen.ds_dot)).apply {
      gravity = Gravity.CENTER_VERTICAL
      marginEnd = dpix(R.dimen.ds_space_8)
    }
    background = DsUi.oval(color(R.color.ds_text_tertiary))
  }
  val engineStatus = TextView(activity).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
    setTextColor(color(R.color.ds_text_primary))
    typeface = typeMedium()
    letterSpacing = 0f
    gravity = Gravity.CENTER
    setLineSpacing(0f, 1.2f)
    layoutParams = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )
  }
  val statusRow = LinearLayout(activity).apply {
    visibility = View.GONE
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER
  }
  statusRow.addView(statusDot)
  statusRow.addView(engineStatus)
  card.addView(statusRow)

  val statusHint = TextView(activity).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    setTextColor(color(R.color.ds_text_secondary))
    setLineSpacing(0f, 1.35f)
    gravity = Gravity.CENTER
    setPadding(0, dpix(R.dimen.ds_space_8), 0, 0)
    visibility = View.GONE
  }
  card.addView(statusHint)

  val crashBanner = TextView(activity).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    setTextColor(color(R.color.ds_danger))
    typeface = typeMedium()
    gravity = Gravity.CENTER
    maxLines = 3
    ellipsize = TextUtils.TruncateAt.END
    visibility = View.GONE
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    lp.topMargin = dpix(R.dimen.ds_space_16)
    layoutParams = lp
    background = DsUi.roundRect(color(R.color.ds_danger_soft), dim(R.dimen.ds_radius_sm))
    setPadding(dp(12f), dp(8f), dp(12f), dp(8f))
  }
  card.addView(crashBanner)

  val progressBar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply {
    visibility = View.GONE
    max = 100
    progressDrawable = DsUi.progressLayer(
      color(R.color.ds_progress_track),
      color(R.color.ds_accent),
      dim(R.dimen.ds_radius_pill),
    )
    indeterminateTintList = android.content.res.ColorStateList.valueOf(color(R.color.ds_accent))
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, dpix(R.dimen.ds_progress_height),
    )
    lp.topMargin = dpix(R.dimen.ds_guide_progress_top_gap)
    layoutParams = lp
  }
  card.addView(progressBar)

  // 进度条下**只有一行**文本：确定态是「42% · 预计还需 3 分钟」，不确定态是阶段句。
  // 一行居中、等宽数字（tnum），百分比与剩余时间不会因读数跳动而左右晃。
  val progressText = TextView(activity).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    setTextColor(color(R.color.ds_text_primary))
    typeface = typeMedium()
    fontFeatureSettings = "tnum"
    gravity = Gravity.CENTER
    maxLines = 1
    ellipsize = TextUtils.TruncateAt.END
    visibility = View.GONE
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    lp.topMargin = dpix(R.dimen.ds_space_12)
    layoutParams = lp
  }
  card.addView(progressText)

  val runtimeChip = chipView(activity, typeMedium())
  // S1-7/S1-8/S1-9：存储 chip 的**点击语义与观感都随状态变**，因此构建期不再绑定单一监听
  // （旧实现无条件绑 onGrantStorage：在「写入失败」与「尚未探测」两种状态下，点了要么无效、
  // 要么把人送去一个改不了现状的系统页）。监听由 GuidePageRenderer.refreshGuideMeta 按状态安装。
  val storageChip = chipView(activity, typeMedium())
  val chipRow = LinearLayout(activity).apply {
    orientation = LinearLayout.HORIZONTAL
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    lp.topMargin = dpix(R.dimen.ds_space_20)
    layoutParams = lp
  }
  val chipLp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
  val chipLpEnd = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
    marginStart = dpix(R.dimen.ds_space_8)
  }
  chipRow.addView(runtimeChip, chipLp)
  chipRow.addView(storageChip, chipLpEnd)
  // Runtime and permission status now belong to management.
  chipRow.visibility = View.GONE
  card.addView(chipRow)

  val logHeader = LinearLayout(activity).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    lp.topMargin = dpix(R.dimen.ds_space_16)
    layoutParams = lp
  }
  logHeader.addView(TextView(activity).apply {
    text = activity.getString(R.string.ds_log_title)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    setTextColor(color(R.color.ds_text_tertiary))
    typeface = typeMedium()
    letterSpacing = 0.04f
    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
  })
  // 功能 B（0.14.6）：故障时的「分享诊断包」快捷入口。与「复制」同一观感（强调色小字 +
  // 按压反馈），不新增区块、不加二次确认（B7）。
  //
  // **为什么单独挂在 card 上、而不是塞进 logSection 的 logHeader**（B3 的关键，实测抓出的缺陷）：
  // logSection 的可见性由 showGuide() 按「engine.log 有没有尾部摘要」决定，缺失即整段 GONE。
  // 而「引擎起不来、engine.log 根本没生成」恰恰是最需要诊断包的现场——那时入口会被父节点
  // 一起藏掉，等于功能不存在。故本控件自成一行、直接挂在 card 末尾，可见性只由渲染层的证据
  // 判据决定，不受日志摘要是否存在影响。
  //
  // 为什么构建期**默认 GONE**、由渲染层按证据点亮：不是每次启动都出过故障，常态不该多一个
  // 入口；而判据（boot-fail/boot-diag/Error 相位）来自文件与相位，构建期拿不到（B1/B3）。
  val shareLog = TextView(activity).apply {
    text = activity.getString(R.string.ds_share_log)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    setTextColor(color(R.color.ds_accent))
    typeface = typeMedium()
    // 自成一行、左对齐卡片内容（旧形态在 logHeader 里靠右，现在没有右侧邻居了）；
    // 垂直方向留内边距保证可点面积。
    setPadding(0, dp(6f), 0, dp(6f))
    isClickable = true
    isFocusable = true
    minHeight = dp(48f)
    setOnClickListener { callbacks.onShareLog() }
    DsUi.bindPressScale(this, 0.97f)
    visibility = View.GONE
    // 自身带内边距与外边距——不依赖任何容器提供留白，因为父节点（card）不随本控件隐藏。
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    lp.topMargin = dpix(R.dimen.ds_space_16)
    layoutParams = lp
  }
  val copyLog = TextView(activity).apply {
    text = activity.getString(R.string.ds_copy_log)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    setTextColor(color(R.color.ds_accent))
    typeface = typeMedium()
    setPadding(dp(8f), dp(4f), 0, dp(4f))
    isClickable = true
    isFocusable = true
    minHeight = dp(48f)
    minWidth = dp(48f)
    gravity = Gravity.CENTER
    setOnClickListener { callbacks.onCopyLog() }
  }
  logHeader.addView(copyLog)

  val logSummary = TextView(activity).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    setTextColor(color(R.color.ds_text_tertiary))
    typeface = Typeface.MONOSPACE
    setLineSpacing(0f, 1.45f)
    setPadding(0, dpix(R.dimen.ds_space_8), 0, 0)
    maxLines = 8
    ellipsize = TextUtils.TruncateAt.END
  }

  val logSection = LinearLayout(activity).apply {
    orientation = LinearLayout.VERTICAL
    visibility = View.GONE
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
    )
    lp.topMargin = dpix(R.dimen.ds_space_8)
    layoutParams = lp
    addView(View(activity).apply {
      layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, hairline)
      setBackgroundColor(color(R.color.ds_hairline))
    })
    addView(logHeader)
    addView(logSummary)
  }
  card.addView(logSection)
  // 分享入口直接挂 card（不挂 logSection）——见 shareLog 处的说明：日志摘要缺失时
  // logSection 整段隐藏，而那种失败恰恰最需要诊断包（B3）。
  card.addView(shareLog)
  content.addView(card)

  val scroll = ScrollView(activity).apply {
    isFillViewport = true
    overScrollMode = View.OVER_SCROLL_NEVER
    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
    addView(
      content,
      FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
        Gravity.CENTER_HORIZONTAL,
      ),
    )
  }
  val managementHost = FrameLayout(activity).apply { visibility = View.GONE }
  // One stable viewport owns the remaining height throughout a transition, including its endpoints.
  // Changing visibility of its children must never move the bottom action row.
  val viewport = FrameLayout(activity).apply {
    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
    addView(scroll, FrameLayout.LayoutParams(-1, -1))
    addView(managementHost, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER_HORIZONTAL))
  }
  root.addView(viewport)

  // —— Actions (sticky) ——
  fun makePrimary(): Button = Button(activity).apply {
    text = activity.getString(R.string.ds_start_engine)
    isAllCaps = false
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    setTextColor(color(R.color.ds_text_on_accent))
    typeface = typeMedium()
    stateListAnimator = null
    background = DsUi.ripple(
      DsUi.roundRect(color(R.color.ds_accent), dim(R.dimen.ds_radius_pill)),
      color(R.color.ds_accent_pressed),
    )
    layoutParams = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, dpix(R.dimen.ds_btn_height),
    )
    DsUi.bindPressScale(this)
    setOnClickListener { callbacks.onStartEngine() }
  }

  fun makeSecondary(label: String, onClick: () -> Unit): Button = Button(activity).apply {
    text = label
    isAllCaps = false
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    setTextColor(color(R.color.ds_text_primary))
    typeface = typeMedium()
    stateListAnimator = null
    background = DsUi.ripple(
      DsUi.roundRect(
        color(R.color.ds_surface), dim(R.dimen.ds_radius_pill),
        color(R.color.ds_hairline), hairline,
      ),
      color(R.color.ds_accent_soft),
    )
    DsUi.bindPressScale(this, 0.97f)
    setOnClickListener { onClick() }
  }

  val primaryButton = makePrimary()
  val consoleButton = makeSecondary(activity.getString(R.string.ds_open_console), callbacks.onOpenConsole)
  val updateButton = makeSecondary(activity.getString(R.string.ds_check_update), callbacks.onCheckUpdate)
  val repairButton = makeSecondary(activity.getString(R.string.ds_repair_assistant), callbacks.onRepairAssistant)

  // 更新块的两枚新增控件：状态行（次要色小字）+ 下载按钮（与检查按钮同款次级样式，视觉上并列）。
  //
  // 两枚都**不加入任何布局**，默认 GONE，由管理中心的更新块决定何时挂上去：更新块落在哪里是
  // 使用者的事，控件自己认领父节点就会把"将来换落点"变成"改两处"。检查按钮那条既有路径
  // （管理中心 build 里先摘下来再挂进去）是同一判据的既有实现，这里只是不再走一遍"先挂在
  // 死布局里、再被摘走"的弯路。
  val apkStatus = TextView(activity).apply {
    // 12sp + 1.5 倍行距（即 18sp 行高）= WebView 设置卡片里 .dsh-gs-desc 的那一档
    // （font-size: 12px; line-height: 18px）。此前是 13sp/1.3 倍，两侧并排时字号与行距都不是一套。
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    setLineSpacing(0f, 1.5f)
    // 次要色：状态行是次级信息，与卡片标题（ds_text_primary）同级会抢读者的注意力。
    // 这一档也正好是 .dsh-gs-desc 的 --dsw-alias-label-secondary。
    setTextColor(color(R.color.ds_text_secondary))
    // 失败原因与版本行都可能偏长：允许折两行，超出交给省略号（不撑高更新块、不截断到别的控件）。
    maxLines = 2
    ellipsize = TextUtils.TruncateAt.END
    visibility = View.GONE
  }
  val apkDownload = makeSecondary(activity.getString(R.string.ds_apk_download)) {
    callbacks.onDownloadUpdate()
  }.apply { visibility = View.GONE }

  /**
   * 次入口：轻量文字链接（无底色、无描边，14sp 次要色）。
   *
   * 为什么不给底色：用户口径是「另一个降为卡内右侧的轻量文字链接」——它要让位给主按钮，
   * 一旦与主按钮同款等宽灰块，克制就没了。触控面仍按 48dp（[minimumHeight]）保证好点，
   * 只是**画**得像文本。
   */
  val apkSecondaryLink = TextView(activity).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    setTextColor(color(R.color.ds_text_secondary))
    gravity = Gravity.CENTER
    includeFontPadding = false
    minimumHeight = dpix(R.dimen.ds_btn_secondary_height)
    isClickable = true
    isFocusable = true
    background = DsUi.ripple(
      DsUi.roundRect(android.graphics.Color.TRANSPARENT, 0f),
      color(R.color.ds_accent_soft),
    )
    visibility = View.GONE
  }

  val secondaryRow = LinearLayout(activity).apply {
    orientation = LinearLayout.HORIZONTAL
    val lp = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, dpix(R.dimen.ds_btn_secondary_height),
    )
    lp.topMargin = dpix(R.dimen.ds_space_8)
    layoutParams = lp
  }
  val half = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f)
  val halfEnd = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f).apply {
    marginStart = dpix(R.dimen.ds_space_8)
  }
  secondaryRow.addView(consoleButton, half)
  secondaryRow.addView(updateButton, halfEnd)

  // Startup failure keeps both exits visible: retry the engine here, or hand the failure to the
  // native assistant. The row sits above the sticky primary button so neither action is hidden.
  val repairRow = LinearLayout(activity).apply {
    orientation = LinearLayout.HORIZONTAL
    visibility = View.GONE
    layoutParams = LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT, dpix(R.dimen.ds_btn_secondary_height),
    ).apply { topMargin = dpix(R.dimen.ds_space_8) }
  }
  repairRow.addView(repairButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

  val gear = android.widget.ImageButton(activity).apply {
    setImageDrawable(android.graphics.drawable.RotateDrawable().apply {
      drawable = activity.getDrawable(R.drawable.ic_management_gear)
      fromDegrees = 0f
      toDegrees = 240f
      pivotX = 0.5f
      pivotY = 0.5f
      isPivotXRelative = true
      isPivotYRelative = true
    })
    imageTintList = android.content.res.ColorStateList.valueOf(color(R.color.ds_text_primary))
    // The generic ripple helper copies corner radius only; an oval needs an oval mask too.
    background = android.graphics.drawable.RippleDrawable(
      android.content.res.ColorStateList.valueOf(color(R.color.ds_accent_soft)),
      DsUi.oval(color(R.color.ds_surface)), DsUi.oval(android.graphics.Color.WHITE),
    )
    clipToOutline = true
    contentDescription = UiText.t(activity, "打开管理中心", "Open management")
    setPadding(dp(16f), dp(16f), dp(16f), dp(16f))
    setOnClickListener { callbacks.onManagement() }
  }
  val actionBlock = LinearLayout(activity).apply {
    orientation = LinearLayout.VERTICAL
    // 与内容列同一水平安全边距，底部按钮不会比状态文案更贴屏幕边。
    setPadding(dpix(R.dimen.ds_space_32), dpix(R.dimen.ds_space_12), dpix(R.dimen.ds_space_32), 0)
    val primaryRow = LinearLayout(activity).apply {
      orientation = LinearLayout.HORIZONTAL
      // 收紧档下按钮与齿轮作为一个整体居中；空闲档主按钮带 weight 撑满，gravity 不影响。
      gravity = Gravity.CENTER_HORIZONTAL or Gravity.BOTTOM
    }
    primaryRow.addView(primaryButton, LinearLayout.LayoutParams(0, dpix(R.dimen.ds_btn_height), 1f))
    primaryRow.addView(gear, LinearLayout.LayoutParams(dpix(R.dimen.ds_btn_height), dpix(R.dimen.ds_btn_height)).apply {
      marginStart = dpix(R.dimen.ds_space_12)
    })
    addView(repairRow)
    addView(primaryRow)
  }
  root.addView(actionBlock)

  // ── S1-15：`ds_guide_max_width`（440dp）此前**全仓零引用** ────────────────────
  // 后果：平板/折叠屏/横屏上，状态卡与两枚按钮一律拉满整屏（1600px 宽的一张卡 + 两个半屏按钮），
  // 眼睛要横跨整屏读一行 13sp 的说明。这里给「内容列」与「操作区」套同一个上限宽度并居中，
  // 并在可用宽度变化时重算（旋转/分屏/折叠态切换都会改 root 宽度）。
  val maxContentW = dpix(R.dimen.ds_guide_max_width)
  val gutter = dpix(R.dimen.ds_guide_gutter)
  val clamp = { v: View ->
    val avail = root.width - gutter * 2
    if (avail > 0) {
      val want = if (avail > maxContentW) maxContentW else ViewGroup.LayoutParams.MATCH_PARENT
      val lp = v.layoutParams
      if (lp != null && lp.width != want) {
        lp.width = want
        v.layoutParams = lp
      }
    }
  }
  root.gravity = Gravity.CENTER_HORIZONTAL
  root.addOnLayoutChangeListener { _, l, _, r, _, ol, _, or, _ ->
    if (r - l != or - ol) {
      clamp(actionBlock)
      clamp(content)
      clamp(managementHost)
    }
  }
  root.post {
    clamp(actionBlock)
    clamp(content)
    clamp(managementHost)
  }

  return GuideChrome(
    root = root,
    brandBlock = brandBlock,
    cardBlock = card,
    actionBlock = actionBlock,
    engineStatus = engineStatus,
    statusHint = statusHint,
    statusDot = statusDot,
    crashBanner = crashBanner,
    progressBar = progressBar,
    progressText = progressText,
    logSummary = logSummary,
    logSection = logSection,
    copyLog = copyLog,
    shareLog = shareLog,
    primaryButton = primaryButton,
    consoleButton = consoleButton,
    updateButton = updateButton,
    apkStatus = apkStatus,
    apkDownload = apkDownload,
    apkSecondaryLink = apkSecondaryLink,
    repairButton = repairButton,
    runtimeChip = runtimeChip,
    storageChip = storageChip,
    versionLabel = versionLabel,
    homeContent = scroll,
    managementHost = managementHost,
    gear = gear,
  )
}

/**
 * 主按钮的两档观感（进行中 / 空闲或失败）。
 *
 * 为什么在运行时改 LayoutParams 而不是备两枚按钮：主按钮只有一枚才有无障碍与点击语义上的
 * 「唯一主操作」。两枚互切会让读屏器读到两个入口，也会让焦点在相位切换时丢在原地。
 * 「进行中」不是要用户点的动作，形态必须让位：48dp 高、收窄、描边浅底；空闲/失败时恢复
 * 强调色实心并撑满，用户要能一眼看到「启动」。
 */
internal fun applyGuidePrimaryStyle(activity: ComponentActivity, button: Button, compact: Boolean) {
  val res = activity.resources
  val hairline = res.displayMetrics.density.toInt().coerceAtLeast(1)
  (button.layoutParams as? LinearLayout.LayoutParams)?.let { lp ->
    if (compact) {
      lp.width = res.getDimensionPixelSize(R.dimen.ds_guide_primary_compact_width)
      lp.height = res.getDimensionPixelSize(R.dimen.ds_btn_secondary_height)
      lp.weight = 0f
    } else {
      lp.width = 0
      lp.height = res.getDimensionPixelSize(R.dimen.ds_btn_height)
      lp.weight = 1f
    }
    button.layoutParams = lp
  }
  if (compact) {
    button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
    button.setTextColor(activity.getColor(R.color.ds_text_primary))
    button.background = DsUi.ripple(
      DsUi.roundRect(
        activity.getColor(R.color.ds_surface), res.getDimension(R.dimen.ds_radius_pill),
        activity.getColor(R.color.ds_hairline), hairline,
      ),
      activity.getColor(R.color.ds_accent_soft),
    )
  } else {
    button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    button.setTextColor(activity.getColor(R.color.ds_text_on_accent))
    button.background = DsUi.ripple(
      DsUi.roundRect(activity.getColor(R.color.ds_accent), res.getDimension(R.dimen.ds_radius_pill)),
      activity.getColor(R.color.ds_accent_pressed),
    )
  }
}

private fun chipView(activity: ComponentActivity, type: android.graphics.Typeface): TextView {
  val res = activity.resources
  return TextView(activity).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    setTextColor(activity.getColor(R.color.ds_text_secondary))
    typeface = type
    gravity = Gravity.CENTER
    maxLines = 1
    ellipsize = TextUtils.TruncateAt.END
    background = DsUi.roundRect(
      activity.getColor(R.color.ds_chip),
      res.getDimension(R.dimen.ds_radius_pill),
    )
    val padH = (10 * res.displayMetrics.density).toInt()
    val padV = (7 * res.displayMetrics.density).toInt()
    setPadding(padH, padV, padH, padV)
  }
}

/**
 * 状态 chip 的观感（S1-7）：**可动作**与**纯事实**必须在视觉上分得开。
 *
 * 缺陷现场：runtimeChip（纯事实，不可点）与 storageChip（可点）外观**逐像素相同**，
 * 用户没有任何线索知道哪个能点——只能靠试。修法不是给可点的那枚加个装饰，而是让
 * 「能点」这件事本身有形态：强调色文字 + 同色描边 + 按压反馈；不可点的一枚保持中性灰无描边。
 */
internal fun styleStorageChip(
  activity: ComponentActivity,
  chip: TextView,
  actionable: Boolean,
  danger: Boolean = false,
) {
  val res = activity.resources
  val pill = res.getDimension(R.dimen.ds_radius_pill)
  val hairline = res.displayMetrics.density.toInt().coerceAtLeast(1)
  // 破坏/故障态（写入失败）保留红调：它虽然也可点，但语义是「出事了」，不是「去做吧」。
  val ink = activity.getColor(if (danger) R.color.ds_danger else R.color.ds_accent)
  if (actionable) {
    chip.setTextColor(ink)
    chip.background = DsUi.roundRect(activity.getColor(R.color.ds_chip), pill, ink, hairline)
    DsUi.bindPressScale(chip, 0.97f)
  } else {
    chip.setTextColor(activity.getColor(R.color.ds_text_secondary))
    chip.background = DsUi.roundRect(activity.getColor(R.color.ds_chip), pill)
  }
  chip.isClickable = actionable
  chip.isFocusable = actionable
}

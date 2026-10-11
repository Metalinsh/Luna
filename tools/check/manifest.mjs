/**
 * Luna 测试清单。
 *
 * 设计原则：
 *   1. 每个「区域」对应一块功能，区域之间的断言**不重复**。
 *      同一行为只在一个区域里验证，需要时用注释指向负责的区域。
 *   2. 每个区域声明自己覆盖哪些源码文件，运行器据此实现
 *      「局部改动 → 只跑受影响区域」。
 *   3. 单元测试不需要启动软件；界面检查需要 Electron 开发实例。
 */

/** 所有界面检查共用的开发实例配置 */
export const APP = {
  apiBase: 'http://127.0.0.1:8799',
  cdpPort: 9360,
  /** 启动命令由运行器拼装：electron . --remote-debugging-port=<cdpPort> */
};

/**
 * 区域定义。
 *   id       命令行用的短名
 *   title    中文名（报告里显示）
 *   unit     node --test 的目标（相对仓库根）
 *   ui       界面脚本（相对 tools/）
 *   app      是否需要 Electron 开发实例
 *   covers   该区域覆盖的源码路径前缀（用于局部测试）
 *   slow     是否属于耗时较长的检查
 */
export const AREAS = [
  {
    id: 'unit',
    title: '单元测试',
    desc: '解析、数据库、迁移、歌词格式、写入任务等纯逻辑',
    // 该 Node 版本不接受目录参数（node --test test/ 会报模块找不到），
    // 用 unitAuto 表示「不加路径，由 node --test 自动发现 test/ 下的用例」
    unit: [],
    unitAuto: true,
    ui: [],
    app: false,
    covers: ['server/', 'test/'],
  },
  {
    id: 'wall',
    title: '专辑墙',
    desc: '卡片与角标、标签筛选（风格/社团/CV 三栏）、三个收藏入口、收藏视图、从详情返回保留浏览进度',
    unit: [],
    ui: ['check/wall.mjs', 'check/favorites.mjs'],
    app: true,
    covers: ['public/app.js', 'public/styles.css', 'public/index.html', 'server/index.mjs', 'server/db.mjs'],
  },
  {
    id: 'bulk',
    title: '多选、批量填写与从库中移除',
    desc: '选择按钮样式、批量填艺术家/社团（仅 ASMR 生效）、多选后「从库中移除」（只删索引不碰文件 + 确认文案 + 设置里的恢复入口）',
    unit: ['test/albums-tags.test.mjs'],
    ui: ['check/bulk.mjs'],
    app: true,
    covers: [
      'public/app.js', 'public/index.html', 'public/styles.css',
      'server/index.mjs', 'server/db.mjs', 'server/scanner.mjs',
    ],
  },
  {
    id: 'detail',
    title: '专辑详情',
    desc: '曲目表布局、列宽拖动、双击名称播放、多艺术家显示、图片预览与看原图、点封面看原图',
    unit: [],
    ui: ['check/detail.mjs', 'check/gallery.mjs'],
    app: true,
    covers: ['public/app.js', 'public/styles.css', 'server/db.mjs', 'server/index.mjs', 'server/gallery.mjs'],
  },
  {
    id: 'voice',
    title: '音声专辑',
    desc: '版本与差分、特典、视频版、三层轨道模型、ASMR 自动打标、图片不进轨道',
    unit: [],
    ui: ['check/voice.mjs', 'check/voice-fixes.mjs'],
    app: true,
    covers: ['server/asmr.mjs', 'server/scanner.mjs', 'server/db.mjs', 'public/app.js', 'public/styles.css'],
  },
  {
    id: 'artist',
    title: '艺术家与社团',
    desc: '以 artist 为准的识别、待确认提示、采用/保持现状、自动套用与同名标签',
    unit: [],
    ui: ['check/artist.mjs'],
    app: true,
    covers: ['server/asmr.mjs', 'server/scanner.mjs', 'server/db.mjs', 'server/index.mjs', 'public/app.js'],
  },
  {
    id: 'lyrics',
    title: '歌词与字幕',
    desc: 'LRC/VTT/SRT/ASS 识别与解析、台本镜像目录、单曲详情布局、字号 A+/A-',
    unit: [],
    ui: ['check/lyrics.mjs'],
    app: true,
    covers: ['server/lyrics.mjs', 'public/app.js', 'public/styles.css'],
  },
  {
    id: 'player',
    title: '播放器',
    desc: '播放组件常驻、四种播放模式、单曲详情浮层与进度条',
    unit: [],
    ui: ['check/player.mjs'],
    app: true,
    covers: ['public/app.js', 'public/styles.css', 'public/index.html'],
  },
  {
    id: 'write',
    title: '安全写回',
    desc: '标签写回的副本校验、原文件入撤销区、撤销恢复',
    unit: [],
    ui: ['check/write.mjs'],
    app: true,
    covers: ['server/writers.mjs', 'server/write-jobs.mjs', 'server/index.mjs'],
  },
  {
    id: 'archive',
    title: '压缩包只读挂载',
    desc: 'ZIP 清单解析与编码嗅探、压缩包入库与角标、包内曲目禁播告知、预读专辑/清除缓存与「已预读」标签、包内封面提取（与音声共用 pickCover 口径）',
    // 单元测试覆盖 zip-reader 与压缩包封面挑选；界面检查只验「扫出来的包在界面上表现正确」
    unit: ['test/zip-reader.test.mjs', 'test/archive-cover.test.mjs'],
    ui: ['check/archive.mjs'],
    app: true,
    covers: [
      'server/zip-reader.mjs', 'server/scanner.mjs', 'server/asmr.mjs', 'server/gallery.mjs',
      'server/db.mjs', 'server/index.mjs', 'public/app.js', 'public/styles.css',
    ],
  },
  {
    id: 'settings',
    title: '设置界面',
    desc: '⚙ 位置与面板结构、压缩包预取与缓存设置、桌面（关闭窗口最小化到托盘）、三种配色与背景透明度、提醒文案',
    unit: [],
    ui: ['check/settings.mjs'],
    app: true,
    covers: ['public/app.js', 'public/styles.css', 'public/index.html', 'server/config.mjs', 'server/collection.mjs', 'server/index.mjs'],
  },
  {
    id: 'icon',
    title: '图标资源',
    desc: 'ICO/PNG 生成与接入、界面品牌标与网页图标',
    unit: [],
    ui: ['check/icon.mjs'],
    app: true,
    covers: ['build/', 'icon/', 'public/index.html', 'public/styles.css', 'electron/main.cjs', 'electron-builder.yml'],
  },
];

/** 发布前必须全绿的区域（= 全部） */
export const RELEASE_AREAS = AREAS.map((a) => a.id);

/** 不需要启动软件即可运行的区域 */
export const NO_APP_AREAS = AREAS.filter((a) => !a.app).map((a) => a.id);

/**
 * 局部测试用：把变更文件映射到受影响区域。
 * 未命中任何规则的改动（如文档、工具脚本）不触发任何区域。
 */
export function areasForFiles(files) {
  const hit = new Set();
  for (const raw of files) {
    const f = String(raw).replace(/\\/g, '/').trim();
    if (!f) continue;
    for (const area of AREAS) {
      for (const prefix of area.covers) {
        if (f === prefix || f.startsWith(prefix)) { hit.add(area.id); break; }
      }
    }
  }
  return [...hit];
}

export function areaById(id) {
  return AREAS.find((a) => a.id === id) ?? null;
}

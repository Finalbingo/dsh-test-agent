window.__ModuleLoader__.load({
	id: 'dsh-cts-agent',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		// 新建项目先建空项目；生成配置（项目类型/来源/页面词表）在项目设置里选择。
		const QUALITY_TEMPLATES = {
			full: { label: '全量（PRD + DBC + 设计稿）', capabilities: ['text', 'protocol', 'design'], surfaces: ['主界面', '列表页', '详情页'], default_surface: '主界面', sources: { prd: '', dbc: '', design: '' } },
			protocol: { label: '界面项目 + 协议(DBC)', capabilities: ['text', 'protocol'], surfaces: ['主界面', '列表页', '详情页'], default_surface: '主界面', sources: { prd: '', dbc: '' } },
			ui: { label: '界面项目（无协议）', capabilities: ['text'], surfaces: ['主界面', '列表页', '详情页'], default_surface: '主界面', sources: { prd: '' } },
			doc: { label: '纯文档', capabilities: ['text'], surfaces: ['页面'], default_surface: '页面', sources: { prd: '' } }
		};
		const projectQualityReady = (project) => {
			const quality = project?.quality;
			if (!quality || !Array.isArray(quality.surfaces) || quality.surfaces.length === 0) return false;
			if (!String(quality.sources?.prd || '').trim()) return false;
			if ((quality.capabilities || []).includes('protocol') && !String(quality.sources?.dbc || '').trim()) return false;
			return true;
		};
		const cloneQuality = (value) => JSON.parse(JSON.stringify(value));
		const qualityTemplate = (key) => {
			const template = QUALITY_TEMPLATES[key] || QUALITY_TEMPLATES.doc;
			return {
				capabilities: [...template.capabilities],
				surfaces: [...template.surfaces],
				default_surface: template.default_surface,
				coverage_mode: 'standard',
				include_single_entries: false,
				sources: { ...template.sources }
			};
		};

		const CSS = `
/* Swiss Technical Lab — 精密工业测绘室视觉体系 */
.cts-page {
  color-scheme:light;
  --dsw-alias-bg-base:#f4f5f3;
  --dsw-alias-bg-layer-1:#ffffff;
  --dsw-alias-bg-layer-2:#ecefed;
  --dsw-alias-label-primary:#141a18;
  --dsw-alias-label-secondary:#56615d;
  --dsw-alias-border-l1:#e2e6e3;
  --dsw-alias-border-l2:#cdd4cf;
  --dsw-alias-brand-primary:#0f5c5e;
  --dsw-alias-brand-hover:#0b4749;
  --dsw-alias-brand-soft:#e8f2f2;
  --dsw-alias-accent:#0f5c5e;
  --dsw-alias-state-error-primary:#b42318;
  --dsw-alias-state-success-primary:#166549;
  --dsw-alias-state-warn-primary:#a3570e;
  --cts-font-sans:"SF Pro Text","PingFang SC","Hiragino Sans GB","Microsoft YaHei",-apple-system,BlinkMacSystemFont,sans-serif;
  --cts-font-mono:"SF Mono","JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  accent-color:var(--dsw-alias-brand-primary);
  font-family:var(--cts-font-sans);
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
  text-rendering:optimizeLegibility;
}
.cts-page *, .cts-page *::before, .cts-page *::after { box-sizing:border-box; }
.cts-page { display:flex; flex-direction:column; height:100%; min-height:0; font-size:13px; line-height:1.5; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); }
.cts-head { flex:0 0 auto; position:relative; display:flex; align-items:center; flex-wrap:wrap; gap:8px; padding:9px 16px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.cts-page .cts-head:has(> .cts-activity-entry) { padding-inline-end:154px; min-height:46px; }
.cts-title { font-size:15px; font-weight:600; letter-spacing:-.01em; margin-right:4px; }

/* 顶部导航与分段切换 */
.cts-nav { display:flex; align-items:center; gap:3px; }
.cts-navbtn { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; padding:0; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); font-size:15px; line-height:1; cursor:pointer; transition:background .12s, color .12s, border-color .12s; }
.cts-navbtn:disabled { opacity:.32; cursor:default; }
.cts-navbtn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-border-l2); }
.cts-modes { display:inline-flex; align-items:center; gap:2px; padding:3px; border-radius:8px; background:var(--dsw-alias-bg-layer-2); }
.cts-mode { font:inherit; font-size:12.5px; font-weight:500; padding:4px 11px; border:0; border-radius:6px; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; transition:background .12s, color .12s; }
.cts-mode:hover:not(:disabled):not(.on) { color:var(--dsw-alias-label-primary); }
.cts-mode.on { background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font-weight:600; box-shadow:0 1px 2px rgba(20,26,24,.08); }
.cts-mode:disabled { opacity:.4; cursor:default; }
.cts-select { font:inherit; font-size:12.5px; padding:5px 10px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); max-width:260px; transition:border-color .12s; }
.cts-select:hover:not(:disabled) { border-color:var(--dsw-alias-label-secondary); }
.cts-status { margin-left:auto; display:flex; align-items:center; gap:7px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.cts-dot { width:7px; height:7px; border-radius:50%; background:var(--dsw-alias-border-l2); }
.cts-dot.on { background:var(--dsw-alias-brand-primary); box-shadow:0 0 0 3px var(--dsw-alias-brand-soft); }
.cts-dot.err { background:var(--dsw-alias-state-error-primary); }

/* 动作记录浮层：按任务合并 + 实时进度条 */
.cts-activity-entry { position:absolute; top:8px; right:14px; z-index:12; }
.cts-activity-toggle { display:inline-flex; align-items:center; gap:7px; white-space:nowrap; font-size:12.5px; font-weight:500; padding:5px 11px; border-radius:7px; }
.cts-activity-toggle.running { border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-brand-soft); color:var(--dsw-alias-brand-primary); }
.cts-activity-toggle[aria-expanded="true"] { border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.cts-act-indicator { width:7px; height:7px; border-radius:50%; background:var(--dsw-alias-label-secondary); opacity:.5; }
.cts-act-indicator.live { background:var(--dsw-alias-brand-primary); opacity:1; animation:cts-pulse 1.6s ease-in-out infinite; }
.cts-activity-unread { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-brand-primary); }
.cts-activity-panel { position:absolute; top:calc(100% + 8px); right:0; display:flex; flex-direction:column; width:min(420px, calc(100vw - 32px)); max-height:min(600px, 76vh); border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-1); box-shadow:0 16px 40px rgba(20,26,24,.14), 0 2px 6px rgba(20,26,24,.05); overflow:hidden; }
.cts-activity-panel[hidden] { display:none; }
.cts-activity-panel header { flex:none; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:11px 14px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.cts-act-head-title { display:flex; align-items:center; gap:8px; min-width:0; }
.cts-act-head-title strong { font-size:13.5px; font-weight:600; color:var(--dsw-alias-label-primary); white-space:nowrap; }
.cts-act-scope-tag { font-size:11px; font-weight:500; padding:2px 8px; border-radius:999px; background:var(--dsw-alias-brand-soft); color:var(--dsw-alias-brand-primary); max-width:190px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cts-act-close { padding:3px 9px; font-size:11.5px; }
.cts-act-filterbar { flex:none; display:flex; align-items:center; gap:6px; padding:8px 14px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); }
.cts-act-chip { font:inherit; font-size:11.5px; font-weight:500; padding:3px 10px; border-radius:6px; border:1px solid transparent; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; transition:background .12s, color .12s; }
.cts-act-chip:hover { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-2); }
.cts-act-chip.on { background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-border-l2); font-weight:600; }
.cts-activity-scroll { min-height:0; overflow:auto; overscroll-behavior:contain; padding:10px 12px 12px; background:var(--dsw-alias-bg-base); }
.cts-activity-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }
.cts-act-card { display:flex; flex-direction:column; gap:6px; padding:10px 12px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); overflow-wrap:anywhere; }
.cts-act-card.is-live { border-color:var(--dsw-alias-brand-primary); box-shadow:inset 3px 0 0 var(--dsw-alias-brand-primary); }
.cts-act-card.is-err { border-color:#f2c6c2; box-shadow:inset 3px 0 0 var(--dsw-alias-state-error-primary); }
.cts-act-top { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.cts-act-role { display:inline-flex; align-items:center; padding:1px 7px; border-radius:4px; font-size:10.5px; font-weight:600; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); }
.cts-act-role[data-role="requirements"] { background:#e8f2f2; color:#0f5c5e; }
.cts-act-role[data-role="design"] { background:#eef1f8; color:#2b477d; }
.cts-act-role[data-role="quality"],.cts-act-role[data-role="review"] { background:#f6efe4; color:#8f4d0e; }
.cts-act-time { font-family:var(--cts-font-mono); font-variant-numeric:tabular-nums; font-size:11px; color:var(--dsw-alias-label-secondary); }
.cts-act-main { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.cts-act-action { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }
.cts-activity-stage { display:inline-flex; align-items:center; font-size:11px; font-weight:500; color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.cts-activity-stage[data-stage="started"],.cts-activity-stage[data-stage="progress"],.cts-activity-stage[data-stage="tool"] { color:var(--dsw-alias-brand-primary); }
.cts-activity-stage[data-stage="failed"],.cts-activity-stage[data-stage="tool_failed"],.cts-activity-stage[data-stage="partial"] { color:var(--dsw-alias-state-error-primary); }
.cts-activity-stage[data-stage="completed"],.cts-activity-stage[data-stage="tool_completed"] { color:var(--dsw-alias-state-success-primary); }
.cts-act-detail { font-size:12px; color:var(--dsw-alias-label-secondary); line-height:1.45; }
.cts-act-prog { display:flex; align-items:center; gap:8px; margin-top:1px; }
.cts-act-track { flex:1 1 auto; height:5px; border-radius:999px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; position:relative; }
.cts-act-fill { height:100%; border-radius:999px; background:var(--dsw-alias-brand-primary); transition:width .25s ease; }
.cts-act-fill.done { background:var(--dsw-alias-state-success-primary); }
.cts-act-fill.err { background:var(--dsw-alias-state-error-primary); }
.cts-act-fill.indeterminate { width:38%; position:relative; animation:cts-slide 1.2s ease-in-out infinite; }
.cts-act-pct { flex:none; font-family:var(--cts-font-mono); font-variant-numeric:tabular-nums; font-size:11px; font-weight:500; color:var(--dsw-alias-label-secondary); min-width:44px; text-align:right; }
.cts-act-foot { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.cts-act-foot:empty { display:none; }
.cts-activity-meta { color:var(--dsw-alias-label-secondary); font-size:11px; }
.cts-act-jump { padding:2px 8px; font-size:11px; }
.cts-act-empty { margin:24px 0; text-align:center; font-size:12px; color:var(--dsw-alias-label-secondary); }
.cts-act-more { width:100%; margin-top:8px; }
@keyframes cts-pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:.4; transform:scale(.85); } }
@keyframes cts-slide { 0% { transform:translateX(-110%); } 100% { transform:translateX(270%); } }
@media (prefers-reduced-motion: reduce) {
  .cts-act-indicator.live, .cts-act-fill.indeterminate { animation:none; }
}

/* 按钮与表单控件 */
.cts-btn { font:inherit; font-size:12.5px; font-weight:500; padding:5px 12px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); cursor:pointer; transition:background .12s, border-color .12s, color .12s; }
.cts-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); border-color:#b8c1bc; }
.cts-btn.primary { background:var(--dsw-alias-brand-primary); color:#ffffff; border-color:var(--dsw-alias-brand-primary); }
.cts-btn.primary:hover:not(:disabled) { background:var(--dsw-alias-brand-hover); border-color:var(--dsw-alias-brand-hover); }
.cts-btn.danger { color:var(--dsw-alias-state-error-primary); border-color:#f2c6c2; background:#fdf3f2; }
.cts-btn.danger:hover:not(:disabled) { background:#fae4e2; border-color:#e5a5a0; }
.cts-btn:disabled { opacity:.45; cursor:default; }
.cts-input { font:inherit; font-size:13px; resize:vertical; min-height:64px; max-height:200px; padding:8px 10px; border-radius:7px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); transition:border-color .12s; }
.cts-input:focus { border-color:var(--dsw-alias-brand-primary); }
.cts-input-sm { padding:5px 9px; font-size:12.5px; min-height:32px; }
.cts-row { display:flex; align-items:center; gap:8px; }
.cts-hint { font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.cts-err { margin:0 20px; padding:9px 12px; border-radius:7px; background:#fdf3f2; border:1px solid #f2c6c2; color:var(--dsw-alias-state-error-primary); font-size:12.5px; }
.cts-empty { margin:auto; max-width:440px; text-align:center; color:var(--dsw-alias-label-secondary); line-height:1.8; font-size:13px; }
.cts-empty code { font-family:var(--cts-font-mono); font-size:11.5px; background:var(--dsw-alias-bg-layer-2); padding:1px 6px; border-radius:4px; }
.cts-page :focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }

/* 主体布局与工作区 */
.cts-body { flex:1 1 auto; display:flex; min-height:0; position:relative; gap:0; container-type:inline-size; }
.cts-workspace { flex:1; min-width:0; min-height:0; display:flex; flex-direction:column; }
.cts-workspace .cts-tabs { margin:0; padding:10px 18px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); overflow:auto; flex:0 0 auto; }
.cts-workspace .cts-tab { white-space:nowrap; }
.cts-workspace .cts-model-tabs { align-items:center; flex-wrap:wrap; padding:8px 18px 8px 22px; background:var(--dsw-alias-bg-base); }
.cts-model-tabs-label { margin-inline-end:6px; color:var(--dsw-alias-label-secondary); font-size:11.5px; }
.cts-workspace .cts-right { width:auto; flex:1; min-width:0; padding:18px 22px; border-left:0; background:var(--dsw-alias-bg-base); }
.cts-workspace .cts-item { padding:11px 13px; background:var(--dsw-alias-bg-layer-1); }

/* 项目条与流程条 */
.cts-projectbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:7px 16px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); }
.cts-projectbar .cts-crumb { border:0; background:transparent; color:var(--dsw-alias-label-primary); font-size:12.5px; font-weight:600; padding:4px 2px; cursor:pointer; }
.cts-projectbar .cts-crumb:hover { color:var(--dsw-alias-brand-primary); }
.cts-projectbar .cts-hint { margin-left:auto; }
.cts-flow { flex:0 0 auto; padding:9px 16px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.cts-flow-bar { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
.cts-flow-track { display:flex; flex-wrap:wrap; gap:5px; align-items:center; }
.cts-flow-track button { padding:4px 10px; font-size:12px; }
.cts-flow-track [aria-current="step"] { color:#ffffff; background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.cts-flow-next { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px 14px; margin-top:8px; padding:8px 12px; border-radius:7px; border:1px solid var(--dsw-alias-border-l1); border-inline-start:3px solid var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-base); }
.cts-flow-next-text { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; min-width:0; flex:1 1 240px; }
.cts-flow-next p { margin:0; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-secondary); }
.cts-flow-tools { margin-top:5px; color:var(--dsw-alias-label-secondary); font-size:11.5px; }
.cts-flow-tools summary,.cts-model-tools summary { cursor:pointer; }
.cts-flow-tools .cts-filter { margin-bottom:0; }

/* 通知与进度条 */
.cts-notice { margin:10px 18px 0; padding:9px 14px; border-radius:7px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); display:flex; align-items:center; justify-content:space-between; gap:10px; font-size:12.5px; overflow-wrap:anywhere; }
.cts-notice[data-tone="success"] { border-color:#b7dfc9; background:#eff8f3; color:#166549; }
.cts-notice[data-tone="info"] { border-color:#bcd7d8; background:var(--dsw-alias-brand-soft); color:var(--dsw-alias-brand-primary); }
.cts-notice[data-tone="warning"] { border-color:#eed4ad; background:#fdf7ed; color:#8f4d0e; }
.cts-notice[data-tone="error"] { border-color:#f2c6c2; background:#fdf3f2; color:var(--dsw-alias-state-error-primary); }
.cts-notice-close { border:0; background:transparent; color:inherit; opacity:.65; cursor:pointer; font-size:15px; line-height:1; padding:0 4px; }
.cts-notice-close:hover { opacity:1; }
.cts-progress-strip { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:8px 16px; border-bottom:1px solid #bcd7d8; background:var(--dsw-alias-brand-soft); color:var(--dsw-alias-brand-primary); font-size:12px; font-weight:500; }
.cts-progress { width:168px; height:6px; border-radius:999px; accent-color:var(--dsw-alias-brand-primary); }
.cts-summary-strip { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:9px 12px; margin:6px 0 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); }

/* 胶囊与标签 */
.cts-pill { display:inline-flex; align-items:center; gap:4px; padding:2px 9px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); font-size:11.5px; line-height:1.5; font-variant-numeric:tabular-nums; }
.cts-pill.ok { border-color:#b7dfc9; background:#eff8f3; color:#166549; }
.cts-pill.warn { border-color:#eed4ad; background:#fdf7ed; color:#8f4d0e; }
.cts-pill.info { border-color:#bcd7d8; background:var(--dsw-alias-brand-soft); color:var(--dsw-alias-brand-primary); }
.cts-pill.err { border-color:#f2c6c2; background:#fdf3f2; color:var(--dsw-alias-state-error-primary); }
button.cts-pill { cursor:pointer; transition:border-color .12s, color .12s, background .12s; }
button.cts-pill:hover { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
button.cts-pill.active { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:#ffffff; }
.cts-tabs { display:flex; gap:5px; margin:6px 0 8px; }
.cts-tab { font:inherit; font-size:12px; font-weight:500; padding:4px 11px; border-radius:6px; border:1px solid transparent; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; transition:background .12s, color .12s; }
.cts-tab:hover:not(.on) { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.cts-tab.on { background:var(--dsw-alias-brand-soft); color:var(--dsw-alias-brand-primary); border-color:#bcd7d8; font-weight:600; }

/* 判据卡片与步骤锚点高亮 */
.cts-expected-list { display:flex; flex-direction:column; gap:7px; margin-top:8px; }
.cts-expected-card { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:9px 12px; background:var(--dsw-alias-bg-layer-1); cursor:pointer; transition:border-color .12s, background .12s; }
.cts-expected-card:hover { border-color:#93bdbd; }
.cts-expected-card.active { border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-brand-soft); }
.cts-expected-head { display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:11.5px; margin-bottom:4px; }
.cts-expected-target { font-size:12.5px; color:var(--dsw-alias-label-primary); line-height:1.55; }
.cts-step-evidence { padding:12px 0; border-top:1px solid var(--dsw-alias-border-l1); }
.cts-step-evidence.anchor-hit { background:var(--dsw-alias-brand-soft); border-radius:8px; padding:12px; border:1px solid var(--dsw-alias-brand-primary); margin:4px 0; }
.cts-step-evidence.anchor-trigger { background:#eff8f3; border-radius:8px; padding:12px; border:1px solid var(--dsw-alias-state-success-primary); margin:4px 0; }

/* 对话框 */
.cts-page dialog { border:1px solid var(--dsw-alias-border-l2); border-radius:10px; color:inherit; background:var(--dsw-alias-bg-layer-1); box-shadow:0 20px 48px rgba(20,26,24,.18); }
.cts-page dialog::backdrop { background:rgba(20,26,24,.42); }
.cts-confirm-dialog { width:min(520px, 92vw); padding:20px 22px; }
.cts-confirm-dialog h3 { margin:0 0 8px; font-size:15.5px; font-weight:600; }
.cts-confirm-dialog p { margin:0 0 10px; font-size:12.5px; color:var(--dsw-alias-label-secondary); line-height:1.65; white-space:pre-wrap; }
.cts-confirm-preview { max-height:220px; overflow:auto; margin:8px 0 12px; padding:9px 11px; border:1px solid var(--dsw-alias-border-l1); border-radius:7px; background:var(--dsw-alias-bg-base); font-family:var(--cts-font-mono); font-size:11px; line-height:1.6; white-space:pre-wrap; }
.cts-source-scope { width:min(720px, 85vw); max-height:75vh; overflow:auto; }

/* 模型工作台与记录分栏 */
.cts-model-tools { margin:4px 0 12px; }
.cts-model-tools .cts-actions { margin-top:6px; flex-wrap:wrap; }
.cts-contract-scenario { display:grid; gap:8px; margin:0; }
.cts-contract-scenario div { padding:9px 11px; border-radius:7px; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); }
.cts-contract-scenario dt { font-size:11px; color:var(--dsw-alias-label-secondary); }
.cts-contract-scenario dd { margin:3px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; }
.cts-records { flex:1; min-height:0; display:flex; }
.cts-records > .cts-right { min-height:0; }
.cts-records.selected > .cts-right:first-child { flex:0 0 36%; border-right:1px solid var(--dsw-alias-border-l1); }
.cts-records .cts-item[aria-current="true"] { border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-brand-soft); }
.cts-evidence-text { white-space:pre-wrap; overflow-wrap:anywhere; }
.cts-workspace .cts-item-m { font-family:var(--cts-font-mono); }

/* 侧栏对话 */
.cts-page .cts-chat { order:2; width:clamp(360px, 43%, 540px); flex:0 0 auto; border-left:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.cts-chat-head { flex:none; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:11px 14px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.cts-chat .cts-scroll { min-height:0; padding:14px; overscroll-behavior:contain; }
.cts-chat .cts-msg { flex:none; min-width:0; max-width:100%; overflow-wrap:anywhere; }
.cts-chat .cts-msg.user { max-width:90%; }
.cts-chat .cts-composer .cts-input { min-height:54px; max-height:min(24vh, 140px); }
.cts-filter { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:8px 0; }
.cts-page .cts-filter input { flex:1 1 180px; max-width:460px; min-height:34px; }
.cts-page .cts-field input,.cts-page .cts-field select { min-height:34px; }
.cts-model-shell { container-type:inline-size; }
.cts-contract-editor { display:grid; gap:10px; }
.cts-contract-editor pre { max-height:240px; overflow:auto; }
.cts-contract-editor input { min-height:34px; }
.cts-contract-list { max-height:min(52vh, 540px); overflow:auto; padding:0 4px 2px 0; }
.cts-contract-list h3 { margin:12px 0 4px; font-size:13px; }
@container(max-width:760px) {
  .cts-contract-workbench .cts-contract-editor { order:1; }
  .cts-contract-list { max-height:180px; }
}
.cts-model-workbench { display:grid; grid-template-columns:minmax(250px, 1fr) minmax(300px, 1.35fr); gap:16px; align-items:start; }
.cts-model-issues { border:1px solid var(--dsw-alias-border-l1); border-radius:9px; padding:12px; min-width:0; background:var(--dsw-alias-bg-layer-1); }
.cts-model-issue-list { display:grid; gap:5px; max-height:42vh; overflow:auto; }
.cts-model-issue { text-align:left; white-space:normal; overflow-wrap:anywhere; }
.cts-model-issue[aria-pressed=true] { border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-brand-soft); }
.cts-model-detail { margin-top:12px; padding-top:12px; border-top:1px solid var(--dsw-alias-border-l1); display:grid; gap:8px; }
.cts-model-detail pre { max-height:210px; overflow:auto; margin:0; }
.cts-model-evidence { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 230px), 1fr)); gap:6px; }
.cts-model-workbench .cts-filter input[type=search] { min-height:34px; height:34px; }
.cts-model-workbench .cts-filter input[type=checkbox] { flex:none; min-height:auto; }
@container(max-width:760px) { .cts-model-workbench { grid-template-columns:minmax(0, 1fr); } .cts-model-issues { order:-1; } }
.cts-model-tree { margin-top:10px; }
.cts-model-node { min-width:0; }
.cts-model-node > summary { cursor:pointer; padding:8px 10px; border-radius:6px; overflow-wrap:anywhere; }
.cts-model-node > summary:hover { background:var(--dsw-alias-bg-layer-2); }
.cts-model-node > summary .cts-item-m { margin-inline-start:6px; }
.cts-model-children { margin:0 0 4px 15px; padding-inline-start:8px; border-inline-start:1px solid var(--dsw-alias-border-l2); }
.cts-model-leaf { padding:5px 10px; line-height:1.55; overflow-wrap:anywhere; }
.cts-case-header { padding:4px 0 14px; }
.cts-case-header h2 { margin:6px 0; font-size:20px; font-weight:600; letter-spacing:-.01em; line-height:1.35; }
.cts-case-header p { margin:8px 0 0; color:var(--dsw-alias-label-secondary); white-space:pre-wrap; }
.cts-workspace .cts-right > .cts-detail { max-width:940px; margin-inline:auto; }
.cts-figure { display:block; width:100%; max-width:500px; object-fit:contain; max-height:280px; background:var(--dsw-alias-bg-layer-2); border-radius:6px; }
.cts-figure-zoom { width:min(90vw,1000px); max-height:80vh; object-fit:contain; display:block; }
@container(max-width:760px) { .cts-page .cts-chat { position:absolute; inset:0; width:100%; z-index:4; border-left:0; } }
@media(max-width:760px) {
  .cts-page .cts-head { gap:6px; padding:8px; }
  .cts-workspace .cts-right { padding:12px; }
  .cts-records.selected > .cts-right:first-child { display:none; }
}

.cts-pkg { flex:0 0 auto; display:flex; align-items:center; gap:8px; padding:7px 16px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); font-size:12px; color:var(--dsw-alias-label-secondary); }
.cts-pkg .cts-btn { margin-left:0; }
.cts-left { width:256px; flex:0 0 auto; border-right:1px solid var(--dsw-alias-border-l1); padding:12px; overflow:auto; background:var(--dsw-alias-bg-layer-1); }
.cts-main { flex:1 1 auto; display:flex; flex-direction:column; min-width:0; min-height:0; }
.cts-right { width:296px; flex:0 0 auto; border-left:1px solid var(--dsw-alias-border-l1); padding:12px; overflow:auto; background:var(--dsw-alias-bg-layer-1); }
.cts-h { font-size:11.5px; color:var(--dsw-alias-label-secondary); margin:2px 0 6px; display:flex; align-items:center; gap:6px; }
.cts-h b { color:var(--dsw-alias-label-primary); font-weight:600; font-size:12.5px; }
.cts-scroll { flex:1 1 auto; overflow:auto; padding:16px 20px; display:flex; flex-direction:column; gap:12px; }
.cts-msg { display:flex; flex-direction:column; gap:4px; max-width:760px; }
.cts-role { font-size:11px; color:var(--dsw-alias-label-secondary); }
.cts-bubble { border:1px solid var(--dsw-alias-border-l1); border-radius:9px; padding:10px 12px; background:var(--dsw-alias-bg-base); white-space:pre-wrap; line-height:1.65; }
.cts-msg.user { align-self:flex-end; align-items:flex-end; }
.cts-msg.user .cts-bubble { background:var(--dsw-alias-brand-soft); border-color:#bcd7d8; }
.cts-bubble-md { white-space:normal; padding:10px 13px; }
.cts-md > *:first-child { margin-top:0; }
.cts-md > *:last-child { margin-bottom:0; }
.cts-md .cts-p { margin:6px 0; line-height:1.72; }
.cts-md .cts-h1, .cts-md .cts-h2, .cts-md .cts-h3, .cts-md .cts-h4 { margin:12px 0 6px; line-height:1.45; font-weight:600; }
.cts-md .cts-h1 { font-size:15px; }
.cts-md .cts-h2 { font-size:14px; }
.cts-md .cts-h3 { font-size:13px; }
.cts-md .cts-h4 { font-size:12.5px; }
.cts-md .cts-ul, .cts-md .cts-ol { margin:6px 0; padding-left:20px; }
.cts-md .cts-ul li, .cts-md .cts-ol li { margin:2px 0; line-height:1.7; }
.cts-md .cts-inline-code { font-family:var(--cts-font-mono); font-size:11.5px; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:4px; padding:0 4px; }
.cts-md .cts-code { margin:8px 0; padding:10px 12px; border-radius:7px; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); overflow:auto; }
.cts-md .cts-code code { font-family:var(--cts-font-mono); font-size:11.5px; line-height:1.6; }
.cts-md .cts-table-wrap { overflow-x:auto; margin:8px 0; }
.cts-md .cts-table { border-collapse:collapse; font-size:12px; min-width:100%; }
.cts-md .cts-table th, .cts-md .cts-table td { border:1px solid var(--dsw-alias-border-l1); padding:6px 9px; text-align:left; vertical-align:top; line-height:1.6; }
.cts-md .cts-table th { background:var(--dsw-alias-bg-base); font-weight:600; white-space:nowrap; }
.cts-md .cts-quote { margin:8px 0; padding:4px 10px; border-left:3px solid var(--dsw-alias-brand-primary); color:var(--dsw-alias-label-secondary); }
.cts-md .cts-hr { border:0; border-top:1px solid var(--dsw-alias-border-l1); margin:10px 0; }
.cts-md a { color:var(--dsw-alias-brand-primary); text-decoration:none; }
.cts-md a:hover { text-decoration:underline; }
.cts-tool { border:1px solid var(--dsw-alias-border-l1); border-radius:7px; background:var(--dsw-alias-bg-layer-1); font-size:11.5px; overflow:hidden; max-width:760px; }
.cts-tool-head { display:flex; align-items:center; gap:8px; padding:6px 10px; cursor:pointer; }
.cts-tool-name { font-family:var(--cts-font-mono); color:var(--dsw-alias-label-primary); }
.cts-tool-sum { color:var(--dsw-alias-label-secondary); margin-left:auto; }
.cts-tool-body { border-top:1px solid var(--dsw-alias-border-l1); padding:8px 10px; white-space:pre-wrap; font-family:var(--cts-font-mono); font-size:11px; color:var(--dsw-alias-label-secondary); max-height:220px; overflow:auto; }

/* Pixso / 设计资产检查器 */
.pk-body { display:flex; flex:1 1 auto; min-height:0; }
.pk-side { width:240px; flex:0 0 auto; border-right:1px solid var(--dsw-alias-border-l1); padding:8px; overflow:auto; display:flex; flex-direction:column; gap:2px; background:var(--dsw-alias-bg-layer-1); }
.pk-search { margin-bottom:6px; }
.pk-sec { font-size:11px; font-weight:600; color:var(--dsw-alias-label-secondary); margin:8px 0 3px; }
.pk-item { display:flex; align-items:center; gap:6px; padding:5px 7px; border-radius:6px; cursor:pointer; font-size:12px; }
.pk-item:hover { background:var(--dsw-alias-bg-layer-2); }
.pk-item.on { background:var(--dsw-alias-brand-soft); color:var(--dsw-alias-brand-primary); font-weight:600; }
.pk-ico { width:14px; text-align:center; opacity:.8; }
.pk-label { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pk-count { font-size:10.5px; color:var(--dsw-alias-label-secondary); }
.pk-size { flex:0 0 auto; font-size:10px; color:var(--dsw-alias-label-secondary); font-family:var(--cts-font-mono); white-space:nowrap; }
.pk-inspector { flex:1 1 auto; min-height:0; display:flex; }
.pk-preview { flex:1 1 auto; min-width:0; overflow:auto; padding:12px; display:flex; align-items:flex-start; justify-content:center; }
.pk-preview img { max-width:100%; max-height:70vh; object-fit:contain; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.pk-layer-image { position:relative; overflow:hidden; }
.pk-layer-image img { display:block; width:100%; height:auto; max-height:none; border:0; }
.pk-layer-selection { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
.pk-layer-image svg rect { filter:drop-shadow(0 0 1px #fff) drop-shadow(0 0 1px #fff); }
.pk-layer-label { position:absolute; pointer-events:none; max-width:45%; padding:2px 6px; border-radius:4px; background:var(--dsw-alias-brand-primary); color:#fff; font-size:11px; line-height:16px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pk-layer-zoom { position:absolute; bottom:8px; width:min(160px,42%); max-height:calc(100% - 16px); aspect-ratio:1; pointer-events:none; border:1px solid var(--dsw-alias-brand-primary); border-radius:6px; background:var(--dsw-alias-bg-layer-2); box-shadow:0 2px 8px rgba(20,26,24,.22); }
.pk-props { width:320px; flex:0 0 auto; border-left:1px solid var(--dsw-alias-border-l1); padding:10px; overflow:auto; background:var(--dsw-alias-bg-layer-1); }
.pk-detail { display:flex; flex:1 1 auto; min-height:0; flex-direction:row; }
.pk-detail-right { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; min-height:0; }
.pk-detail-bottom { flex:0 0 auto; max-height:38%; overflow:auto; border-top:1px solid var(--dsw-alias-border-l1); padding:8px 10px; display:flex; flex-direction:column; gap:6px; }
.pk-attr-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:2px 16px; }
.pk-detail-left { width:300px; flex:0 0 auto; border-right:1px solid var(--dsw-alias-border-l1); padding:8px; overflow:auto; }
.pk-detail-main { flex:1 1 auto; min-width:0; min-height:0; padding:8px; overflow:hidden; display:flex; flex-direction:column; }
.pk-canvas { position:relative; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); flex:0 0 auto; }
.pk-canvas-scroll { flex:1 1 auto; overflow:auto; display:flex; align-items:flex-start; justify-content:center; padding:8px; }
.pk-canvas-bar { display:flex; align-items:center; gap:8px; margin:4px 0 6px; }
.pk-zoom { margin-left:auto; display:flex; gap:4px; }
.pk-canvas-img { display:block; height:100%; object-fit:contain; }
.pk-scroll { max-height:70vh; overflow:auto; }
.pk-attr { display:flex; gap:8px; font-size:11px; line-height:1.65; color:var(--dsw-alias-label-secondary); word-break:break-all; }
.pk-attr-k { flex:0 0 52px; color:var(--dsw-alias-label-secondary); }
.pk-attr-v { flex:1 1 auto; color:var(--dsw-alias-label-primary); word-break:break-all; }
.pk-overlay { position:absolute; left:0; top:0; pointer-events:none; }
.pk-overlay rect { pointer-events:all; }
.pk-attrs { display:flex; flex-direction:column; gap:3px; }
.pk-attrs .pk-attr b { color:var(--dsw-alias-label-primary); font-size:12px; }
.pk-sec-block { margin-bottom:6px; }
.pk-tree { display:flex; flex-direction:column; gap:1px; }
.pk-node { display:flex; align-items:center; gap:5px; padding:3px 4px; border-radius:5px; cursor:pointer; font-size:12px; }
.pk-node:hover { background:var(--dsw-alias-bg-layer-2); }
.pk-caret { width:10px; font-size:9px; text-align:center; color:var(--dsw-alias-label-secondary); }
.pk-children { padding-left:14px; border-left:1px dashed var(--dsw-alias-border-l1); margin-left:5px; display:flex; flex-direction:column; gap:1px; }
.pk-leaf { display:flex; align-items:center; gap:5px; padding:3px 4px; border-radius:5px; cursor:pointer; font-size:11.5px; }
.pk-leaf:hover { background:var(--dsw-alias-bg-layer-2); }
.pk-leaf.on { background:var(--dsw-alias-brand-soft); color:var(--dsw-alias-brand-primary); font-weight:600; }
.pk-card.on { outline:1px solid var(--dsw-alias-brand-primary); }
.pk-tools { display:flex; flex-direction:column; gap:4px; margin-top:8px; border-top:1px solid var(--dsw-alias-border-l1); padding-top:8px; }
.pk-note { font-size:10.5px; color:var(--dsw-alias-label-secondary); white-space:pre-wrap; line-height:1.5; }
.pk-main { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; }
.pk-main > .cts-skill-panel { flex:1 1 0; width:auto; min-height:0; }
.pk-toolbar { display:flex; align-items:center; gap:8px; padding:9px 12px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.pk-crumb { font-size:12.5px; font-weight:600; }
.pk-stat { font-size:11px; color:var(--dsw-alias-label-secondary); }
.pk-badge { font-size:10px; padding:1px 6px; border-radius:5px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
.pk-badge.mcp { border-color:#bcd7d8; color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-brand-soft); }
.pk-badge.local { border-color:#eed4ad; color:#8f4d0e; background:#fdf7ed; }
.pk-notice { font-size:11.5px; color:var(--dsw-alias-brand-primary); max-width:46ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pk-actions { margin-left:auto; display:flex; gap:6px; align-items:center; }
.pk-grid { flex:1 1 auto; overflow:auto; padding:14px; display:grid; grid-template-columns:repeat(auto-fill, minmax(136px, 1fr)); gap:12px; align-content:start; }
.pk-card { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:7px; background:var(--dsw-alias-bg-layer-1); display:flex; flex-direction:column; gap:5px; }
.pk-thumb { height:88px; display:flex; align-items:center; justify-content:center; background:var(--dsw-alias-bg-base); border-radius:6px; overflow:hidden; }
.pk-thumb img { max-width:100%; max-height:100%; object-fit:contain; }
.pk-ico-lg { font-size:18px; color:var(--dsw-alias-label-secondary); }
.pk-thumb.doc { font-size:11px; color:var(--dsw-alias-label-secondary); }
.pk-name { font-size:11.5px; line-height:1.4; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pk-meta { font-size:10px; color:var(--dsw-alias-label-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pk-remove { align-self:flex-start; font-size:10px; padding:2px 6px; }

/* 列表条目与详情表单 */
.cts-gate { border:1px solid var(--dsw-alias-brand-primary); border-radius:8px; padding:10px 12px; background:var(--dsw-alias-brand-soft); display:flex; flex-direction:column; gap:6px; }
.cts-gate.done { border-color:var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); opacity:.85; }
.cts-gate-tag { font-size:11px; font-weight:600; color:var(--dsw-alias-brand-primary); }
.cts-gate-q { font-size:12.5px; line-height:1.65; }
.cts-gate-a { font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.cts-composer { flex:0 0 auto; border-top:1px solid var(--dsw-alias-border-l1); padding:10px 14px 12px; display:flex; flex-direction:column; gap:6px; }
.cts-actions { display:flex; gap:6px; margin-bottom:6px; }
.cts-actions .cts-btn { flex:1 1 0; padding:4px 8px; font-size:12px; }
.cts-list { margin-top:8px; display:flex; flex-direction:column; gap:8px; }
.cts-item { position:relative; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:9px 11px; background:var(--dsw-alias-bg-layer-1); transition:border-color .12s; }
.cts-item:hover { border-color:var(--dsw-alias-border-l2); }
.cts-item-pick { float:right; width:auto; min-height:auto; margin:0 0 4px 8px; }
.cts-item-t { font-size:12.5px; font-weight:500; line-height:1.55; color:var(--dsw-alias-label-primary); }
.cts-item-s { font-size:12px; color:var(--dsw-alias-label-secondary); margin-top:3px; line-height:1.55; }
.cts-item-m { font-size:10.5px; color:var(--dsw-alias-label-secondary); margin-top:4px; font-family:var(--cts-font-mono); font-variant-numeric:tabular-nums; }
.cts-lint { font-size:11.5px; color:var(--dsw-alias-state-error-primary); margin:2px 0 4px; }
.cts-cov { font-size:11.5px; color:var(--dsw-alias-label-secondary); margin:2px 0 6px; line-height:1.6; }
.cts-findings { margin:4px 0 8px; border:1px solid #f2c6c2; border-radius:8px; padding:7px 10px; background:#fdf3f2; }
.cts-findings summary { cursor:pointer; font-size:12px; font-weight:500; color:var(--dsw-alias-state-error-primary); }
.cts-finding { font-size:11.5px; color:var(--dsw-alias-label-primary); margin-top:5px; line-height:1.55; }
.cts-detail { display:flex; flex-direction:column; gap:10px; }
.cts-detail-head { display:flex; align-items:center; gap:8px; }
.cts-field { display:flex; flex-direction:column; gap:4px; }
.cts-field-l { font-size:11.5px; font-weight:500; color:var(--dsw-alias-label-secondary); }
.cts-detail-actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:4px; }
.cts-detail-actions .cts-btn { flex:1 1 auto; }

/* 工作台首页：建筑感纸面 + 左侧深青釉标尺，去除廉价蓝光渐变 */
.cts-workbench { flex:1 1 auto; min-height:0; overflow:auto; padding:22px 26px; display:flex; flex-direction:column; gap:18px; max-width:1360px; width:100%; margin:0 auto; }
.cts-hero { position:relative; border:1px solid var(--dsw-alias-border-l1); border-left:4px solid var(--dsw-alias-brand-primary); border-radius:10px; padding:22px 26px; background:var(--dsw-alias-bg-layer-1); }
.cts-hero-kicker { font-size:12px; font-weight:600; color:var(--dsw-alias-brand-primary); letter-spacing:.02em; }
.cts-hero h1 { margin:6px 0 8px; font-size:23px; font-weight:600; letter-spacing:-.015em; line-height:1.25; color:var(--dsw-alias-label-primary); }
.cts-hero p { margin:0; max-width:66ch; color:var(--dsw-alias-label-secondary); font-size:13px; line-height:1.68; }
.cts-hero-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:16px; }
.cts-workbench-grid { display:grid; grid-template-columns:minmax(0, 1.75fr) minmax(270px, .85fr); gap:18px; align-items:start; }
.cts-workbench-section { min-width:0; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); padding:16px 18px; }
.cts-workbench-section-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px; }
.cts-workbench-section-head h2 { margin:0; font-size:14.5px; font-weight:600; }
.cts-project-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(244px, 1fr)); gap:12px; }
.cts-project-card { display:flex; flex-direction:column; align-items:flex-start; gap:8px; min-height:112px; padding:14px 15px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-base); color:inherit; text-align:left; cursor:pointer; transition:border-color .12s, background .12s; }
.cts-project-card:hover { border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-1); }
.cts-project-card strong { font-size:14px; font-weight:600; overflow-wrap:anywhere; color:var(--dsw-alias-label-primary); }
.cts-project-card .cts-project-meta { display:flex; flex-wrap:wrap; gap:6px; color:var(--dsw-alias-label-secondary); font-size:11.5px; }
.cts-project-card .cts-project-foot { margin-top:auto; color:var(--dsw-alias-brand-primary); font-size:11.5px; font-weight:500; }
.cts-badge { display:inline-flex; align-items:center; padding:1px 7px; border-radius:5px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); font-size:11px; font-weight:500; }
.cts-badge.ok { background:#eff8f3; color:#166549; }
.cts-badge.warn { background:#fdf7ed; color:#8f4d0e; }
.cts-workbench-empty { padding:18px; border:1px dashed var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-base); }
.cts-workbench-empty strong { display:block; margin-bottom:4px; }
.cts-workflow-card { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); padding:16px 18px; }
.cts-workflow-card h2 { margin:0 0 4px; font-size:14.5px; font-weight:600; }
.cts-workflow-card p { margin:0 0 12px; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.6; }
.cts-workflow-step { display:grid; grid-template-columns:22px 1fr; gap:9px; padding:8px 0; border-top:1px solid var(--dsw-alias-border-l1); }
.cts-workflow-step:first-of-type { border-top:0; }
.cts-workflow-step b { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; border-radius:5px; background:var(--dsw-alias-brand-soft); color:var(--dsw-alias-brand-primary); font-family:var(--cts-font-mono); font-size:11px; font-weight:600; }
.cts-workflow-step span { color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.55; }
.cts-workflow-step strong { display:block; color:var(--dsw-alias-label-primary); font-size:12.5px; font-weight:600; }
@media (max-width: 860px) { .cts-workbench-grid { grid-template-columns:1fr; } }

/* 资产中心 */
.asset-center { flex:1 1 auto; min-height:0; overflow:auto; padding:20px 24px; display:flex; flex-direction:column; gap:14px; max-width:1360px; width:100%; margin:0 auto; }
.ac-header { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; flex-wrap:wrap; padding:18px 20px; border:1px solid var(--dsw-alias-border-l1); border-left:4px solid var(--dsw-alias-brand-primary); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
.ac-header h1 { margin:0 0 4px; font-size:19px; font-weight:600; letter-spacing:-.01em; color:var(--dsw-alias-label-primary); }
.ac-header p { margin:0; color:var(--dsw-alias-label-secondary); font-size:12.5px; line-height:1.55; }
.ac-header-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.ac-pills { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.ac-pill-group { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.ac-toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:10px 14px; border:1px solid var(--dsw-alias-border-l1); border-radius:9px; background:var(--dsw-alias-bg-layer-1); }
.ac-toolbar .cts-input { min-height:32px; flex:1 1 200px; max-width:340px; }
.ac-toolbar .cts-select { min-height:32px; }
.ac-toolbar-right { margin-left:auto; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.ac-table-wrap { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); overflow:auto; }
.ac-table { width:100%; border-collapse:collapse; font-size:12.5px; }
.ac-table th { text-align:left; font-size:11.5px; font-weight:600; color:var(--dsw-alias-label-secondary); padding:10px 14px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); white-space:nowrap; }
.ac-table td { padding:11px 14px; border-bottom:1px solid var(--dsw-alias-border-l1); vertical-align:middle; }
.ac-table tbody tr:last-child td { border-bottom:0; }
.ac-table tbody tr:hover { background:#f8f9f8; }
.ac-name-cell { display:flex; align-items:center; gap:10px; min-width:220px; }
.ac-type-icon { flex:0 0 auto; width:34px; height:34px; border-radius:7px; display:flex; align-items:center; justify-content:center; font-family:var(--cts-font-mono); font-size:10px; font-weight:700; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); }
.ac-type-icon[data-kind="prd"] { background:#e8f2f2; color:#0f5c5e; }
.ac-type-icon[data-kind="signals"] { background:#f0eef7; color:#52408a; }
.ac-type-icon[data-kind="design"] { background:#fdf4e8; color:#8f4d0e; }
.ac-type-icon[data-kind="global"] { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); }
.ac-name-main { min-width:0; }
.ac-name-title { font-weight:600; color:var(--dsw-alias-label-primary); overflow-wrap:anywhere; line-height:1.4; }
.ac-name-sub { font-size:11px; color:var(--dsw-alias-label-secondary); margin-top:2px; display:flex; gap:8px; flex-wrap:wrap; }
.ac-chips { display:flex; flex-wrap:wrap; gap:4px; align-items:center; max-width:340px; }
.ac-row-actions { display:flex; align-items:center; gap:6px; justify-content:flex-end; white-space:nowrap; }
.ac-row-actions .cts-btn { padding:4px 9px; font-size:11.5px; }
.asset-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); gap:12px; }
.asset-card { display:flex; flex-direction:column; gap:10px; padding:14px 16px; border:1px solid var(--dsw-alias-border-l1); border-radius:9px; background:var(--dsw-alias-bg-layer-1); transition:border-color .12s; }
.asset-card:hover { border-color:var(--dsw-alias-brand-primary); }
.asset-card-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.asset-badge { display:inline-flex; align-items:center; padding:2px 8px; border-radius:5px; font-size:11px; font-weight:500; white-space:nowrap; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); }
.asset-badge.global { background:var(--dsw-alias-brand-soft); color:var(--dsw-alias-brand-primary); }
.asset-badge.project { background:#eff8f3; color:#166549; }
.asset-badge.module,.asset-badge.warn { background:#fdf7ed; color:#8f4d0e; }
.asset-badge.readonly { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); }
.asset-type { font-size:11px; color:var(--dsw-alias-label-secondary); }
.asset-name { font-size:13px; font-weight:600; overflow-wrap:anywhere; line-height:1.45; }
.asset-meta { display:flex; flex-wrap:wrap; gap:8px; color:var(--dsw-alias-label-secondary); font-size:11px; }
.asset-tag-row { display:flex; flex-wrap:wrap; gap:4px; }
.asset-tag-chip { display:inline-flex; align-items:center; max-width:100%; padding:2px 7px; border-radius:5px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-secondary); font-size:11px; line-height:1.45; overflow-wrap:anywhere; }
.asset-tag-chip.shared { border-color:#bcd7d8; color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-brand-soft); }
.asset-tag-chip.none { border-style:dashed; opacity:.75; }
.asset-actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:auto; padding-top:8px; border-top:1px solid var(--dsw-alias-border-l1); }
.asset-actions button { padding:4px 9px; font-size:11.5px; }
.asset-empty { padding:32px 24px; text-align:center; border:1px dashed var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); font-size:12.5px; }
.asset-visibility-row { display:flex; align-items:center; gap:8px; padding:7px 9px; border-bottom:1px solid var(--dsw-alias-border-l1); font-size:12px; }
.asset-visibility-row:last-child { border-bottom:0; }
.asset-visibility-row .asset-name { flex:1 1 auto; }

/* 资料选择器与引导条 */
.cts-picker { display:grid; grid-template-columns:minmax(220px,1fr) minmax(260px,1.1fr); gap:12px; min-height:260px; }
.cts-picker-list { display:flex; flex-direction:column; gap:5px; max-height:340px; overflow:auto; padding-right:4px; }
.cts-picker-row { display:flex; align-items:flex-start; gap:6px; }
.cts-picker-row > input { margin-top:9px; flex:none; }
.cts-picker-row > .cts-picker-item { flex:1; }
.cts-picker-item { display:flex; flex-direction:column; gap:2px; text-align:left; padding:8px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:7px; background:var(--dsw-alias-bg-layer-1); cursor:pointer; }
.cts-picker-item.on { border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-brand-soft); }
.cts-picker-name { font-size:12.5px; font-weight:600; color:var(--dsw-alias-label-primary); overflow-wrap:anywhere; }
.cts-picker-meta { font-size:11px; color:var(--dsw-alias-label-secondary); }
.cts-picker-preview { border:1px solid var(--dsw-alias-border-l1); border-radius:9px; padding:12px; display:flex; flex-direction:column; gap:7px; background:var(--dsw-alias-bg-layer-1); }
.cts-picker-preview-head { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
.cts-picker-preview-meta { font-size:11px; color:var(--dsw-alias-label-secondary); }
.cts-preview-block { display:flex; flex-direction:column; gap:3px; }
.cts-preview-label { font-size:10.5px; color:var(--dsw-alias-label-secondary); }
.cts-preview-projects { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:2px; max-height:90px; overflow:auto; font-size:11.5px; }
.cts-preview-projects li { padding-left:10px; position:relative; }
.cts-preview-projects li::before { content:''; position:absolute; left:2px; top:.65em; width:3px; height:3px; border-radius:50%; background:var(--dsw-alias-brand-primary); }
.cts-preview-actions { margin-top:auto; padding-top:8px; }
@media (max-width: 820px) { .cts-picker { grid-template-columns:1fr; } }

.cts-guide { max-width:none; margin:12px 18px 0; padding:14px 18px; border:1px solid var(--dsw-alias-border-l1); border-left:3px solid var(--dsw-alias-brand-primary); border-radius:9px; background:var(--dsw-alias-bg-layer-1); display:flex; flex-direction:column; gap:9px; }
.cts-guide-kicker { color:var(--dsw-alias-brand-primary); font-size:11.5px; font-weight:600; }
.cts-guide h2 { margin:0; font-size:16px; font-weight:600; }
.cts-guide p { margin:0; color:var(--dsw-alias-label-secondary); font-size:12.5px; line-height:1.65; }
.cts-guide-steps { display:flex; gap:6px; flex-wrap:wrap; }
.cts-guide-step { display:flex; align-items:center; gap:5px; padding:3px 9px; border-radius:6px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-secondary); font-size:11px; border:1px solid var(--dsw-alias-border-l1); }
.cts-guide-step b { display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; border-radius:4px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-brand-primary); font-family:var(--cts-font-mono); font-size:10px; }
.cts-guide-step.on { border-color:#bcd7d8; color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-brand-soft); }
.cts-guide-step.done { color:#166549; background:#eff8f3; border-color:#b7dfc9; }
.cts-guide-step.done b { background:#166549; color:#ffffff; }
.cts-guide-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }

/* 项目首页、模块引导与 MCP 面板 */
.cts-project-home { flex:1 1 auto; min-height:0; overflow:auto; padding:22px 26px; display:flex; flex-direction:column; gap:18px; max-width:1360px; width:100%; margin:0 auto; }
.cts-project-home h1 { margin:0 0 4px; font-size:22px; font-weight:600; letter-spacing:-.015em; }
.cts-project-home p { margin:0; color:var(--dsw-alias-label-secondary); font-size:12.5px; line-height:1.7; }
.cts-module-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(236px,1fr)); gap:12px; }
.cts-module-start { display:flex; flex-direction:column; gap:14px; padding:22px 26px; overflow:auto; max-width:1200px; width:100%; margin:0 auto; }
.cts-option-grid { display:grid; grid-template-columns:repeat(2,minmax(260px,1fr)); gap:14px; }
.cts-option-card { border:1px solid var(--dsw-alias-border-l1); border-radius:9px; padding:16px 18px; background:var(--dsw-alias-bg-layer-1); display:flex; flex-direction:column; gap:8px; }
.cts-option-card h3 { margin:0; font-size:14.5px; font-weight:600; }
.cts-option-card p { margin:0; color:var(--dsw-alias-label-secondary); font-size:12.5px; line-height:1.65; }
@media (max-width: 860px) { .cts-option-grid { grid-template-columns:1fr; } }
@media (max-width: 720px) {
  .cts-module-start { padding:12px; }
  .cts-picker-list { max-height:240px; }
  .cts-picker-preview { max-height:none; }
  .cts-hero-actions { flex-wrap:wrap; }
}
.cts-mcp-box { margin-top:10px; padding:13px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-base); display:flex; flex-direction:column; gap:8px; }
.cts-mcp-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.cts-mcp-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; background:var(--dsw-alias-label-secondary); }
.cts-mcp-dot.ready { background:#166549; }
.cts-mcp-dot.no_document { background:#a3570e; }
.cts-mcp-dot.disconnected { background:#b42318; }
.cts-mcp-status { font-size:12px; font-weight:600; color:var(--dsw-alias-label-primary); }
.cts-mcp-url { font-size:11px; color:var(--dsw-alias-label-secondary); font-family:var(--cts-font-mono); }
.cts-mcp-doc { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:8px 10px; border-radius:7px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.cts-mcp-pages { max-height:200px; overflow:auto; border:1px solid var(--dsw-alias-border-l1); border-radius:7px; background:var(--dsw-alias-bg-layer-1); padding:6px; display:flex; flex-direction:column; gap:4px; }
.cts-mcp-page { display:flex; align-items:flex-start; gap:8px; padding:6px 8px; border-radius:6px; cursor:pointer; font-size:12px; }
.cts-mcp-page:hover { background:var(--dsw-alias-bg-layer-2); }
.cts-mcp-page-meta { font-size:11px; color:var(--dsw-alias-label-secondary); margin-top:2px; }
.cts-mcp-progress { font-size:11.5px; color:var(--dsw-alias-brand-primary); padding:6px 9px; border-radius:6px; background:var(--dsw-alias-brand-soft); border:1px solid #bcd7d8; }
`;


		function ConfirmDialog({ modal, onClose }) {
			const ref = React.useRef(null);
			const [value, setValue] = React.useState('');
			React.useEffect(() => {
				if (modal) {
					setValue(modal.inputValue ?? '');
					ref.current?.showModal();
				} else if (ref.current?.open) {
					ref.current.close();
				}
			}, [modal]);
			if (!modal) return null;
			const submit = () => {
				const out = modal.inputLabel ? value.trim() : true;
				if (modal.inputLabel && !out) return;
				onClose(out);
			};
			return h('dialog', { ref, className: 'cts-confirm-dialog', onClose: () => onClose(null) },
				h('h3', null, modal.title || '确认操作'),
				modal.message ? h('p', null, modal.message) : null,
				modal.previewLines?.length ? h('div', { className: 'cts-confirm-preview' }, modal.previewLines.join('\n')) : null,
				modal.inputLabel ? h('label', { className: 'cts-field', style: { marginBottom: 10 } },
					h('span', { className: 'cts-field-l' }, modal.inputLabel),
					h('input', { className: 'cts-input cts-input-sm', autoFocus: true, value,
						onChange: (event) => setValue(event.target.value),
						onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } } })) : null,
				h('div', { className: 'cts-filter', style: { justifyContent: 'flex-end', marginTop: 12, marginBottom: 0 } },
					h('button', { className: 'cts-btn', onClick: () => onClose(null) }, modal.cancelText || '取消'),
					h('button', { className: `cts-btn ${modal.danger ? 'danger' : 'primary'}`,
						disabled: Boolean(modal.inputLabel && !value.trim()), onClick: submit }, modal.confirmText || '确认')));
		}

		const EXPORT_TEMPLATE_OPTIONS = [
			['standard', '标准完整模板（21 列）'],
			['zentao', '禅道导入模板'],
			['jira', 'Jira / TestRail 精简模板'],
			['custom', '自定义列映射']
		];
		const parseCustomExportColumns = (text) => String(text || '')
			.split(/[\n,，]+/)
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => {
				const [key, ...rest] = part.split(/[:：]/);
				return { key: key.trim(), label: rest.join(':').trim() };
			})
			.filter((entry) => entry.key);
		const formatCustomExportColumns = (cols) => (Array.isArray(cols) ? cols : [])
			.map((entry) => typeof entry === 'string' ? entry : (entry.label ? `${entry.key}:${entry.label}` : entry.key))
			.join(', ');
		const triggerDownload = (url, filename = '') => {
			if (!url || typeof document === 'undefined') return;
			const a = document.createElement('a');
			a.href = url;
			if (filename) a.download = filename;
			a.style.display = 'none';
			document.body.appendChild(a);
			a.click();
			setTimeout(() => a.remove(), 100);
		};

		function request(action, payload) {
			return fetch('cts/api', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action, ...(payload || {}) })
			}).then(async (response) => {
				const body = await response.json().catch(() => null);
				if (!response.ok || !body) {
					const reason = body?.error || `请求失败 (${response.status})`;
					throw new Error(reason.startsWith('未知操作：') ? 'DSH 后端尚未加载此功能，请完全退出并重新打开 DSH 后重试。' : reason);
				}
				if (!body.ok) throw new Error(body.error || '操作失败');
				return body.state;
			});
		}

		const activityStages = {
			started: '已开始', progress: '进行中', completed: '已完成', partial: '部分完成', failed: '失败',
			tool: '调用工具', tool_completed: '工具完成', tool_failed: '工具失败'
		};
		const activityTools = new Map([
			['project.summary', '读取项目清单'], ['evidence.search', '检索证据'],
			['evidence.read', '读取证据'], ['signal.lookup', '查询信号定义'],
			['design.search', '查找设计节点'], ['design.node', '读取设计节点'],
			['history.search', '查找历史用例']
		]);
		const activityDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
		const activityTime = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
		const agentRoleLabels = { requirements: '三源分析 Agent', design: '测试设计 Agent', quality: '质量审查 Agent', review: '质量审查 Agent', platform: '平台进程' };
		const reviewStageLabels = { facts: '产品事实', features: '功能点', states: '状态', contracts: '需求合同', outline: '测试大纲', points: '测试点', cases: '用例', delivery: '交付' };

		// 从进度详情中提取当前进度（支持 "12/41"、"审查 25-26 / 287"、"65%" 等格式）
		function parseActivityProgress(item) {
			const stage = item.stage || '';
			if (stage === 'completed' || stage === 'tool_completed') return { pct: 100, label: '100%', done: true };
			const text = String(item.detail || '');
			const rangeMatch = /(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)/.exec(text);
			if (rangeMatch) {
				const cur = Number(rangeMatch[2]);
				const tot = Number(rangeMatch[3]);
				if (tot > 0) return { pct: Math.min(100, Math.round((cur / tot) * 100)), label: `${cur}/${tot}`, done: false };
			}
			const fracMatch = /(\d+)\s*\/\s*(\d+)/.exec(text);
			if (fracMatch) {
				const cur = Number(fracMatch[1]);
				const tot = Number(fracMatch[2]);
				if (tot > 0) return { pct: Math.min(100, Math.round((cur / tot) * 100)), label: `${cur}/${tot}`, done: false };
			}
			const pctMatch = /(\d+(?:\.\d+)?)%/.exec(text);
			if (pctMatch) {
				const pct = Math.min(100, Math.round(Number(pctMatch[1])));
				return { pct, label: `${pct}%`, done: false };
			}
			if (stage === 'started' || stage === 'progress' || stage === 'tool') return { pct: null, label: '进行中', done: false };
			return null;
		}

		// 将同一次运行（相同 run）的多条进度/工具日志合并为单条动态卡片，新进度自动覆盖旧进度。
		function groupActivities(rawItems) {
			const byKey = new Map();
			const ordered = [];
			for (const item of rawItems) {
				const key = item.run ? `run:${item.run}` : `id:${item.id}`;
				const existing = byKey.get(key);
				if (!existing) {
					const entry = {
						...item,
						latestAt: item.at,
						startedAt: item.at,
						eventsCount: 1,
						toolCount: item.stage?.startsWith('tool') ? 1 : 0,
						lastTool: item.stage?.startsWith('tool') ? (activityTools.get(item.detail) || item.detail) : ''
					};
					byKey.set(key, entry);
					ordered.push(entry);
				} else {
					existing.eventsCount += 1;
					if (item.at && (!existing.startedAt || item.at < existing.startedAt)) existing.startedAt = item.at;
					if (item.stage?.startsWith('tool')) {
						existing.toolCount += 1;
						if (!existing.lastTool) existing.lastTool = activityTools.get(item.detail) || item.detail;
					}
					// 最新条目若缺 detail（如 completed 无详情），保留最近一条有效进度描述
					if (!existing.detail && item.detail && !item.stage?.startsWith('tool')) existing.detail = item.detail;
				}
			}
			return ordered;
		}

		function formatElapsed(startedAt, latestAt) {
			const ms = new Date(latestAt).getTime() - new Date(startedAt).getTime();
			if (!Number.isFinite(ms) || ms < 1000) return '';
			const sec = Math.round(ms / 1000);
			if (sec < 60) return `${sec}s`;
			return `${Math.floor(sec / 60)}m ${sec % 60}s`;
		}

		function ActivityPanel({ projects, projectId, moduleId, onOpenDesign }) {
			const [open, setOpen] = React.useState(false);
			const [items, setItems] = React.useState([]);
			const [roleFilter, setRoleFilter] = React.useState('all'); // 'all' | 'agent' | 'platform'
			const [next, setNext] = React.useState(null);
			const [ready, setReady] = React.useState(false);
			const [unread, setUnread] = React.useState(false);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState('');
			const head = React.useRef(undefined);
			const cursor = React.useRef(undefined);
			const scopeKeyRef = React.useRef('');
			const trigger = React.useRef(null);
			const panelId = React.useId();
			const scopePayload = projectId && moduleId
				? { project: projectId, module: moduleId }
				: projectId
					? { project: projectId }
					: {};
			const currentScopeKey = `${projectId || ''}:${moduleId || ''}`;
			const currentProjectObj = projects.find((entry) => entry.id === projectId);
			const currentModuleObj = currentProjectObj?.modules?.find((entry) => entry.id === moduleId);
			const activeScopeText = currentModuleObj
				? `${currentModuleObj.name || currentModuleObj.id}`
				: currentProjectObj
					? `${currentProjectObj.name || currentProjectObj.id}`
					: '全部模块';
			const close = () => {
				setOpen(false);
				trigger.current?.focus();
			};

			// 切换项目或模块时立即清空旧模块时间线并重置游标，确保动作记录严格按模块隔离。
			React.useEffect(() => {
				if (scopeKeyRef.current !== currentScopeKey) {
					scopeKeyRef.current = currentScopeKey;
					head.current = undefined;
					cursor.current = undefined;
					setItems([]);
					setNext(null);
					setUnread(false);
					setReady(false);
					setError('');
				}
			}, [currentScopeKey]);

			React.useEffect(() => {
				let alive = true;
				let timer;
				const activeKey = currentScopeKey;
				const refresh = async () => {
					try {
						const page = await request('activity.list', scopePayload);
						if (!alive || scopeKeyRef.current !== activeKey) return;
						const newest = page.items[0]?.id || null;
						if (head.current !== undefined && newest && newest !== head.current && !open) setUnread(true);
						if (newest !== head.current || !ready) {
							const latest = new Set(page.items.map((item) => item.id));
							if (head.current && latest.has(head.current)) {
								setItems((older) => [...page.items, ...older.filter((item) => !latest.has(item.id))]);
							} else {
								setItems(page.items);
								cursor.current = page.next;
								setNext(page.next);
							}
						}
						head.current = newest;
						setError('');
						setReady(true);
					} catch (err) {
						if (alive && scopeKeyRef.current === activeKey) setError(err.message);
					} finally {
						if (alive && scopeKeyRef.current === activeKey) timer = setTimeout(refresh, open ? 2000 : 6000);
					}
				};
				refresh();
				return () => { alive = false; clearTimeout(timer); };
			}, [open, projectId, moduleId]);

			const loadOlder = async () => {
				if (next === null || busy) return;
				const activeKey = currentScopeKey;
				setBusy(true);
				try {
					const page = await request('activity.list', { cursor: next, ...scopePayload });
					if (cursor.current !== next || scopeKeyRef.current !== activeKey) return;
					setItems((current) => {
						const existing = new Set(current.map((item) => item.id));
						return [...current, ...page.items.filter((item) => !existing.has(item.id))];
					});
					cursor.current = page.next;
					setNext(page.next);
					setError('');
				} catch (err) {
					setError(err.message);
				} finally {
					setBusy(false);
				}
			};
			const scopeLabel = (item) => {
				const project = projects.find((entry) => entry.id === item.project);
				const module = project?.modules?.find((entry) => entry.id === item.module);
				return [project?.name || item.project, module?.name || item.module].filter(Boolean).join(' / ');
			};

			const grouped = React.useMemo(() => {
				const merged = groupActivities(items);
				if (roleFilter === 'agent') return merged.filter((item) => item.role && item.role !== 'platform');
				if (roleFilter === 'platform') return merged.filter((item) => !item.role || item.role === 'platform');
				return merged;
			}, [items, roleFilter]);
			const runningCount = grouped.filter((item) => ['started', 'progress', 'tool'].includes(item.stage)).length;

			return h('div', { className: 'cts-activity-entry', onKeyDown: (event) => {
				if (open && event.key === 'Escape') { event.stopPropagation(); close(); }
			} },
				h('button', { type: 'button', ref: trigger, className: `cts-btn cts-activity-toggle${runningCount ? ' running' : ''}`,
					'aria-expanded': open, 'aria-controls': panelId, 'aria-label': unread ? 'Agent 动作记录，有新记录' : 'Agent 动作记录',
					onClick: () => { setOpen(!open); setUnread(false); } },
					h('span', { className: `cts-act-indicator${runningCount ? ' live' : ''}`, 'aria-hidden': true }),
					runningCount ? `运行中 (${runningCount})` : '动作记录',
					unread ? h('span', { className: 'cts-activity-unread', 'aria-hidden': true }) : null),
				h('section', { id: panelId, hidden: !open, className: 'cts-activity-panel', 'aria-label': 'Agent 动作记录' },
					h('header', null,
						h('div', { className: 'cts-act-head-title' },
							h('strong', null, '动作记录'),
							h('span', { className: 'cts-act-scope-tag', title: activeScopeText }, activeScopeText)),
						h('button', { type: 'button', className: 'cts-btn cts-act-close', onClick: close }, '关闭')),
					h('div', { className: 'cts-act-filterbar' },
						[['all', '全部'], ['agent', 'Agent 任务'], ['platform', '平台进程']].map(([key, label]) =>
							h('button', { key, type: 'button', className: `cts-act-chip${roleFilter === key ? ' on' : ''}`,
								onClick: () => setRoleFilter(key) }, label))),
					h('div', { className: 'cts-activity-scroll', tabIndex: 0, 'aria-label': '动作时间线' },
						error ? h('p', { role: 'status', className: 'cts-act-empty' }, error) : null,
						grouped.length ? h('ol', { className: 'cts-activity-list' }, grouped.map((item) => {
							const progress = parseActivityProgress(item);
							const elapsed = formatElapsed(item.startedAt, item.latestAt);
							const isLive = ['started', 'progress', 'tool'].includes(item.stage);
							const isErr = ['failed', 'tool_failed', 'partial'].includes(item.stage);
							const isDone = item.stage === 'completed' || item.stage === 'tool_completed';
							const roleKey = item.role || 'platform';
							const detailText = item.stage?.startsWith('tool') ? activityTools.get(item.detail) || item.detail : item.detail;
							return h('li', { key: item.run || item.id, className: `cts-act-card${isLive ? ' is-live' : ''}${isErr ? ' is-err' : ''}` },
								h('div', { className: 'cts-act-top' },
									h('span', { className: 'cts-act-role', 'data-role': roleKey }, agentRoleLabels[roleKey] || '平台进程'),
									h('time', { className: 'cts-act-time', dateTime: item.latestAt, title: activityDate.format(new Date(item.latestAt)) },
										activityTime.format(new Date(item.latestAt)), elapsed ? ` · ${elapsed}` : '')),
								h('div', { className: 'cts-act-main' },
									h('strong', { className: 'cts-act-action' }, item.action),
									h('span', { className: 'cts-activity-stage', 'data-stage': item.stage }, activityStages[item.stage] || item.stage)),
								detailText ? h('div', { className: 'cts-act-detail' }, detailText) : null,
								progress && (isLive || isDone || isErr) ? h('div', { className: 'cts-act-prog' },
									h('div', { className: 'cts-act-track' },
										h('div', {
											className: `cts-act-fill${progress.pct === null ? ' indeterminate' : ''}${isErr ? ' err' : isDone ? ' done' : ''}`,
											style: progress.pct !== null ? { width: `${progress.pct}%` } : undefined
										})),
									h('span', { className: 'cts-act-pct' }, isErr ? '中断' : progress.label)) : null,
								h('div', { className: 'cts-act-foot' },
									h('span', { className: 'cts-activity-meta' }, [
										reviewStageLabels[item.artifact],
										item.toolCount ? `工具 ${item.toolCount} 次` : '',
										!moduleId ? scopeLabel(item) : ''
									].filter(Boolean).join(' · ')),
									item.artifact === 'design' && projects.some((p) => p.id === item.project && p.modules?.some((m) => m.id === item.module))
										? h('button', { type: 'button', className: 'cts-btn cts-act-jump', onClick: () => { close(); onOpenDesign(item); } }, '打开模块') : null));
						}))
							: !error ? h('p', { role: 'status', className: 'cts-act-empty' }, ready ? `当前模块（${activeScopeText}）暂无动作记录` : '正在读取动作记录…') : null,
						next !== null ? h('button', { type: 'button', className: 'cts-btn cts-act-more', disabled: busy, onClick: loadOlder }, busy ? '正在加载…' : '加载更早记录') : null)));
		}

		/** Turns the POST body of /cts/api/chat into a readable SSE stream. */
		async function streamSse(url, payload, onEvent, signal) {
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
				signal
			});
			if (!response.ok || !response.body) throw new Error(`请求失败 (${response.status})`);
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let index = buffer.indexOf('\n\n');
				while (index !== -1) {
					const block = buffer.slice(0, index);
					buffer = buffer.slice(index + 2);
					let event = 'message';
					let data = '';
					for (const line of block.split('\n')) {
						if (line.startsWith('event:')) event = line.slice(6).trim();
						else if (line.startsWith('data:')) data += line.slice(5).trim();
					}
					if (data !== '') {
						try {
							onEvent(event, JSON.parse(data));
						} catch {
							// A malformed frame must not kill the stream.
						}
					}
					index = buffer.indexOf('\n\n');
				}
			}
		}

		/** Run log → renderable messages, so a refresh rebuilds the same view. */
		function fromEvents(events) {
			const messages = [];
			let current = null;
			for (const event of events) {
				if (event.type === 'user') {
					messages.push({ id: `u-${messages.length}`, role: 'user', text: event.text });
				} else if (event.type === 'run.start') {
					current = { id: `a-${messages.length}`, role: 'agent', text: '', tools: [] };
					messages.push(current);
				} else if (event.type === 'tool.start' && current) {
					current.tools.push({ callId: event.callId, tool: event.tool, input: event.input, summary: '', done: false });
				} else if (event.type === 'tool.end' && current) {
					const card = current.tools.find((item) => item.callId === event.callId);
					if (card) {
						card.summary = event.summary || '';
						card.done = true;
						card.data = event.data;
					}
				} else if (event.type === 'text.delta' && current) {
					current.text += event.text;
				} else if (event.type === 'final' && current) {
					// Authoritative full answer: immune to a lost or reordered delta.
					current.text = event.text;
				}
			}
			return messages;
		}

		const INLINE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/g;

		/** Inline markdown → React nodes. Everything is built as elements, never innerHTML. */
		function inline(text, keyPrefix) {
			const nodes = [];
			let last = 0;
			let index = 0;
			const source = String(text || '');
			for (const match of source.matchAll(INLINE)) {
				if (match.index > last) nodes.push(source.slice(last, match.index));
				const token = match[0];
				const key = `${keyPrefix}-i${index++}`;
				if (token.startsWith('**')) nodes.push(h('strong', { key }, token.slice(2, -2)));
				else if (token.startsWith('`')) nodes.push(h('code', { key, className: 'cts-inline-code' }, token.slice(1, -1)));
				else if (token.startsWith('[')) {
					const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
					nodes.push(h('a', { key, href: link ? link[2] : '#', target: '_blank', rel: 'noreferrer' }, link ? link[1] : token));
				} else nodes.push(h('em', { key }, token.slice(1, -1)));
				last = match.index + token.length;
			}
			if (last < source.length) nodes.push(source.slice(last));
			// Defensive: an unmatched marker must never reach the screen as literal syntax.
			return nodes.map((node) => (typeof node === 'string' ? node.replace(/\*\*/g, '').replace(/(^|[^`])`([^`]|$)/g, '$1$2') : node));
		}

		const START = /^\s*(#{1,6}\s|---+|```|>\s?|[-*+]\s|\d+[.)]\s|\|)/;

		/** Block-level markdown: headings, lists, tables, fences, quotes, paragraphs. */
		function markdown(text) {
			const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
			const blocks = [];
			let i = 0;
			let seq = 0;
			const key = () => `b${seq++}`;

			while (i < lines.length) {
				const line = lines[i];
				if (line.trim() === '') { i += 1; continue; }

				const fence = /^\s*```/.exec(line);
				if (fence) {
					const body = [];
					i += 1;
					while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i += 1; }
					i += 1;
					blocks.push(h('pre', { key: key(), className: 'cts-code' }, h('code', null, body.join('\n'))));
					continue;
				}

				const heading = /^(#{1,6})\s+(.*)$/.exec(line);
				if (heading) {
					const level = Math.min(4, heading[1].length);
					blocks.push(h(`h${level}`, { key: key(), className: `cts-h${level}` }, inline(heading[2], `h${seq}`)));
					i += 1;
					continue;
				}

				if (/^\s*\|/.test(line) && line.split('|').length >= 3) {
					const rows = [];
					while (i < lines.length && /^\s*\|/.test(lines[i]) && lines[i].split('|').length >= 3) {
						const cells = lines[i].trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
						if (cells.length >= 2) rows.push(cells);
						i += 1;
					}
					if (rows.length === 0) continue;
					const isSeparator = (row) => row.every((cell) => /^:?-{2,}:?$/.test(cell));
					const header = rows.length > 1 && isSeparator(rows[1]) ? rows[0] : null;
					const body = header ? rows.slice(2) : rows;
					blocks.push(h('div', { key: key(), className: 'cts-table-wrap' },
						h('table', { className: 'cts-table' },
							header ? h('thead', null, h('tr', null, header.map((cell, index) => h('th', { key: index }, inline(cell, `th${seq}-${index}`))))) : null,
							h('tbody', null, body.map((row, rowIndex) => h('tr', { key: rowIndex }, row.map((cell, cellIndex) => h('td', { key: cellIndex }, inline(cell, `td${seq}-${rowIndex}-${cellIndex}`)))))))));
					continue;
				}

				if (/^\s*[-*+]\s+/.test(line)) {
					const items = [];
					while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
						items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
						i += 1;
					}
					blocks.push(h('ul', { key: key(), className: 'cts-ul' }, items.map((item, index) => h('li', { key: index }, inline(item, `li${seq}-${index}`)))));
					continue;
				}

				if (/^\s*\d+[.)]\s+/.test(line)) {
					const items = [];
					while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
						items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
						i += 1;
					}
					blocks.push(h('ol', { key: key(), className: 'cts-ol' }, items.map((item, index) => h('li', { key: index }, inline(item, `ol${seq}-${index}`)))));
					continue;
				}

				if (/^\s*>\s?/.test(line)) {
					const quote = [];
					while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
						quote.push(lines[i].replace(/^\s*>\s?/, ''));
						i += 1;
					}
					blocks.push(h('blockquote', { key: key(), className: 'cts-quote' }, inline(quote.join(' '), `q${seq}`)));
					continue;
				}

				if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
					blocks.push(h('hr', { key: key(), className: 'cts-hr' }));
					i += 1;
					continue;
				}

				const paragraph = [];
				while (i < lines.length && lines[i].trim() !== '' && !START.test(lines[i])) {
					paragraph.push(lines[i]);
					i += 1;
				}
				if (paragraph.length === 0) { paragraph.push(lines[i]); i += 1; }
				blocks.push(h('p', { key: key(), className: 'cts-p' }, inline(paragraph.join(' '), `p${seq}`)));
			}
			return blocks;
		}

		function Markdown({ text }) {
			return h('div', { className: 'cts-md' }, markdown(text));
		}


		function SkillManager() {
			const [items, setItems] = React.useState(null);
			const [busy, setBusy] = React.useState('');
			const [message, setMessage] = React.useState('');
			const picker = React.useRef(null);
			const target = React.useRef('');
			const titles = {
				'cts-facts': '事实抽取',
				'cts-test-design': '测试点设计',
				'cts-case-authoring': '用例编写',
				'cts-review': '用例审查'
			};
			const owners = {
				'cts-facts': '需求 Agent · 事实、功能、状态和合同',
				'cts-test-design': '测试设计 Agent · 大纲和测试点',
				'cts-case-authoring': '测试设计 Agent · 用例',
				'cts-review': '质量审查 Agent · 合同、大纲、测试点和用例'
			};
			React.useEffect(() => {
				let active = true;
				request('skills.list')
					.then((state) => { if (active) setItems(state.items); })
					.catch((error) => { if (active) setMessage(error.message); });
				return () => { active = false; };
			}, []);
			const update = async (name, file) => {
				setBusy(name);
				setMessage('');
				try {
					if (file && file.size > 100 * 1024) throw new Error('Skill 文件不能超过 100 KB');
					const state = file
						? await request('skills.replace', { name, filename: file.name, content: await file.text() })
						: await request('skills.restore', { name });
					setItems(state.items);
					setMessage(`${titles[name]}已${file ? '替换' : '恢复'}，下次生成或审查时生效。`);
				} catch (error) {
					setMessage(error.message);
				} finally {
					setBusy('');
				}
			};
			return h('div', { className: 'cts-right cts-skill-panel', role: 'region', 'aria-label': 'Skill 内容', tabIndex: 0 },
				h('div', { className: 'cts-h' }, h('b', null, 'Skill 管理')),
				h('p', { className: 'cts-hint' }, '这里的 Skill 供所有项目共用。选择 .md 或 .markdown 文件即可替换对应规则。'),
				h('input', { type: 'file', accept: '.md,.markdown', ref: picker, hidden: true, onChange: (event) => {
					const file = event.target.files?.[0];
					event.target.value = '';
					if (file && target.current) update(target.current, file);
				} }),
				message ? h('p', { role: 'status' }, message) : !items ? h('p', { role: 'status' }, '正在读取 Skill…') : null,
				h('div', { className: 'cts-list' }, (items || []).map((item) =>
					h('div', { className: 'cts-item', key: item.name },
						h('div', { className: 'cts-item-t' }, h('strong', null, titles[item.name] || item.name)),
						h('div', { className: 'cts-item-m' }, owners[item.name]),
						h('div', { className: 'cts-item-m' }, `${item.name} · ${item.updatedAt ? item.filename + ' · ' + new Date(item.updatedAt).toLocaleString() : '内置版本'}`),
						h('div', { className: 'cts-filter' },
							h('button', { className: 'cts-btn', disabled: Boolean(busy), 'aria-label': '上传替换 ' + titles[item.name],
								onClick: () => { target.current = item.name; picker.current?.click(); } }, busy === item.name ? '正在保存…' : '上传替换'),
							item.canRestore ? h('button', { className: 'cts-btn', disabled: Boolean(busy), onClick: () => update(item.name) }, '恢复上一版') : null),
						h('details', null,
							h('summary', null, '查看当前内容'),
							h('pre', { className: 'cts-evidence-text' }, item.content))))));
		}

		function AssetsView({ projectId, assets, modules, moduleId, onBuild, building, onUpload, moduleEvidence, onPreviewEvidence, onProbeMcp, onRenderAll, onImportLibrary, onRenderNode, onAuthorizePixso, onCopyAuthorizeUrl, authorizeUrl, authorizeNote, mcpNote, onDesignState, designBusy, sourceScope, onOpenCenter, designActivity }) {
			const [newName, setNewName] = React.useState('');
			const [newProject, setNewProject] = React.useState('');
			const [addPath, setAddPath] = React.useState('');
			const [tab, setTab] = React.useState(assets?.length ? 'design' : 'prd');
			React.useEffect(() => { if (designActivity) setTab('design'); }, [designActivity?.id]);
			const [scopeOpen, setScopeOpen] = React.useState(false);
			const scopeDialog = React.useRef(null);
			React.useEffect(() => {
				if (scopeOpen) scopeDialog.current?.showModal();
			}, [scopeOpen]);
			const [page, setPage] = React.useState('');
			const [query, setQuery] = React.useState('');
			const [expanded, setExpanded] = React.useState({ design: true, lib: true });
			const [sources, setSources] = React.useState([]);
			const [removedSources, setRemovedSources] = React.useState([]);
			const [sourceChange, setSourceChange] = React.useState(0);
			const [sourceBusy, setSourceBusy] = React.useState(false);
			const [openSources, setOpenSources] = React.useState({});
			const [openPages, setOpenPages] = React.useState({});
			const [children, setChildren] = React.useState({});
			const [sel, setSel] = React.useState(null);
			const [info, setInfo] = React.useState(null);
			const [images, setImages] = React.useState({});
			const [notice, setNotice] = React.useState('');
			const [busy, setBusy] = React.useState(false);
			const [previewJob, setPreviewJob] = React.useState(null);
			const [previewError, setPreviewError] = React.useState('');
			const [previewRefresh, setPreviewRefresh] = React.useState(0);
			const [uploading, setUploading] = React.useState(false);
			const compiledJob = previewJob?.indexChanged ? previewJob.id : '';
			const previewId = sel?.layer?.id || sel?.id;
			const selectedSource = sources.find((source) => source.id === sel?.source);
			const sourceRevision = selectedSource?.revision || '';
			const previewKey = [sel?.source, sourceRevision, previewId].join('::');
			const imagePath = previewId ? images[previewKey] || '' : '';
			const uploadMany = async (dir, files) => {
				const list = [...(files || [])].filter(Boolean);
				if (list.length === 0) return;
				setUploading(true);
				setNotice('');
				try {
					for (const file of list) await onUpload(dir, file);
				} catch (error) {
					setNotice(error.message);
				} finally {
					setUploading(false);
					if (dir === 'design' && list.some((file) => /\.pix$/i.test(file.name))) setPreviewRefresh((value) => value + 1);
				}
			};
			const layer = sel?.layer;
			const unit = sel?.node;
			const hasLayerBounds = layer?.width > 0 && layer.height > 0;
			const previewRef = React.useRef(null);
			const [previewWidth, setPreviewWidth] = React.useState(0);

			React.useEffect(() => {
				const preview = previewRef.current;
				if (!preview) return;
				const observer = new ResizeObserver(([entry]) => setPreviewWidth(entry.contentRect.width));
				observer.observe(preview);
				return () => observer.disconnect();
			}, [imagePath, hasLayerBounds]);

			React.useEffect(() => {
				let active = true;
				let timer;
				const refresh = () => request('design.previewStatus', { project: projectId, module: moduleId }).then((state) => {
					if (!active) return;
					setPreviewJob(state);
					if (state?.running) timer = setTimeout(refresh, 1500);
				}).catch(() => {
					if (active && previewJob?.running) timer = setTimeout(refresh, 1500);
				});
				refresh();
				return () => { active = false; clearTimeout(timer); };
			}, [projectId, moduleId, previewRefresh, previewJob?.running]);

			React.useEffect(() => {
				let active = true;
				request('design.layerPages', { project: projectId, module: moduleId }).then((state) => {
					if (!active) return;
					setSources(state.sources || []);
					setRemovedSources(state.removed || []);
					if (compiledJob) {
						setChildren({});
						setOpenPages({});
						setSel(null);
						setInfo(null);
						request('design.state', { project: projectId }).then((design) => { if (active) onDesignState(design); }).catch(() => {});
					}
					const open = {};
					for (const group of state.sources || []) open[group.id] = true;
					setOpenSources(open);
				}).catch(() => {});
				return () => { active = false; };
			}, [projectId, moduleId, compiledJob, sourceChange]);

			const changeDesignVisibility = async (source, restore = false) => {
				if (!restore && !window.confirm(`从项目删除「${source.name}」及其本地预览截图？设计稿可恢复，预览截图需重新缓存。`)) return;
				setSourceBusy(true);
				setNotice('');
				try {
					const design = await request('design.sourceVisibility', { project: projectId, source: source.id, restore });
					if (!restore && sel?.source === source.id) {
						setSel(null);
						setInfo(null);
					}
					if (!restore) setImages((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !key.startsWith(source.id + '::'))));
					onDesignState(design);
					setPreviewJob(null);
					setSourceChange((value) => value + 1);
				} catch (error) {
					setNotice(error.message);
				} finally {
					setSourceBusy(false);
				}
			};

			const TABS = [['prd', 'PRD'], ['design', 'UI 设计'], ['signals', '信号矩阵'], ['other', '其他'], ['skills', 'Skill 管理']];
			const fileAssets = assets.filter((item) => item.dir === tab);

			const loadChildren = (source, id) => {
				const key = source + '::' + id;
				if (children[key]) return;
				request('design.layerChildren', { project: projectId, module: moduleId, parent: id, source })
					.then((state) => setChildren((prev) => ({ ...prev, [key]: state.children || [] })))
					.catch(() => {});
			};

			const selectNode = (source, node, layer = null) => {
				setSel({ source, node, layer, id: node.id, name: node.name });
				setInfo(null);
			};

			React.useEffect(() => {
				if (!sel) return;
				let active = true;
				request('design.nodeInfo', { project: projectId, module: moduleId, id: sel.id, source: sel.source })
					.then((state) => { if (active) setInfo(state); })
					.catch(() => {});
				return () => { active = false; };
			}, [projectId, moduleId, sel]);

			React.useEffect(() => {
				setPreviewError('');
				if (!previewId || imagePath) {
					setBusy(false);
					return;
				}
				let active = true;
				setBusy(true);
				request('design.renderNodes', { project: projectId, module: moduleId, source: sel.source, nodes: [previewId], cacheOnly: Boolean(previewJob?.running) })
					.then((state) => {
						if (!active) return;
						const file = state.rendered?.[previewId];
						if (file) setImages((prev) => ({ ...prev, [previewKey]: file }));
						else setPreviewError(state.failed?.[previewId] || '');
					})
					.catch(() => {})
					.finally(() => { if (active) setBusy(false); });
				return () => { active = false; };
			}, [projectId, previewKey, imagePath, previewJob?.running, previewJob?.running ? previewJob.done : 0]);

			const toggleNode = (source, child) => {
				const key = source + '::' + child.id;
				const next = !openPages[key];
				setOpenPages((prev) => ({ ...prev, [key]: next }));
				if (next) loadChildren(source, child.id);
			};

			const renderChild = (source, child, depth, layer = child) => {
				const key = source + '::' + child.id;
				const kids = children[key];
				const open = openPages[key];
				return h('div', { key },
					h('div', {
						className: `pk-leaf${sel && sel.id === child.id && sel.source === source ? ' on' : ''}`,
						style: { paddingLeft: 4 + depth * 10 },
						onClick: () => { selectNode(source, child, layer); if (child.hasChildren) toggleNode(source, child); }
					},
						h('span', { className: 'pk-caret' }, child.hasChildren ? (open ? '▾' : '▸') : ' '),
						h('span', { className: 'pk-ico' }, { FRAME: '▣', GROUP: '▾', TEXT: 'T', RECTANGLE: '▭', VECTOR: '◇', INSTANCE: '◈', SYMBOL: '◆', MASK: '▨' }[child.type] || '·'),
						h('span', { className: 'pk-label' }, child.name || `(${String(child.type).toLowerCase()})`),
						h('span', { className: 'pk-size' }, `${Math.round(child.width)}×${Math.round(child.height)}`)),
					open && kids ? h('div', null, kids.map((item) => renderChild(source, item, depth + 1, layer))) : null);
			};

			const designTree = sources.map((group) => {
				const open = openSources[group.id];
				const pageNodes = (group.pages || []).map((entry) => {
					const key = group.id + '::' + entry.id;
					const isOpen = openPages[key];
					const kids = children[key];
					return h('div', { key },
						h('div', {
							className: `pk-leaf${sel && sel.id === entry.id && sel.source === group.id ? ' on' : ''}`,
							onClick: () => {
								selectNode(group.id, entry);
								const next = !isOpen;
								setOpenPages((prev) => ({ ...prev, [key]: next }));
								if (next) loadChildren(group.id, entry.id);
							}
						},
							h('span', { className: 'pk-caret' }, isOpen ? '▾' : '▸'),
							h('span', { className: 'pk-ico' }, '▤'),
							h('span', { className: 'pk-label' }, entry.name),
							h('span', { className: 'pk-count' }, entry.count)),
						isOpen && kids ? h('div', { className: 'pk-children' }, kids.map((child) => renderChild(group.id, child, 0))) : null);
				});
				return h('div', { key: group.id },
					h('div', { className: 'pk-leaf', onClick: () => setOpenSources((prev) => ({ ...prev, [group.id]: !open })) },
						h('span', { className: 'pk-caret' }, open ? '▾' : '▸'),
						h('span', { className: 'pk-ico' }, '🎨'),
						h('span', { className: 'pk-label', title: group.file }, group.name),
						h('span', { className: 'pk-count' }, (group.pages || []).length),
						h('button', {
							className: 'cts-btn', title: `删除 ${group.name}`, disabled: sourceBusy || previewJob?.running,
							onClick: (event) => { event.stopPropagation(); void changeDesignVisibility(group); }
						}, '删除')),
					open ? h('div', { className: 'pk-children' }, ...pageNodes) : null);
			});

			const fileList = fileAssets.map((item) => h('div', { className: 'pk-leaf', key: item.path, title: item.path },
				h('span', { className: 'pk-caret' }, ' '), h('span', { className: 'pk-ico' }, '📄'),
				h('span', { className: 'pk-label' }, item.name), h('span', { className: 'pk-size' }, `${Math.round(item.bytes / 1024)} KB`)));

			const left = h('div', { className: 'pk-side' },
				h('div', { className: 'pk-search' }, h('input', { className: 'cts-input cts-input-sm', value: query, placeholder: '搜索', onChange: (event) => setQuery(event.target.value) })),
				tab === 'design'
					? h('div', null,
						h('div', { className: 'pk-node', onClick: () => setExpanded((prev) => ({ ...prev, design: !prev.design })) },
							h('span', { className: 'pk-caret' }, expanded.design ? '▾' : '▸'), h('span', { className: 'pk-ico' }, '🎨'),
							h('span', { className: 'pk-label' }, '设计稿'), h('span', { className: 'pk-count' }, sources.length)),
						expanded.design ? h('div', { className: 'pk-children' }, designTree) : null,
						removedSources.length ? h('details', null,
							h('summary', { className: 'pk-leaf' }, `已删除设计稿（${removedSources.length}）`),
							removedSources.map((source) => h('div', { className: 'pk-leaf', key: source.id },
								h('span', { className: 'pk-label' }, source.name),
								h('button', { className: 'cts-btn', disabled: sourceBusy || previewJob?.running, onClick: () => changeDesignVisibility(source, true) }, '恢复')))) : null)
					: h('div', { className: 'pk-children' }, fileList),
				tab === 'design' ? h('div', { className: 'pk-tools' },
					h('button', { className: 'cts-btn', onClick: onProbeMcp }, '检测 MCP'),
					h('button', { className: 'cts-btn', disabled: uploading || previewJob?.running || designBusy, onClick: async () => {
						setNotice('');
						try { setPreviewJob(await request('design.importCurrent', { project: projectId, module: moduleId })); }
						catch (error) { setNotice(error.message); }
					} }, '导入 Pixso 当前设计稿'),
					h('button', { className: 'cts-btn', onClick: onImportLibrary }, '导入组件库'),
					h('button', { className: 'cts-btn', disabled: previewJob?.running || designBusy, onClick: async () => {
						try { setPreviewJob(await request('design.cachePreviews', { project: projectId, module: moduleId })); }
						catch (error) { setNotice(error.message); }
					} }, '缓存或补齐截图'),
					mcpNote ? h('div', { className: 'pk-note' }, mcpNote) : null) : null);

			const showSelection = hasLayerBounds && unit.id !== layer.id &&
				[unit.x, unit.y, layer.x, layer.y].every(Number.isFinite);
			let labelStyle;
			let zoomBox;
			let zoomStyle;
			if (showSelection) {
				const left = 100 * (unit.x - layer.x) / layer.width;
				const right = 100 * (unit.x + Math.max(1, unit.width) - layer.x) / layer.width;
				const top = 100 * (unit.y - layer.y) / layer.height;
				const bottom = 100 * (unit.y + Math.max(1, unit.height) - layer.y) / layer.height;
				if (right > 0 && left < 100 && bottom > 0 && top < 100) {
					labelStyle = {
						top: `clamp(4px, ${top}%, calc(100% - 24px))`,
						...(right < 50 ? { left: `calc(${right}% + 6px)` } :
							left > 50 ? { right: `calc(${100 - left}% + 6px)` } : { left: '6px' })
					};
					if (previewWidth > 0 && Math.max(unit.width, unit.height) / layer.width * previewWidth < 28) {
						const size = Math.min(layer.width, layer.height, Math.max(24, unit.width * 2.5, unit.height * 2.5));
						const x = Math.max(layer.x, Math.min(unit.x + (unit.width - size) / 2, layer.x + layer.width - size));
						const y = Math.max(layer.y, Math.min(unit.y + (unit.height - size) / 2, layer.y + layer.height - size));
						zoomBox = `${x} ${y} ${size} ${size}`;
						zoomStyle = left < 50 ? { right: 8 } : { left: 8 };
					}
				}
			}
			const imageUrl = `/cts/file?path=${encodeURIComponent(`${projectId}/${imagePath}`)}`;
			const image = imagePath ? h('img', {
				src: imageUrl,
				alt: layer?.name || sel.name || previewId
			}) : null;
			const outline = showSelection ? h('rect', {
				x: unit.x, y: unit.y, width: Math.max(1, unit.width), height: Math.max(1, unit.height),
				fill: 'rgba(64,158,255,0.22)', stroke: '#0068ec', strokeWidth: 3, vectorEffect: 'non-scaling-stroke'
			}) : null;
			const preview = image && hasLayerBounds
				? h('div', { ref: previewRef, className: 'pk-layer-image', style: { width: `min(100%, ${layer.width}px, ${70 * layer.width / layer.height}vh)` } },
					image,
					showSelection
						? h('svg', {
							className: 'pk-layer-selection', 'aria-hidden': true,
							viewBox: `${layer.x} ${layer.y} ${layer.width} ${layer.height}`, preserveAspectRatio: 'none'
						}, outline) : null,
					labelStyle ? h('span', { className: 'pk-layer-label', style: labelStyle, 'aria-hidden': true }, unit.name || unit.type) : null,
					zoomBox ? h('svg', { className: 'pk-layer-zoom', style: zoomStyle, viewBox: zoomBox, role: 'img', 'aria-label': `局部放大：${unit.name || unit.type}` },
						h('image', { href: imageUrl, x: layer.x, y: layer.y, width: layer.width, height: layer.height, preserveAspectRatio: 'none' }),
						outline) : null)
				: image;

			const fields = info ? [
				['名称', info.name || '(未命名)'],
				['设计稿', selectedSource?.name || ''],
				['类型', info.type || info.kind],
				['路径', info.path || ''],
				['位置', info.x !== undefined ? `${Math.round(info.x)}, ${Math.round(info.y)}` : ''],
				['尺寸', info.w !== undefined ? `${Math.round(info.w)} × ${Math.round(info.h)}` : (info.width ? `${info.width} × ${info.height}` : '')],
				['子节点', info.children !== undefined ? String(info.children) : ''],
				['文本', info.text || ''],
				['字体', info.fontSize ? `${info.fontFamily || ''} ${Math.round(info.fontSize)}px`.trim() : ''],
				['guid', info.id || info.nodeId || '']
			].filter((row) => row[1] !== '') : [];

			const right = h('div', { className: 'pk-main' },
				h('div', { className: 'pk-toolbar', onDragOver: (event) => event.preventDefault(), onDrop: (event) => { event.preventDefault(); void uploadMany(tab, event.dataTransfer?.files); } },
					h('div', { className: 'cts-modes' }, TABS.map(([value, label]) => h('button', {
						key: value,
						className: `cts-mode${tab === value ? ' on' : ''}`,
						onClick: () => { setTab(value); setSel(null); setInfo(null); }
					}, label))),
					tab !== 'skills' ? h('span', { className: 'pk-stat' }, sel ? (sel.name || sel.id) : '未选择') : null,
					notice ? h('span', { className: 'pk-notice' }, notice) : null,
					tab !== 'skills' ? h('div', { className: 'pk-actions' },
						h('label', { className: 'cts-btn', style: { cursor: 'pointer', margin: 0 } }, uploading ? '上传中…' : '上传（可多选/拖入）',
							h('input', {
								type: 'file', multiple: true, style: { display: 'none' },
								disabled: uploading || (tab === 'design' && previewJob?.running),
								onChange: async (event) => {
									const files = [...(event.target.files || [])];
									event.target.value = '';
									await uploadMany(tab, files);
								}
							})),
						h('button', { className: 'cts-btn', onClick: onBuild, disabled: building }, building ? '构建中…' : '重建证据')) : null,
					h('button', { className: 'cts-btn', 'aria-haspopup': 'dialog', onClick: () => setScopeOpen(true) }, '资料范围'),
					onOpenCenter ? h('button', { className: 'cts-btn', onClick: onOpenCenter }, '资产中心') : null),
				tab === 'design' && previewJob ? h('div', { className: 'cts-pkg', role: 'status' },
					previewJob.running
						? (previewJob.phase === 'compile' ? '正在解析设计稿…' : previewJob.phase === 'connect' ? '正在核对 Pixso 设计稿…' :
							previewJob.phase === 'import' ? `正在读取 ${previewJob.source} · 页面 ${previewJob.pagesDone}/${previewJob.pagesTotal}` :
							`正在缓存截图 ${previewJob.done}/${previewJob.total}，失败 ${previewJob.failed} · ${previewJob.layer || ''}`) + ' 请保持 Pixso 客户端、MCP 和对应设计稿打开。'
						: previewJob.error ? `${previewJob.compiled ? '设计稿已解析。' : '解析失败。'}已缓存 ${previewJob.done} 张。 ${previewJob.error}`
							: `已缓存 ${previewJob.done}/${previewJob.total} 张${previewJob.failed ? `，${previewJob.failed} 张可重试（${previewJob.lastFailure}）` : '，可离线查看'}`) : null,
				tab === 'skills' ? h(SkillManager) : info || sel
					? h('div', { className: 'pk-inspector' },
						h('div', { className: 'pk-preview' },
							preview || h('div', { className: 'cts-hint' }, previewJob?.running ? '该图层的截图正在准备…' : busy ? '加载中…' : previewError || '没有截图，请在 Pixso 打开对应设计稿后补图')),
						h('div', { className: 'pk-props' },
							h('div', { className: 'pk-sec' }, '属性'),
							h('div', { className: 'pk-attrs' }, fields.map(([label, value]) => h('div', { className: 'pk-attr', key: label },
								h('span', { className: 'pk-attr-k' }, label), h('span', { className: 'pk-attr-v' }, String(value)))))))
					: h('div', { className: 'cts-hint' }, '左侧选一个组件或图层'));

			return h('div', { className: 'pk-body' }, left, right, scopeOpen ? h('dialog', {
				ref: scopeDialog, className: 'cts-source-scope', onClose: () => setScopeOpen(false), 'aria-label': '模块资料范围与来源版本'
			}, h('button', { className: 'cts-btn', onClick: () => scopeDialog.current?.close() }, '关闭'),
				h(SourceScope, { projectId, moduleId, ...sourceScope })) : null);
		}

		function ComponentDetail({ detail, busy, selected, onSelect, imagePath, projectId }) {
			if (busy) return h('div', { className: 'pk-detail' }, h('div', { className: 'cts-hint' }, '读取中…'));
			if (!detail) return h('div', { className: 'pk-detail' }, h('div', { className: 'cts-hint' }, '没有数据'));
			const nodes = detail.nodes || [];
			const current = nodes.find((item) => item.id === selected) || nodes[0] || null;
			const [zoom, setZoom] = React.useState(1);
			const viewW = Math.max(1, detail.w) * zoom;
			const viewH = Math.max(1, detail.h) * zoom;

			const rows = current ? [
				['名称', current.name || '(未命名)'],
				['类型', current.type],
				['路径', current.path],
				['位置', `${Math.round(current.x)}, ${Math.round(current.y)}`],
				['尺寸', `${Math.round(current.w)} × ${Math.round(current.h)}`],
				['同级', current.siblingIndex ? `${current.siblingIndex} / ${current.siblingCount}` : '—'],
				['文案', current.text || '—'],
				['字体', current.fontSize ? `${current.fontFamily || ''} ${current.fontSize}px`.trim() : '—'],
				['guid', current.id]
			] : [];

			return h('div', { className: 'pk-detail' },
				h('div', { className: 'pk-detail-left' },
					h('div', { className: 'pk-sec' }, `图层 · ${nodes.length}`),
					h('div', { className: 'pk-scroll' }, nodes.map((node) => h('div', {
						key: node.id,
						className: `pk-leaf${current && current.id === node.id ? ' on' : ''}`,
						style: { paddingLeft: 4 + node.depth * 10 },
						onClick: () => onSelect(node.id)
					},
						h('span', { className: 'pk-ico' }, { FRAME: '▣', GROUP: '▾', TEXT: 'T', RECTANGLE: '▭', VECTOR: '◇', SYMBOL: '◆', INSTANCE: '◈' }[node.type] || '·'),
						h('span', { className: 'pk-label' }, node.text || node.name || `(${String(node.type).toLowerCase()})`),
						h('span', { className: 'pk-size' }, `${Math.round(node.w)}×${Math.round(node.h)}`))))),
				h('div', { className: 'pk-detail-right' },
					h('div', { className: 'pk-canvas-bar' },
						h('span', { className: 'pk-sec', style: { margin: 0 } }, `${detail.name} · ${detail.w} × ${detail.h}`),
						h('span', { className: `pk-badge ${detail.engine === 'mcp' ? 'mcp' : 'local'}` }, detail.engine === 'mcp' ? 'MCP' : '本地索引'),
						h('div', { className: 'pk-zoom' }, [0.5, 1, 2].map((value) => h('button', {
							key: value,
							className: `cts-btn${zoom === value ? ' primary' : ''}`,
							onClick: () => setZoom(value)
						}, `${Math.round(value * 100)}%`)))),
					imagePath
						? h('div', { className: 'pk-canvas-scroll' },
							h('div', { className: 'pk-canvas', style: { width: viewW, height: viewH } },
								h('img', { src: `/cts/file?path=${encodeURIComponent(`${projectId}/${imagePath}`)}`, className: 'pk-canvas-img', width: viewW }),
								h('svg', { className: 'pk-overlay', viewBox: `0 0 ${detail.w} ${detail.h}`, width: viewW, height: viewH },
									nodes.map((node) => h('rect', {
										key: node.id,
										x: node.x,
										y: node.y,
										width: Math.max(0.5, node.w),
										height: Math.max(0.5, node.h),
										fill: current && current.id === node.id ? 'rgba(64,158,255,0.18)' : 'transparent',
										stroke: current && current.id === node.id ? '#409eff' : 'transparent',
										strokeWidth: 1.2,
										onClick: () => onSelect(node.id),
										style: { cursor: 'pointer' }
									})))))
						: h('div', { className: 'cts-hint' }, '没有截图')),
				h('div', { className: 'pk-detail-bottom' },
					h('div', { className: 'pk-attr-grid' }, rows.map(([label, value]) => h('div', { className: 'pk-attr', key: label },
						h('span', { className: 'pk-attr-k' }, label),
						h('span', { className: 'pk-attr-v' }, String(value)))))));
		}

		function ModelBranch({ title, meta, children, onToggle }) {
			return h('details', { className: 'cts-model-node', onToggle },
				h('summary', null, title, meta ? h('span', { className: 'cts-item-m' }, meta) : null),
				h('div', { className: 'cts-model-children' }, children));
		}

		function UnassignedModelFact({ fact, model, projectId, readOnly, onRepair, onImpact, onStartContract }) {
			const [opened, setOpened] = React.useState(false);
			const issue = { kind: 'fact', category: 'unassigned', ref: fact.fact_id, item: fact, impact: fact.impact,
				message: '这条事实已从资料中抽取，但目前没有任何功能点引用它。核对原文后，可选择所属功能点。' };
			return h(ModelBranch, { title: `${fact.fact_id} · ${fact.statement}`, meta: fact.type,
				onToggle: (event) => { if (event.target === event.currentTarget && event.currentTarget.open) setOpened(true); } },
				opened ? h(ModelIssueDetail, { issue, model, projectId, readOnly, onRepair, onImpact, onStartContract }) : null);
		}

		function ModelFact({ fact }) {
			return h(ModelBranch, { title: `${fact.fact_id} · ${fact.statement}`, meta: fact.type },
				h('div', { className: 'cts-model-leaf' },
					(fact.evidence_refs || []).length ? '来源 · ' + fact.evidence_refs.join('、') : '暂无来源编号'),
				fact.impact ? h('div', { className: 'cts-model-leaf' }, `影响 ${fact.impact.points} 个测试点 / ${fact.impact.cases} 条用例`) : null);
		}

		function ModelFeature({ feature, issueCount }) {
			const { facts = [], states = [], transitions = [], issues = [] } = feature;
			const stateNames = new Map(states.map((item) => [item.state_id, item.name]));
			return h(ModelBranch, { title: h('strong', null, feature.name || feature.feature_id), meta: [feature.name ? feature.feature_id : '', issueCount ? issueCount + ' 项问题' : ''].filter(Boolean).join(' · ') },
				feature.summary ? h('div', { className: 'cts-model-leaf' }, feature.summary) : null,
				h(ModelBranch, { title: '事实', meta: String(facts.length) },
					facts.length ? facts.map((fact) => h(ModelFact, { key: fact.fact_id, fact })) : h('div', { className: 'cts-model-leaf' }, '暂无事实')),
				h(ModelBranch, { title: '状态', meta: String(states.length) },
					states.length ? states.map((item) => h(ModelBranch, { key: item.state_id, title: item.name, meta: item.state_id },
						h('div', { className: 'cts-model-leaf' }, item.entry ? '进入 · ' + item.entry : '暂无进入条件'),
						item.exit ? h('div', { className: 'cts-model-leaf' }, '退出 · ' + item.exit) : null)) : h('div', { className: 'cts-model-leaf' }, '暂无状态')),
				h(ModelBranch, { title: '状态转移', meta: String(transitions.length) },
					transitions.length ? transitions.map((item) => h(ModelBranch, {
						key: item.transition_id,
						title: `${stateNames.get(item.from) || item.from} → ${stateNames.get(item.to) || item.to}`,
						meta: item.transition_id
					},
						h('div', { className: 'cts-model-leaf' }, '触发 · ' + item.trigger),
						item.conditions?.length ? h('div', { className: 'cts-model-leaf' }, '条件 · ' + item.conditions.join('、')) : null,
						item.actions?.length ? h('div', { className: 'cts-model-leaf' }, '动作 · ' + item.actions.join('、')) : null)) : h('div', { className: 'cts-model-leaf' }, '暂无状态转移')),
				issues.length ? h(ModelBranch, { title: '模型问题', meta: String(issues.length) },
					issues.map((issue, index) => h('div', { key: index, className: 'cts-model-leaf' }, issue.message || issue.code))) : null,
				feature.impact ? h('div', { className: 'cts-model-leaf cts-item-m' }, `影响 ${feature.impact.points} 个测试点 / ${feature.impact.cases} 条用例`) : null);
		}

		const modelIssueLabels = { structure: '结构问题', evidence: '证据待核对', binding: '绑定待确认', coverage: '覆盖缺口', unassigned: '事实未归类' };
		const modelLines = (value) => value.split(/\n+/).map((line) => line.trim()).filter(Boolean);

		function ModelIssueDetail({ issue, model, projectId, readOnly, onRepair, onConfirm, onManual, onImpact, onStartContract }) {
			const feature = (model.features || []).find((item) => item.feature_id === issue.featureId);
			const item = issue.item || {};
			const transition = item.transition_id;
			const [draft, setDraft] = React.useState({
				statement: item.statement || '', refs: (item.evidence_refs || []).join(' '),
				feature_id: issue.featureId || '', from: item.from || '', to: item.to || '',
				trigger: item.trigger || '', conditions: (item.conditions || []).join('\n'), actions: (item.actions || []).join('\n'), name: ''
			});
			const [entries, setEntries] = React.useState({});
			const [busy, setBusy] = React.useState(false);
			const [message, setMessage] = React.useState('');
			const field = (key, label, options) => h('label', { className: 'cts-field' }, h('span', null, label),
				options ? h('select', { className: 'cts-select', value: draft[key], onChange: (event) => setDraft({ ...draft, [key]: event.target.value }) },
					h('option', { value: '' }, '请选择'), options.map(([value, name]) => h('option', { key: value, value }, name)))
					: h('textarea', { className: 'cts-input cts-input-sm', rows: 2, value: draft[key], onChange: (event) => setDraft({ ...draft, [key]: event.target.value }) }));
			const read = async (id) => {
				try {
					const evidence = await request('evidence.read', { project: projectId, id });
					setEntries((old) => ({ ...old, [id]: evidence }));
				} catch (err) { setMessage(err.message); }
			};
			const repair = async (kind, patch, id = issue.ref) => {
				setBusy(true);
				setMessage('');
				try { await onRepair({ kind, id, feature_id: issue.featureId, rejected_index: item.rejected_index, patch }); setMessage('已保存并重新检查'); }
				catch (err) { setMessage(err.message); }
				finally { setBusy(false); }
			};
			const evidenceRefs = issue.kind === 'fact' ? item.evidence_refs || []
				: [...new Set((feature?.facts || []).filter((fact) => !transition || (item.evidence_refs || []).includes(fact.fact_id)).flatMap((fact) => fact.evidence_refs || []))];
			const states = (feature?.states || []).map((state) => [state.state_id, state.name]);
			return h('div', { className: 'cts-model-detail' },
				h('strong', null, [issue.featureName, issue.ref].filter(Boolean).join(' / ')),
				h('div', null, issue.message),
				item.statement ? h('div', { className: 'cts-evidence-text' }, item.statement) : null,
				transition ? h('div', null, '触发 · ' + item.trigger) : null,
				h('div', { className: 'cts-filter' }, evidenceRefs.map((id) =>
					h('button', { key: id, className: 'cts-btn', onClick: () => read(id) }, '查看 ' + id))),
				h('div', { className: 'cts-model-evidence' }, Object.entries(entries).map(([id, evidence]) => h('div', { key: id, className: 'cts-item' },
					h('div', { className: 'cts-item-m' }, [id, evidence.source, evidence.location].filter(Boolean).join(' · ')),
					h('pre', { className: 'cts-evidence-text' }, evidence.text)))),
				issue.impact ? h('div', { className: 'cts-item-m' }, `关联 ${issue.impact.points} 个测试点 / ${issue.impact.cases} 条用例`) : null,
				!readOnly && (issue.kind === 'fact' || transition) ? h('button', { className: 'cts-btn', onClick: () => onImpact(transition ? 'transition_id' : 'fact_id', issue.ref) }, '查看关联测试点和用例') : null,
				readOnly ? h('div', { className: 'cts-hint' }, '冻结版只读，原文来自当前证据库。')
					: issue.kind === 'fact' ? h(React.Fragment, null,
						h('button', { className: 'cts-btn', onClick: () => onStartContract({ fact_refs: [item.fact_id], feature_id: issue.featureId || '' }) }, '整理为合同'),
						field('statement', '事实内容'), field('refs', '来源证据编号'),
						field('feature_id', '所属功能点', (model.features || []).map((entry) => [entry.feature_id, [entry.name, entry.feature_id].filter(Boolean).join(' · ')])),
						h('button', { className: 'cts-btn primary', disabled: busy || (issue.category === 'unassigned' && !draft.feature_id), onClick: () => repair('fact', { statement: draft.statement, evidence_refs: draft.refs.split(/[\s,，、]+/).filter(Boolean), feature_id: draft.feature_id }) }, issue.category === 'unassigned' ? '归入功能点' : '保存事实'))
					: issue.kind === 'binding' ? h(BindingRow, { item, onConfirm, onManual, busy })
					: issue.kind === 'feature' ? h('button', { className: 'cts-btn', disabled: busy, onClick: () => repair('feature', {}) }, '移除失效引用')
					: issue.kind === 'state' ? h(React.Fragment, null,
						issue.category === 'structure' && !transition ? h(React.Fragment, null,
							field('name', '新增状态名称'),
							h('button', { className: 'cts-btn', disabled: busy || !draft.name.trim(), onClick: () => repair('state', { name: draft.name }) }, '添加状态')) : null,
						states.length && issue.category !== 'coverage' ? h(React.Fragment, null,
							field('from', '起点', states), field('to', '终点', states), field('trigger', '触发条件'),
							field('conditions', '前置条件（每行一条）'), field('actions', '动作（每行一条）'),
							h('button', { className: 'cts-btn primary', disabled: busy, onClick: () => repair('transition',
								{ ...draft, conditions: modelLines(draft.conditions), actions: modelLines(draft.actions) }, transition || '') }, transition ? '保存状态转移' : '新增状态转移')) : null) : null,
				message ? h('div', { role: 'status' }, message) : null);
		}

		function ContractEditor({ item, model, projectId, readOnly, onSave }) {
			const [draft, setDraft] = React.useState(item);
			const [editing, setEditing] = React.useState(!item.contract_id);
			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState('');
			const [source, setSource] = React.useState(null);
			const [factQuery, setFactQuery] = React.useState('');
			const fields = [['title', '合同名称'], ['trigger', '触发动作'], ['condition', '前置条件'], ['expected', '可观察预期']];
			const allFacts = model.inputs?.facts?.items || [];
			const feature = (model.features || []).find((entry) => entry.feature_id === draft.feature_id);
			const featureFacts = feature?.facts || [];
			const transitions = feature?.transitions || [];
			const chosen = allFacts.filter((fact) => draft.fact_refs.includes(fact.fact_id));
			const query = factQuery.trim().toLowerCase();
			const candidates = (query ? allFacts.filter((fact) => `${fact.fact_id} ${fact.statement}`.toLowerCase().includes(query)) : featureFacts)
				.filter((fact) => !draft.fact_refs.includes(fact.fact_id)).slice(0, 20);
			const refs = new Set(chosen.flatMap((fact) => fact.evidence_refs || []));
			const bindings = (model.inputs?.bindings?.items || []).filter((binding) =>
				(binding.subject?.fact_ids || []).some((id) => draft.fact_refs.includes(id)));
			const read = async (id) => {
				setNotice('正在读取原文…');
				setSource(null);
				try { setSource(await request('evidence.read', { project: projectId, id })); setNotice(''); }
				catch (err) { setNotice(err.message); }
			};
			const save = async (approve) => {
				setBusy(true);
				setNotice('');
				try {
					const result = await onSave({ id: item.contract_id, patch: draft, approve });
					setDraft(result);
					setEditing(false);
					setNotice(approve ? '合同已确认。冻结产品模型后可用于生成测试点。' : '草稿已保存。');
				} catch (err) { setNotice(err.message); }
				finally { setBusy(false); }
			};
			return h('section', { className: 'cts-model-issues cts-contract-editor', 'aria-label': '合同详情' },
				h('h3', { style: { margin: 0 } }, item.title || '新建需求合同'),
				item.contract_id ? h('div', { className: 'cts-item-m' }, [feature?.name, contractStatus[item.status], item.contract_id].filter(Boolean).join(' · ')) : null,
				!editing || readOnly ? h('dl', { className: 'cts-contract-scenario' },
					[['condition', '前置条件'], ['trigger', '触发动作'], ['expected', '可观察预期']].map(([key, label]) =>
						h('div', { key }, h('dt', null, label), h('dd', null, item[key] || '待补充'))),
					item.transition_ref ? h('div', null, h('dt', null, '状态转移'), h('dd', null, item.transition_ref)) : null)
				: h(React.Fragment, null, h('label', { className: 'cts-field' }, '所属功能点',
					h('select', { className: 'cts-select', disabled: readOnly || busy, value: draft.feature_id,
						onChange: (event) => setDraft({ ...draft, feature_id: event.target.value, transition_ref: '' }) },
						h('option', { value: '' }, '选择功能点'),
						(model.features || []).map((feature) => h('option', { key: feature.feature_id, value: feature.feature_id }, `${feature.name || ''} · ${feature.feature_id}`)))),
				transitions.length || draft.transition_ref ? h('label', { className: 'cts-field' }, '状态转移（可选）',
					h('select', { className: 'cts-select', disabled: readOnly || busy, value: draft.transition_ref || '',
						onChange: (event) => setDraft({ ...draft, transition_ref: event.target.value }) },
						h('option', { value: '' }, '未关联状态转移'),
						draft.transition_ref && !transitions.some((entry) => entry.transition_id === draft.transition_ref)
							? h('option', { value: draft.transition_ref }, `${draft.transition_ref} · 已失效`) : null,
						transitions.map((entry) => h('option', { key: entry.transition_id, value: entry.transition_id }, `${entry.trigger} · ${entry.transition_id}`)))) : null,
				fields.map(([key, label]) => h('label', { key, className: 'cts-field' }, label,
					key === 'title' ? h('input', { className: 'cts-input cts-input-sm', value: draft[key], readOnly, disabled: busy, onChange: (event) => setDraft({ ...draft, [key]: event.target.value }) })
						: h('textarea', { className: 'cts-input cts-input-sm', rows: 2, value: draft[key], readOnly, disabled: busy, onChange: (event) => setDraft({ ...draft, [key]: event.target.value }) })))),
				editing && !readOnly ? h('details', null, h('summary', null, '判定方式、联动与恢复'),
					[['verification', '判定方式'], ['interactions', '联动与仲裁'], ['recovery', '退出与恢复']].map(([key, label]) =>
						h('label', { key, className: 'cts-field' }, label, h('textarea', { className: 'cts-input', value: draft[key] || '',
							onChange: (event) => setDraft({ ...draft, [key]: event.target.value }) }))),
					h('div', { className: 'cts-filter' }, Object.entries(testMethodLabels).map(([id, title]) =>
						h('label', { key: id }, h('input', { type: 'checkbox', checked: (draft.rule_ids || []).includes(id), onChange: (event) =>
							setDraft({ ...draft, rule_ids: event.target.checked ? [...(draft.rule_ids || []), id] : draft.rule_ids.filter((entry) => entry !== id) }) }), title))))
					: [['verification', '判定方式'], ['interactions', '联动与仲裁'], ['recovery', '退出与恢复']].map(([key, label]) =>
						item[key] ? h('div', { key }, h('strong', null, label), h('div', null, item[key])) : null),
				h('strong', null, '来源事实与原文'),
				chosen.length ? chosen.map((fact) => h('div', { className: 'cts-item', key: fact.fact_id },
					h('div', null, `${fact.fact_id} · ${fact.statement}`),
					h('div', { className: 'cts-filter' },
						(fact.evidence_refs || []).map((id) => h('button', { key: id, className: 'cts-btn', onClick: () => read(id) }, '查看 ' + id)),
						editing && !readOnly ? h('button', { className: 'cts-btn', disabled: busy, onClick: () => setDraft({ ...draft, fact_refs: draft.fact_refs.filter((id) => id !== fact.fact_id) }) }, '移除此引用') : null)))
					: h('div', { className: 'cts-hint' }, '尚未关联事实。'),
				draft.fact_refs.filter((id) => !chosen.some((fact) => fact.fact_id === id)).map((id) => h('div', { key: id },
					id + ' · 事实已失效 ', editing && !readOnly ? h('button', { className: 'cts-btn', onClick: () => setDraft({ ...draft, fact_refs: draft.fact_refs.filter((ref) => ref !== id) }) }, '移除失效引用') : null)),
				source ? h('div', { className: 'cts-item' },
					h('div', { className: 'cts-item-m' }, [source.source, source.location, source.source_version, source.historical ? '历史证据' : ''].filter(Boolean).join(' · ')),
					h('pre', { className: 'cts-evidence-text' }, source.text)) : null,
				editing && !readOnly ? h('details', { className: 'cts-model-node' }, h('summary', null, '添加来源事实'),
					h('input', { type: 'search', className: 'cts-input cts-input-sm', value: factQuery, 'aria-label': '搜索来源事实', placeholder: '按事实编号或正文搜索', onChange: (event) => setFactQuery(event.target.value) }),
					h('div', { className: 'cts-model-issue-list' }, candidates.map((fact) =>
						h('button', { className: 'cts-btn cts-model-issue', key: fact.fact_id, disabled: busy, onClick: () => setDraft({ ...draft, fact_refs: [...draft.fact_refs, fact.fact_id] }) }, `${fact.fact_id} · ${fact.statement}`)))) : null,
				h('strong', null, '关联控件与信号'),
				bindings.length ? bindings.map((binding) => h('div', { key: binding.binding_id, className: 'cts-item-m' },
					[binding.kind === 'signal' ? '信号' : '控件', binding.subject?.name, binding.status === 'bound' ? binding.target?.name || '已绑定' : '待核对绑定', binding.target?.message_id || binding.target?.node_id].filter(Boolean).join(' · ')))
					: h('div', { className: 'cts-hint' }, '所选事实暂无控件或信号绑定。'),
				!readOnly ? h('div', { className: 'cts-filter' },
					editing ? h('button', { className: 'cts-btn', disabled: busy || !draft.title.trim() || !draft.feature_id, onClick: () => save(false) }, '保存草稿')
						: h('button', { className: 'cts-btn', disabled: busy, onClick: () => { setDraft(item); setEditing(true); } }, '编辑合同'),
					editing && item.contract_id ? h('button', { className: 'cts-btn', disabled: busy, onClick: () => { setDraft(item); setEditing(false); } }, '取消编辑') : null,
					editing || item.status !== 'approved' ? h('button', { className: 'cts-btn primary', disabled: busy || !refs.size || !draft.feature_id || fields.some(([key]) => !draft[key].trim()), onClick: () => save(true) }, '确认合同') : null) : null,
				notice ? h('div', { role: 'status' }, notice) : null);
		}

		const contractStatus = { draft: '待确认', approved: '已确认', stale: '来源变化，待复核' };

		function ContractView({ model, projectId, readOnly, onSave, seed, target, onApproveAll }) {
			const contracts = model.inputs?.contracts?.items || [];
			const [bulkBusy, setBulkBusy] = React.useState(false);
			const [bulkNotice, setBulkNotice] = React.useState('');
			const [selected, setSelected] = React.useState(seed ? 'seed' : target || contracts.find((item) => item.status !== 'approved')?.contract_id || contracts[0]?.contract_id || '');
			const [filter, setFilter] = React.useState('');
			const [search, setSearch] = React.useState('');
			const query = search.trim().toLowerCase();
			const shown = selected || contracts.find((item) => item.status !== 'approved')?.contract_id || contracts[0]?.contract_id;
			const current = shown === 'new' || shown === 'seed' ? { feature_id: '', fact_refs: [], title: '', trigger: '', condition: '', expected: '', ...(selected === 'seed' ? seed : null) }
				: contracts.find((item) => item.contract_id === shown);
			const groups = new Map((model.features || []).map((feature) => [feature.feature_id, { name: feature.name, items: [] }]));
			for (const item of contracts) {
				if (filter && item.status !== filter) continue;
				const name = groups.get(item.feature_id)?.name || '';
				if (query && !`${item.contract_id} ${item.title} ${name} ${item.trigger} ${item.expected}`.toLowerCase().includes(query)) continue;
				if (!groups.has(item.feature_id)) groups.set(item.feature_id, { name: '功能点待核对', items: [] });
				groups.get(item.feature_id).items.push(item);
			}
			return h('div', { className: 'cts-model-workbench cts-contract-workbench' },
				h('section', { className: 'cts-model-issues', 'aria-label': '需求合同列表' },
					h('div', { className: 'cts-filter' },
						h('strong', null, `需求合同 · ${contracts.length} 条 / ${contracts.filter((item) => item.status === 'approved').length} 条已确认`),
						!readOnly ? h('button', { className: 'cts-btn', disabled: bulkBusy,
							onClick: async () => {
								setBulkBusy(true); setBulkNotice('');
								try {
									const result = await onApproveAll();
									const blocked = (result.blocked || []).slice(0, 2).map((entry) => `${entry.title || entry.id}: ${entry.error}`).join('；');
									setBulkNotice(`批量确认：${result.approved?.length || 0} 条通过${result.blocked?.length ? `，${result.blocked.length} 条未通过（${blocked}${result.blocked.length > 2 ? ' 等' : ''}）` : ''}`);
								} catch (error) { setBulkNotice(error.message); }
								finally { setBulkBusy(false); }
							} }, bulkBusy ? '确认中…' : '确认全部完整合同') : null,
						!readOnly ? h('button', { className: 'cts-btn primary', onClick: () => setSelected('new') }, '新建合同') : null),
					bulkNotice ? h('div', { className: 'cts-hint' }, bulkNotice) : null,
					h('div', { className: 'cts-filter' },
						h('input', { type: 'search', className: 'cts-input cts-input-sm', 'aria-label': '搜索需求合同', value: search, placeholder: '搜索功能、合同或预期', onChange: (event) => setSearch(event.target.value) }),
						h('select', { className: 'cts-select', 'aria-label': '合同评审状态', value: filter, onChange: (event) => setFilter(event.target.value) },
							h('option', { value: '' }, '全部状态'), Object.entries(contractStatus).map(([key, label]) => h('option', { key, value: key }, label)))),
					contracts.length ? h('div', { className: 'cts-contract-list' },
						[...groups.entries()].filter(([, group]) => group.items.length).map(([id, group]) => h('section', { key: id },
						h('h3', null, group.name || id),
						h('div', { className: 'cts-list' }, group.items.map((item) => h('button', {
							key: item.contract_id, className: 'cts-btn cts-model-issue', 'aria-pressed': item.contract_id === shown,
							onClick: () => setSelected(item.contract_id)
						}, h('strong', null, item.title), h('div', { className: 'cts-item-m' }, contractStatus[item.status]),
						(() => {
							const missing = item.missing_fields?.length ? item.missing_fields
								: [!item.trigger && '触发动作', !item.condition && '前置条件', !item.expected && '可观察预期'].filter(Boolean);
							return missing.length ? h('div', { className: 'cts-lint' }, `缺字段：${missing.join('、')}`) : null;
						})(),
						item.expected ? h('div', { className: 'cts-item-s' }, item.expected.slice(0, 110)) : null))))))
						: h('p', { className: 'cts-hint' }, readOnly ? '此冻结版本没有需求合同。' : model.stats?.facts
							? `暂无需求合同。已有 ${model.stats.facts} 条事实，可在「模型树与问题」中选择一条并点「整理为合同」。`
							: '暂无需求合同。构建证据并生成事实后，可引用原文整理合同。')),
				current ? h(ContractEditor, { key: shown, item: current, model, projectId, readOnly,
					onSave: async (payload) => { const result = await onSave(payload); setSelected(result.contract_id); return result; } }) : null);
		}

		function EcsmView({ state, section, setSection, contractTarget, generate, genBusy, onExport, onReload, onLoadVersion, projectId, moduleId, locked, onJump, onRepair, onConfirm, onManual, onImpact, onSaveContract, onApproveContracts }) {
			const [draftFeatures, setDraftFeatures] = React.useState([]);
			const [contractSeed, setContractSeed] = React.useState(null);
			const startContract = (seed) => { setContractSeed(seed); setSection('contracts'); };
			React.useEffect(() => { if (section === 'tree') setContractSeed(null); }, [section]);
			const [query, setQuery] = React.useState('');
			const [category, setCategory] = React.useState('');
			const [selected, setSelected] = React.useState('');
			const [problemsOnly, setProblemsOnly] = React.useState(false);
			const [snapshot, setSnapshot] = React.useState(null);
			const [loading, setLoading] = React.useState(false);
			const choose = async (value) => {
				setContractSeed(null);
				if (!value) { setSnapshot(null); return; }
				setLoading(true);
				try { setSnapshot(await onLoadVersion(Number(value))); }
				finally { setLoading(false); }
			};
			if (!state || !state.model) return h('div', { className: 'cts-right' }, h('div', { className: 'cts-hint' }, '正在读取 ECSM…'));
			const model = snapshot || state.model;
			const issues = (snapshot ? snapshot.issues : state.issues) || [];
			const counts = new Map();
			for (const issue of issues) if (issue.featureId) counts.set(issue.featureId, (counts.get(issue.featureId) || 0) + 1);
			const listed = issues.filter((issue) => !category || category === issue.category);
			const active = listed.find((issue) => issue.id === selected) || (selected ? listed[0] : null);
			const comparable = (item) => {
				if (!item) return '';
				const { impact, facts, issues: checks, ...feature } = item;
				return JSON.stringify({ ...feature, facts: facts?.map(({ impact, ...fact }) => fact) });
			};
			const [before, after] = [snapshot?.features || [], state.model.features || []];
			const beforeById = new Map(before.map((item) => [item.feature_id, item]));
			const afterIds = new Set(after.map((item) => item.feature_id));
			const changes = snapshot ? [
				...after.filter((item) => comparable(item) !== comparable(beforeById.get(item.feature_id)))
					.map((item) => (beforeById.has(item.feature_id) ? '已修改 · ' : '已新增 · ') + (item.name || item.feature_id)),
				...before.filter((item) => !afterIds.has(item.feature_id)).map((item) => '已移除 · ' + (item.name || item.feature_id))
			] : [];
			const stats = model.stats || {};
			const current = state.current;
			const search = query.trim().toLowerCase();
			const matches = (...values) => !search || values.some((value) => String(value || '').toLowerCase().includes(search));
			const features = (model.features || []).filter((feature) => matches(feature.feature_id, feature.name, feature.summary) && (!problemsOnly || counts.has(feature.feature_id)));
			const unassigned = (model.unassigned_facts || []).filter((fact) => matches(fact.fact_id, fact.statement));
			const bindings = (model.inputs?.bindings?.items || []).filter((item) => matches(item.binding_id, item.subject?.name, item.target?.name) && (!problemsOnly || issues.some((issue) => issue.kind === 'binding' && issue.ref === item.binding_id)));
			return h('div', { className: 'cts-right cts-model-shell' },
				h('details', { className: 'cts-model-tools', open: snapshot ? true : undefined },
					h('summary', null, snapshot ? `正在查看历史模型 v${snapshot.version}` : '模型版本与导出'),
					h('div', { className: 'cts-cov' }, `功能点 ${stats.features} · 事实 ${stats.facts} · 状态 ${stats.states} · 转移 ${stats.transitions}`),
					h('div', { className: 'cts-cov' }, current ? `已冻结 v${current.version}${state.drifted ? ' · 工作模型有改动' : ''}` : '尚未冻结版本'),
					h('div', { className: 'cts-actions' },
					h('select', { className: 'cts-select', disabled: loading, 'aria-label': '查看模型版本', value: snapshot?.version || '', onChange: (event) => choose(event.target.value) },
						h('option', { value: '' }, '当前工作模型'),
						(state.versions || []).map((item) => h('option', { key: item.version, value: item.version }, `冻结版 v${item.version}`))),
					h('button', { className: 'cts-btn', onClick: () => onExport(Boolean(snapshot), snapshot?.version) }, snapshot ? `导出冻结版 v${snapshot.version}` : '导出草稿 JSON'),
					h('button', { className: 'cts-btn', onClick: onReload }, '刷新'))),
				snapshot ? h(ModelBranch, { title: '与当前工作模型对比', meta: changes.length + ' 项功能点变化' },
					changes.length ? changes.map((line) => h('div', { className: 'cts-model-leaf', key: line }, line)) : h('div', { className: 'cts-model-leaf' }, '功能点内容一致')) : null,
				section === 'contracts' && !snapshot ? h('details', { className: 'cts-model-tools' },
					h('summary', null, '按功能生成合同草稿'),
					h('div', { className: 'cts-filter' }, (model.features || []).map((feature) => h('label', { key: feature.feature_id },
						h('input', { type: 'checkbox', checked: draftFeatures.includes(feature.feature_id), onChange: (event) =>
							setDraftFeatures(event.target.checked ? [...draftFeatures, feature.feature_id] : draftFeatures.filter((id) => id !== feature.feature_id)) }), feature.name))),
					h('button', { className: 'cts-btn', disabled: Boolean(genBusy) || !draftFeatures.length, onClick: () => generate('contracts', undefined, draftFeatures) },
						`为 ${draftFeatures.length} 项功能生成草稿`)) : null,
				section === 'contracts' && !snapshot ? h(AgentReviewPanel, { projectId, moduleId, stage: 'contracts', locked,
					revision: model.digest, onSaved: onReload, onLocate: (id) => onJump('contracts', id),
					objects: (model.inputs?.contracts?.items || []).map((item) => ({ id: item.contract_id, title: item.title })) }) : null,
				section === 'contracts' ? h(ContractView, { key: snapshot?.version || contractTarget || 'working', model, projectId, readOnly: Boolean(snapshot), target: snapshot ? '' : contractTarget, seed: contractSeed, onSave: onSaveContract, onApproveAll: onApproveContracts })
				: h('div', { className: 'cts-model-workbench' },
				h('section', { 'aria-label': '模型浏览' },
				h('div', { className: 'cts-filter' },
					h('input', { className: 'cts-input cts-input-sm', type: 'search', value: query, 'aria-label': '搜索模型树',
						placeholder: '搜索功能名称、编号或绑定', onChange: (event) => setQuery(event.target.value) }),
					h('label', null, h('input', { type: 'checkbox', checked: problemsOnly, onChange: (event) => setProblemsOnly(event.target.checked) }), ' 只看有问题')),

				h('div', { className: 'cts-model-tree', key: snapshot?.version || 'working', 'aria-label': 'ECSM 模型树' },
					features.map((feature) => h(ModelFeature, { key: feature.feature_id, feature, issueCount: counts.get(feature.feature_id) })),
					unassigned.length ? h(ModelBranch, { title: '未归类事实', meta: String(unassigned.length) },
						h('p', { className: 'cts-model-leaf' }, '以下是已抽取、尚未归入任何功能点的需求事实。展开一条可以核对原文并处理归属。'),
						unassigned.map((fact) => h(UnassignedModelFact, { key: fact.fact_id, fact, model, projectId,
							readOnly: Boolean(snapshot), onRepair, onImpact, onStartContract: startContract }))) : null,
					bindings.length ? h(ModelBranch, { title: '控件与信号绑定', meta: String(bindings.length) },
						bindings.map((item) => h(ModelBranch, {
							key: item.binding_id,
							title: item.subject?.name || item.binding_id,
							meta: `${item.kind === 'signal' ? '信号' : '控件'} · ${({ bound: '已绑定', ambiguous: '待确认', unmatched: '未匹配', rejected: '已拒绝' })[item.status] || item.status || '待确认'}`
						}, h('div', { className: 'cts-model-leaf' },
							[item.binding_id, item.target?.name, item.target?.message, item.target?.message_id, item.target?.node_id].filter(Boolean).join(' · '))))) : null,
					!features.length && !unassigned.length && !bindings.length
						? h('p', { className: 'cts-hint' }, search ? '没有匹配的模型条目。' : '暂无匹配的模型内容。') : null)),
				h('section', { className: 'cts-model-issues', 'aria-label': '待处理问题' },
					h('strong', null, '待处理问题 · ' + issues.length),
					h('div', { className: 'cts-filter' },
						h('select', { className: 'cts-select', 'aria-label': '问题类别', value: category, onChange: (event) => { setCategory(event.target.value); setSelected(''); } },
							h('option', { value: '' }, '全部问题'),
							Object.entries(modelIssueLabels).map(([key, label]) => h('option', { value: key, key }, `${label}（${issues.filter((issue) => issue.category === key).length}）`))),
						active ? h('button', { className: 'cts-btn', disabled: listed.length < 2, onClick: () => setSelected(listed[(listed.indexOf(active) + 1) % listed.length].id) }, '下一条问题') : null),
					listed.length ? h('div', { className: 'cts-model-issue-list' }, listed.map((issue) =>
						h('button', { className: 'cts-btn cts-model-issue', key: issue.id, 'aria-pressed': issue.id === active?.id, onClick: () => setSelected(issue.id) },
							h('div', { className: 'cts-item-m' }, [modelIssueLabels[issue.category], issue.featureName, issue.ref].filter(Boolean).join(' · ')),
							h('div', null, issue.category === 'unassigned' ? issue.item.statement : issue.message)))) : h('p', { className: 'cts-hint' }, '这一类暂无问题。'),
					active ? h(ModelIssueDetail, { key: active.id + ':' + (snapshot?.version || 'working'), issue: active, model, projectId,
						readOnly: Boolean(snapshot), onRepair, onConfirm, onManual, onImpact, onStartContract: startContract }) : null)));
		}

		function QuestionRow({ question, onAnswer, onDismiss }) {
			const [draft, setDraft] = React.useState('');
			const answerField = React.useRef(null);
			if (question.status === 'dismissed') return h('div', { className: 'cts-item cts-item-m' }, '已忽略 · ' + question.question);
			if (question.status === 'answered') {
				return h('div', { className: 'cts-item' },
					h('div', { className: 'cts-item-t' }, `${question.id} ${question.question}`),
					h('div', { className: 'cts-item-m' }, `${question.applied ? '已更新事实' : '已回答'} · ${question.answer || '（空）'}`));
			}
			return h('div', { className: 'cts-item' },
				h('div', { className: 'cts-item-t' }, `${question.id} ${question.question}`),
				h('div', { className: 'cts-item-m' }, `${question.kind}${question.ref ? ' · ' + question.ref : ''}`),
				(question.options || []).length > 0
					? h('div', { className: 'cts-actions' }, question.options.map((option) => h('button', {
						key: option,
						className: 'cts-btn',
						onClick: () => /^(我补充|我填)/.test(option) ? answerField.current?.focus() : onAnswer(question.id, option)
					}, option)))
					: null,
				h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
					h('input', {
						className: 'cts-input cts-input-sm',
						style: { flex: '1 1 auto', minWidth: 0 },
						placeholder: '或输入答案', ref: answerField,
						value: draft,
						onChange: (event) => setDraft(event.target.value),
						onKeyDown: (event) => {
							if (event.key === 'Enter' && draft.trim() !== '') onAnswer(question.id, draft.trim());
						}
					}),
					h('button', { className: 'cts-btn', disabled: draft.trim() === '', onClick: () => onAnswer(question.id, draft.trim()) }, '提交'),
					question.kind === 'fact' ? h('button', { className: 'cts-btn', disabled: !draft.trim(), onClick: () => onAnswer(question.id, draft.trim(), true) }, '更新事实') : null,
					h('button', { className: 'cts-btn', onClick: () => onDismiss(question.id) }, '忽略')));
		}

		function GateCard({ gate, onAnswer }) {
			const [draft, setDraft] = React.useState('');
			if (gate.answered) {
				return h('div', { className: 'cts-gate done' },
					h('div', { className: 'cts-gate-q' }, gate.question),
					h('div', { className: 'cts-gate-a' }, `已回答：${gate.answer || ''}`));
			}
			return h('div', { className: 'cts-gate' },
				h('div', { className: 'cts-gate-tag' }, '需要你确认'),
				h('div', { className: 'cts-gate-q' }, gate.question),
				(gate.options || []).length > 0
					? h('div', { className: 'cts-actions' }, gate.options.map((option) => h('button', {
						key: option,
						className: 'cts-btn',
						onClick: () => onAnswer(gate.gateId, option)
					}, option)))
					: null,
				h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
					h('input', {
						className: 'cts-input cts-input-sm',
						style: { flex: '1 1 auto', minWidth: 0 },
						placeholder: '或直接输入答案',
						value: draft,
						onChange: (event) => setDraft(event.target.value),
						onKeyDown: (event) => {
							if (event.key === 'Enter' && draft.trim() !== '') onAnswer(gate.gateId, draft.trim());
						}
					}),
					h('button', {
						className: 'cts-btn primary',
						disabled: draft.trim() === '',
						onClick: () => onAnswer(gate.gateId, draft.trim())
					}, '发送')));
		}

		function ToolCard({ card }) {
			const [open, setOpen] = React.useState(false);
			return h('div', { className: 'cts-tool' },
				h('div', { className: 'cts-tool-head', onClick: () => setOpen(!open) },
					h('span', null, card.done ? '⚙' : '◌'),
					h('span', { className: 'cts-tool-name' }, card.tool),
					h('span', { className: 'cts-tool-sum' }, card.done ? card.summary : '运行中…')
				),
				open ? h('div', { className: 'cts-tool-body' },
					JSON.stringify(card.data ?? card.input ?? {}, null, 2)) : null
			);
		}

		const FIELDS = {
			features: [
				['name', '功能点名称', 'text'],
				['summary', '说明', 'textarea'],
				['fact_refs', '事实编号', 'list']
			],
			facts: [
				['type', '类型', 'select', ['feature', 'state', 'control', 'signal', 'rule', 'criterion']],
				['statement', '事实', 'textarea'],
				['evidence_refs', '证据编号', 'list']
			],
			points: [
				['requirement', '功能', 'text'],
				['condition', '条件', 'textarea'],
				['action', '动作', 'textarea'],
				['expected', '预期', 'textarea'],
				['fact_refs', '来源事实编号', 'list'],
				['transition_ref', '状态转移编号', 'text'],
				['priority', '优先级', 'select', ['P0', 'P1', 'P2', 'P3']],
				['type', '类型', 'text']
			],
			cases: [
				['title', '标题', 'text'],
				['priority', '优先级', 'select', ['P0', 'P1', 'P2', 'P3']],
				['precondition', '前置条件', 'textarea'],
				['steps', '测试步骤', 'lines'],
				['expected', '预期结果', 'textarea'],
				['signals', '待验证信号', 'list'],
				['basis', '依据', 'textarea'],
				['prepare_detail', '准备', 'textarea'],
				['verification', '判定方式', 'textarea'],
				['failure_policy', '失败处理', 'textarea'],
				['restore_steps', '恢复步骤', 'lines']
			]
		};

		function toDraft(kind, item) {
			const draft = {};
			for (const [key, , type] of FIELDS[kind]) {
				const value = item[key];
				if (type === 'list') draft[key] = Array.isArray(value) ? value.join(', ') : String(value || '');
				else if (type === 'lines') draft[key] = Array.isArray(value) ? value.join('\n') : String(value || '');
				else draft[key] = value === undefined || value === null ? '' : String(value);
			}
			return draft;
		}

		function toPatch(kind, draft) {
			const patch = {};
			for (const [key, , type] of FIELDS[kind]) {
				if (type === 'list') patch[key] = String(draft[key] || '').split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
				else if (type === 'lines') patch[key] = String(draft[key] || '').split('\n').map((item) => item.trim()).filter(Boolean);
				else patch[key] = draft[key];
			}
			return patch;
		}

		function CaseImages({ item, projectId, moduleId, onImages, busy, gaps = [], activeAnchor, onSelectStep }) {
			const [node, setNode] = React.useState('');
			const [role, setRole] = React.useState('操作定位');
			const [step, setStep] = React.useState('');
			const [zoom, setZoom] = React.useState(null);
			const [query, setQuery] = React.useState('');
			const [hits, setHits] = React.useState([]);
			const [notice, setNotice] = React.useState('');
			const [searching, setSearching] = React.useState(false);
			const dialog = React.useRef(null);
			const picker = React.useRef(null);
			const stepRefs = React.useRef({});
			const figures = item.image_refs || [];
			const stepItems = (item.step_items || []).length === (item.steps || []).length ? item.step_items : [];
			const expectedItems = item.expected_items || [];
			React.useEffect(() => {
				const targetStep = activeAnchor?.observeStep || activeAnchor?.triggerStep;
				if (targetStep && stepRefs.current[targetStep]) {
					stepRefs.current[targetStep].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
				}
			}, [activeAnchor]);
			const locate = (figure) => {
				if (figure.step_id && stepItems.length) {
					const at = stepItems.findIndex((entry) => entry.id === figure.step_id);
					return at >= 0 ? { step: at + 1, mapped: true } : { step: 0, mapped: false, reason: '步骤已变化' };
				}
				if (figure.expected_id && expectedItems.length) {
					const entry = expectedItems.find((expected) => expected.id === figure.expected_id);
					const at = Number(entry?.step_index || 0);
					if (entry && !at) return { step: 0, mapped: true };
					if (entry && at <= (item.steps || []).length) return { step: at, mapped: true };
					return { step: 0, mapped: false, reason: '预期已变化' };
				}
				const legacy = Number(figure.step || 0);
				if (!legacy) return { step: 0, mapped: true };
				return legacy <= (item.steps || []).length ? { step: legacy, mapped: true } : { step: 0, mapped: false, reason: '步骤已变化' };
			};
			React.useEffect(() => { if (zoom) dialog.current?.showModal(); }, [zoom]);
			const search = async () => {
				setSearching(true);
				setNotice('');
				try {
					const result = await request('design.search', { project: projectId, module: moduleId, query: query.trim(), limit: 10 });
					setHits(result.results || []);
					if (!result.results?.length) setNotice('没有匹配节点，请换个名称搜索。');
				} catch (err) { setHits([]); setNotice(err.message); }
				finally { setSearching(false); }
			};
			const renderFigure = (figure, flag = '') => {
				const src = `/cts/file?path=${encodeURIComponent(`${projectId}/${figure.file}`)}`;
				const label = `${flag}${figure.role} · ${figure.name}`;
				return h('div', { className: 'cts-item', key: `${figure.file}:${figure.step_id || figure.expected_id || figure.step}:${figure.role}` },
					h('div', { className: 'cts-item-t' }, label),
					h('button', { className: 'cts-btn', type: 'button', 'aria-label': '放大 ' + label, onClick: () => setZoom({ src, label }) },
						h('img', { className: 'cts-figure', src, alt: label, loading: 'lazy' })),
					h('button', { className: 'cts-btn', disabled: busy, onClick: () => onImages(item.case_id, { remove: { file: figure.file, step: figure.step, step_id: figure.step_id, expected_id: figure.expected_id, role: figure.role } }) }, '移除配图'));
			};
			const interfaceFigures = figures.filter((f) => f.role !== '信号参考');
			const signals = figures.filter((f) => f.role === '信号参考');
			const located = interfaceFigures.map((figure) => ({ figure, ...locate(figure) }));
			const unmapped = located.filter((entry) => !entry.mapped);
			const selectGap = (gap) => {
				setStep(gap.step ? String(gap.step) : '');
				setRole(gap.role);
				picker.current?.focus();
			};
			const evidenceBlock = (number, title, expected) => {
				const images = located.filter((entry) => entry.mapped && entry.step === number).map((entry) => entry.figure);
				const missing = gaps.filter((gap) => gap.step === number);
				const isObserveHit = number > 0 && activeAnchor?.observeStep === number;
				const isTriggerHit = number > 0 && !isObserveHit && activeAnchor?.triggerStep === number;
				const cls = `cts-step-evidence${isObserveHit ? ' anchor-hit' : isTriggerHit ? ' anchor-trigger' : ''}`;
				return h('section', {
					className: cls,
					key: number,
					ref: (el) => { if (number > 0) stepRefs.current[number] = el; },
					onClick: number > 0 && onSelectStep ? () => onSelectStep(number) : undefined,
					style: number > 0 && onSelectStep ? { cursor: 'pointer' } : undefined
				},
					h('strong', null, title),
					isObserveHit ? h('span', { className: 'cts-pill info', style: { marginLeft: 8 } }, '对应观察步') : null,
					isTriggerHit ? h('span', { className: 'cts-pill ok', style: { marginLeft: 8 } }, '对应触发步') : null,
					expected ? h('p', null, '预期 · ' + expected) : null,
					images.map((figure) => renderFigure(figure)),
					missing.map((gap) => h('button', { key: gap.role, className: 'cts-btn', onClick: () => selectGap(gap) }, `待补界面图 · ${gap.role}`)));
			};
			return h('div', { className: 'cts-list' },
				h('h3', null, '步骤与证据'),
				(item.steps || []).map((line, index) => evidenceBlock(index + 1, `步骤 ${index + 1} · ${line.replace(/^S\d+[.、)]\s*/, '')}`, String(item.expected || '').split('\n').filter((text) => Number(text.match(/^S(\d+)[-.]/)?.[1]) === index + 1).map((text) => text.replace(/^S\d+(?:-\d+)?\.\s*/, '')).join('；'))),
				located.some((entry) => entry.mapped && !entry.step) || gaps.some((gap) => !gap.step) || item.expected && !/^S\d+[.-]/m.test(item.expected) ? evidenceBlock(0, '预期界面与全局参考', item.expected) : null,
				unmapped.length ? h('section', { className: 'cts-step-evidence' }, h('strong', null, '待核对配图'),
					h('p', { role: 'status' }, '这些图对不上当前步骤或预期，请核对后重新挂图或移除。'),
					unmapped.map((entry) => renderFigure(entry.figure, `待核对（${entry.reason}）· `))) : null,
				signals.length ? h('section', { className: 'cts-step-evidence' }, h('strong', null, '信号参考（DBC）'), signals.map((figure) => renderFigure(figure))) : null,
				h('h3', null, '添加界面图'),
				h('div', { className: 'cts-filter' },
					h('input', { className: 'cts-input', value: query, ref: picker, 'aria-label': '设计控件名称', placeholder: '搜索已导入的 Pixso 控件', onChange: (event) => setQuery(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter' && query.trim() && !searching) search(); } }),
					h('button', { className: 'cts-btn', disabled: searching || !query.trim(), onClick: search }, searching ? '搜索中…' : '搜索控件'),
					h('button', { className: 'cts-btn', disabled: busy, onClick: () => onImages(item.case_id, {}) }, '按绑定补图')),
				notice ? h('p', { role: 'status' }, notice) : null,
				hits.map((hit, index) => {
					const id = String(hit.entity_id || '').split('::').at(-1);
					return h('button', { key: hit.entity_id || index, className: 'cts-btn', onClick: () => setNode([hit.logical_file_id, id].filter(Boolean).join('/')) }, hit.name || id);
				}),
				h('label', { className: 'cts-field' }, h('span', { className: 'cts-field-l' }, '设计节点 GUID'),
					h('input', { className: 'cts-input cts-input-sm', value: node, onChange: (event) => setNode(event.target.value), placeholder: 'GUID 或 设计稿 ID/GUID' })),
				h('label', { className: 'cts-field' }, h('span', { className: 'cts-field-l' }, '图片用途'),
					h('select', { className: 'cts-select', value: role, onChange: (event) => setRole(event.target.value) },
						['操作定位', '预期界面参考'].map((value) => h('option', { key: value, value }, value)))),
				h('label', { className: 'cts-field' }, h('span', { className: 'cts-field-l' }, '关联步骤'),
					h('select', { className: 'cts-select', value: step, onChange: (event) => setStep(event.target.value) },
						h('option', { value: '' }, '全局参考'),
						(item.steps || []).map((line, index) => h('option', { key: index, value: String(index + 1) }, `步骤 ${index + 1} · ${line.slice(0, 50)}`)))),
				h('button', { className: 'cts-btn primary', disabled: busy || !node.trim(), onClick: () => onImages(item.case_id, { node: node.trim(), role, step }) }, '添加配图'),
				zoom ? h('dialog', { ref: dialog, onClose: () => setZoom(null) },
					h('img', { className: 'cts-figure-zoom', src: zoom.src, alt: zoom.label }),
					h('button', { className: 'cts-btn', onClick: () => dialog.current?.close() }, '关闭大图')) : null);
		}

		function FactEvidence({ item, projectId, onOpen }) {
			const [entry, setEntry] = React.useState(null);
			const [notice, setNotice] = React.useState('');
			const read = async (id) => {
				setNotice('正在读取证据…');
				setEntry(null);
				try {
					setEntry(await request('evidence.read', { project: projectId, id }));
					setNotice('');
				} catch (err) { setNotice(err.message); }
			};
			return h('section', { className: 'cts-step-evidence' },
				h('strong', null, '来源证据'),
				h('div', { className: 'cts-actions' }, (item.evidence_refs || []).map((id) =>
					h('button', { key: id, className: 'cts-btn', onClick: () => read(id) }, id)),
					h('button', { className: 'cts-btn', onClick: () => onOpen('fact_id', item.fact_id) }, '查看影响范围')),
				entry ? h('div', { className: 'cts-item' },
					h('div', { className: 'cts-item-m' }, `${entry.source} · ${entry.location}`),
					h('div', { className: 'cts-evidence-text' }, entry.text)) : null,
				notice ? h('div', { role: 'status' }, notice) : null);
		}

		function DetailEditor({ kind, item, onJump, onOpen, gaps, quality = [], onImpact, onClose, onSave, onRegenerate, onDelete, onApprove, busy, projectId, onImages, moduleId, onVariantGenerated, locked }) {
			const [draft, setDraft] = React.useState(() => toDraft(kind, item));
			const [dirty, setDirty] = React.useState(false);
			const [editing, setEditing] = React.useState(kind !== 'cases');
			const [variantStatus, setVariantStatus] = React.useState('');
			const [variantBusy, setVariantBusy] = React.useState(false);
			const [activeAnchor, setActiveAnchor] = React.useState(null);
			React.useEffect(() => { setDraft(toDraft(kind, item)); setDirty(false); setActiveAnchor(null); }, [kind, item]);
			const stepIndexById = React.useMemo(() => {
				const map = new Map();
				(item.step_items || []).forEach((s, idx) => {
					if (s.id) map.set(s.id, idx + 1);
					if (s.key) map.set(s.key, idx + 1);
				});
				return map;
			}, [item]);
			const resolveStepNum = (ref, fallbackIdx = 0) => {
				if (typeof ref === 'number' && ref > 0) return ref;
				if (ref && stepIndexById.has(ref)) return stepIndexById.get(ref);
				const m = /^S0?(\d+)$/i.exec(String(ref || '').trim());
				if (m) return Number(m[1]);
				return Number(fallbackIdx || 0);
			};
			const idField = kind === 'facts' ? 'fact_id' : kind === 'points' ? 'point_id' : 'case_id';
			const status = ({ candidate: '待评审', approved: '已批准', rejected: '已撤销批准' })[item.review_status] || item.review_status || '待评审';
			const contractRefs = kind === 'points' ? item.contract_refs || [] : [];
			const alternatives = kind === 'points' && item.review_status === 'approved'
				? String(item.action || '').split(/或/).map((action) => action.trim()).filter(Boolean) : [];
			const generateVariant = async (action) => {
				setVariantBusy(true); setVariantStatus('');
				try {
					await streamSse('cts/api/generate', { project: projectId, module: moduleId, kind: 'cases', draft: false,
						point_ids: [item.point_id], case_variant: { point_id: item.point_id, action } }, (event, data) => {
						if (event === 'phase') setVariantStatus(data.label);
						if (event === 'error') setVariantStatus(data.message);
						if (event === 'run.end') setVariantStatus(data.completed_ids?.length ? '该触发路径已生成，待评审。'
							: data.failed_ids?.length ? '本次未生成可用草稿，旧用例已保留。' : '已有该触发路径的用例。');
					});
					await onVariantGenerated();
				} catch (error) { setVariantStatus(error.message); }
				finally { setVariantBusy(false); }
			};
			return h('div', { className: 'cts-detail' },
				h('div', { className: 'cts-detail-head' },
					h('button', { className: 'cts-btn', onClick: onClose }, '← 返回'),
					h('span', { className: 'cts-item-m' }, `${item[idField]} · ${status}`)),
				kind === 'cases' ? h('div', { className: 'cts-case-header' },
					h('h2', null, item.title),
					h('div', { className: 'cts-item-m' }, [item.priority, item.feature_id, item.point_id].filter(Boolean).join(' · ')),
					item.variant_action ? h('p', null, '触发路径 · ' + item.variant_action) : null,
					!editing && item.precondition ? h('p', null, '前置条件 · ' + item.precondition) : null,
					!editing && item.prepare_detail ? h('p', null, '准备 · ' + item.prepare_detail) : null,
					!editing && item.verification ? h('p', null, '判定方式 · ' + item.verification) : null,
					!editing && item.failure_policy ? h('p', null, '失败处理 · ' + item.failure_policy) : null,
					// 执行者要能只凭卡片建立初态、判失败、做恢复：只渲染 text 会丢掉读回方法与失败处置。
					!editing && (item.prepare_items || []).length ? h('details', { open: true },
						h('summary', null, `准备明细（${item.prepare_items.length}）· 建立、读回与失败处置`),
						item.prepare_items.map((entry) => h('pre', { className: 'cts-item-m', key: entry.id },
							[`${entry.id} · ${entry.text}`, entry.object && `对象 · ${entry.object}`, entry.target && `目标 · ${entry.target}`,
								entry.establish && `建立 · ${entry.establish}`, entry.read_back && `读回 · ${entry.read_back}`,
								entry.on_failure && `失败 · ${entry.on_failure}`].filter(Boolean).join('\n')))) : null,
					!editing && ((item.restore_items || []).length || (item.restore_steps || []).length) ? h('details', { open: true },
						h('summary', null, `恢复（${(item.restore_items || []).length || item.restore_steps.length}）· 执行时不可省略`),
						(item.restore_items || []).length
							? item.restore_items.map((entry) => h('pre', { className: 'cts-item-m', key: entry.id },
								[`${entry.id} · ${entry.text}`, entry.baseline && `基线 · ${entry.baseline}`,
									entry.read_back && `读回 · ${entry.read_back}`, entry.on_failure && `失败 · ${entry.on_failure}`].filter(Boolean).join('\n')))
							: h('pre', { className: 'cts-item-m' }, item.restore_steps.join('\n'))) : null,
					!editing && (item.expected_items || []).length ? h('details', { open: true, style: { marginTop: 8 } },
						h('summary', null, `逐项判据（${item.expected_items.length}）· 点击高亮对应触发/观察步骤`),
						h('div', { className: 'cts-expected-list' },
							item.expected_items.map((entry, idx) => {
								const trigNum = resolveStepNum(entry.trigger);
								const obsNum = resolveStepNum(entry.observe, entry.step_index);
								const isActive = activeAnchor && (activeAnchor.expectedId === (entry.id || idx) || (activeAnchor.stepFilter && (activeAnchor.stepFilter === obsNum || activeAnchor.stepFilter === trigNum)));
								return h('div', {
									key: entry.id || idx,
									className: `cts-expected-card${isActive ? ' active' : ''}`,
									onClick: () => setActiveAnchor(activeAnchor?.expectedId === (entry.id || idx) ? null : { expectedId: entry.id || idx, triggerStep: trigNum, observeStep: obsNum })
								},
									h('div', { className: 'cts-expected-head' },
										h('strong', null, entry.object || `判据 ${idx + 1}`),
										entry.kind ? h('span', { className: 'cts-pill info' }, entry.kind) : null,
										entry.assertion_ref ? h('span', { className: 'cts-pill' }, entry.assertion_ref) : null,
										trigNum ? h('span', { className: 'cts-pill ok' }, `触发 S${String(trigNum).padStart(2, '0')}`) : null,
										obsNum ? h('span', { className: 'cts-pill info' }, `观察 S${String(obsNum).padStart(2, '0')}`) : null,
										Number(entry.frames) > 0 ? h('span', { className: 'cts-pill warn' }, `连续 ${entry.frames} 帧`) : null,
										Number(entry.delay_s) > 0 ? h('span', { className: 'cts-pill warn' }, `${entry.delay_s}s 窗口`) : null,
										entry.evidence_ref ? h('span', { className: 'cts-hint' }, entry.evidence_ref) : null),
									h('div', { className: 'cts-expected-target' }, entry.target || ''));
							}))) : null,
					// 延期义务必须在卡片上可见，否则读者会以为本例根本不测它。
					!editing && (item.deferred_items || []).length ? h('details', { open: true },
						h('summary', null, `待裁决判据（${item.deferred_items.length}）· 本轮不可判定，义务保留`),
						item.deferred_items.map((entry) => h('pre', { className: 'cts-item-m', key: entry.id },
							[`${entry.id}${entry.assertion_ref ? ' · ' + entry.assertion_ref : ''} · ${entry.object}：${entry.target}`,
								`原因 · ${entry.unresolved || ''}`, `原文 · ${entry.evidence_ref || ''}`].join('\n')))) : null,
					item.point_id ? h('button', { className: 'cts-btn', onClick: () => onJump('points', item.point_id) }, '查看来源测试点') : null,
					h('button', { className: 'cts-btn', onClick: () => { setEditing(!editing); if (editing) { setDraft(toDraft(kind, item)); setDirty(false); } } }, editing ? '收起编辑' : '编辑用例')) : null,
				kind === 'points' && quality.length ? h('ul', { className: 'cts-lint' }, quality.map((message) => h('li', { key: message }, message))) : null,
				alternatives.length > 1 ? h('details', { className: 'cts-model-tools' },
					h('summary', null, '按触发路径生成用例'),
					h('div', { className: 'cts-filter' }, alternatives.map((action, index) => h('button', { className: 'cts-btn',
						key: index, disabled: busy || dirty || locked || variantBusy, onClick: () => generateVariant(action) }, action))),
					variantStatus ? h('p', { role: 'status' }, variantStatus) : null) : null,
				contractRefs.length ? h('div', { className: 'cts-item' },
					h('div', { className: 'cts-filter' }, contractRefs.map((id, index) => h('button', { key: id, className: 'cts-btn', onClick: () => onOpen('model', id) }, '查看需求 ' + (index + 1)))),
					h('div', { className: 'cts-hint' }, '场景与来源在 ECSM 需求合同中修改。')) : null,
				kind === 'points' && item.source?.quote ? h('details', { className: 'cts-step-evidence' },
					h('summary', null, ['查看测试点原文', item.source.evidence_id].filter(Boolean).join(' · ')),
					h('div', { className: 'cts-item-m' }, [item.source.location, item.source.version].filter(Boolean).join(' · ')),
					h('div', { className: 'cts-evidence-text' }, item.source.quote)) : null,
				kind === 'points' && item.fact_refs?.length ? h('div', { className: 'cts-filter' },
					item.fact_refs.map((id) => h('button', { key: id, className: 'cts-btn', onClick: () => onOpen('fact', id) }, '查看事实 ' + id))) : null,
				editing ? FIELDS[kind].map(([key, label, type, options]) => {
					const readOnly = contractRefs.length > 0 && ['requirement', 'condition', 'action', 'expected', 'fact_refs', 'transition_ref'].includes(key);
					return h('label', { className: 'cts-field', key },
					h('span', { className: 'cts-field-l' }, label),
					type === 'select'
						? h('select', {
							className: 'cts-input cts-input-sm',
							value: draft[key],
							onChange: (event) => { setDraft({ ...draft, [key]: event.target.value }); setDirty(true); }
						}, options.map((option) => h('option', { key: option, value: option }, option)))
						: type === 'textarea' || type === 'lines'
							? h('textarea', {
								className: 'cts-input',
								rows: type === 'lines' ? 5 : 3,
								readOnly,
								value: draft[key],
								onChange: (event) => { setDraft({ ...draft, [key]: event.target.value }); setDirty(true); }
							})
							: h('input', {
								className: 'cts-input cts-input-sm',
								readOnly,
								value: draft[key],
								onChange: (event) => { setDraft({ ...draft, [key]: event.target.value }); setDirty(true); }
							}));
				}) : null,
				kind === 'facts' ? h(FactEvidence, { item, projectId, onOpen: onImpact }) : null,
				kind === 'cases' ? h(CaseImages, { key: item.case_id, item, projectId, moduleId, onImages, busy: busy || dirty, gaps, activeAnchor,
					onSelectStep: (stepNum) => setActiveAnchor((cur) => cur?.stepFilter === stepNum ? null : { stepFilter: stepNum, observeStep: stepNum }) }) : null,
				h('div', { className: 'cts-detail-actions' },
					editing ? h('button', { className: 'cts-btn primary', disabled: !dirty || busy, onClick: () => onSave(toPatch(kind, draft)) }, '保存') : null,
					!contractRefs.length ? h('button', { className: 'cts-btn', disabled: busy, onClick: onRegenerate }, busy ? '…' : '重生成') : null,
					item.review_status === 'approved'
						? h('button', { className: 'cts-btn', disabled: busy || dirty, onClick: () => onApprove('rejected') }, '撤销批准')
						: h('button', { className: 'cts-btn', disabled: busy || dirty, onClick: () => onApprove('approved') }, '批准'),
					h('button', { className: 'cts-btn', disabled: busy, onClick: onDelete }, '删除')));
		}

		function BindingRow({ item, onConfirm, onManual, busy }) {
			const [choice, setChoice] = React.useState(0);
			const [nodeId, setNodeId] = React.useState('');
			const target = item.target || null;
			const chip = item.status === 'bound' ? '✓ 已绑' : item.status === 'ambiguous' ? '待确认' : item.status === 'rejected' ? '已拒绝' : '未匹配';
			return h('div', { className: 'cts-item' },
				h('div', { className: 'cts-item-t' }, `${item.subject?.name || ''}`),
				h('div', { className: 'cts-item-m' }, `${item.kind === 'control' ? '控件' : '信号'} · ${chip}${target ? ` · ${target.name || ''}` : ''}`),
				item.status === 'unmatched'
					? h('div', { style: { display: 'flex', gap: 4, marginTop: 4 } },
						h('input', {
							className: 'cts-input cts-input-sm',
							style: { flex: '1 1 auto', minWidth: 0 },
							placeholder: '设计节点 id，如 5014:120317',
							value: nodeId,
							onChange: (event) => setNodeId(event.target.value)
						}),
						h('button', { className: 'cts-btn', disabled: busy || nodeId.trim() === '', onClick: () => onManual(item.binding_id, nodeId.trim()) }, '绑定'))
					: null,
				item.status === 'ambiguous' && (item.candidates || []).length > 0
					? h('div', { style: { display: 'flex', gap: 4, marginTop: 4 } },
						h('select', {
							className: 'cts-select',
							style: { flex: '1 1 auto', minWidth: 0 },
							value: choice,
							onChange: (event) => setChoice(Number(event.target.value))
						}, item.candidates.map((candidate, index) => h('option', { key: index, value: index },
							`${candidate.name || candidate.node_id}${candidate.board ? ' @' + candidate.board : ''}`))),
						h('button', { className: 'cts-btn', disabled: busy, onClick: () => onConfirm(item.binding_id, choice) }, '采用'))
					: null);
		}

		function CaseReviewImport({ projectId, moduleId, onSaved }) {
			const [file, setFile] = React.useState('');
			const [preview, setPreview] = React.useState(null);
			const [notice, setNotice] = React.useState('');
			const [busy, setBusy] = React.useState(false);
			const run = async (apply) => {
				setBusy(true); setNotice('');
				try {
					const result = await request(apply ? 'cases.reviewApply' : 'cases.reviewPreview',
						{ project: projectId, module: moduleId, ...(apply ? preview : { file }) });
					setPreview(apply ? null : result);
					if (apply) { await onSaved(); setNotice('评审意见已应用，修改过的用例需重新批准。'); }
				} catch (err) { setNotice(err.message); }
				finally { setBusy(false); }
			};
			return h('details', { className: 'cts-model-tools' },
				h('summary', null, '导入 Excel 评审意见'),
				h('div', { className: 'cts-filter' },
					h('label', null, '评审文件路径 ', h('input', { value: file, onChange: (event) => { setFile(event.target.value); setPreview(null); } })),
					h('button', { className: 'cts-btn', disabled: busy || !file.trim(), onClick: () => run(false) }, '预览评审差异')),
				preview ? h('div', null, h('p', null, preview.changes.length + ' 条用例有变化'),
					preview.changes.map((item) => h('p', { key: item.case_id }, item.case_id + ' · ' + Object.values(item.patch).join(' · '))),
					h('button', { className: 'cts-btn', disabled: busy || !preview.changes.length, onClick: () => run(true) }, '应用评审意见')) : null,
				notice ? h('p', { role: 'status' }, notice) : null);
		}

		function ConflictPanel({ projectId, moduleId, contracts, onSaved, onOpen }) {
			const [doc, setDoc] = React.useState(null);
			const [form, setForm] = React.useState({ contract_id: '', reason: '', refs: '', kind: 'conflict' });
			const [decision, setDecision] = React.useState({});
			const [evidence, setEvidence] = React.useState({});
			const [notice, setNotice] = React.useState('');
			const [busy, setBusy] = React.useState(false);
			const call = (action, fields) => request(action, { project: projectId, module: moduleId, ...fields });
			React.useEffect(() => { call('conflicts.view').then(setDoc).catch((err) => setNotice(err.message)); }, [projectId, moduleId]);
			const save = async (fields) => {
				setBusy(true); setNotice('');
				try { setDoc(await call('conflict.save', { ...fields, version: doc.version })); await onSaved(); }
				catch (err) { setNotice(err.message); }
				finally { setBusy(false); }
			};
			const read = async (id) => {
				try { const source = await call('evidence.read', { id }); setEvidence((old) => ({ ...old, [id]: source })); }
				catch (err) { setNotice(err.message); }
			};
			return h('div', { className: 'cts-right' },
				h('h2', null, '资料冲突与需求裁决'),
				h('p', null, '先看系统发现的待核对项。打开合同和原文核实，确实需要定口径时，再加入裁决。'),
				doc ? h('section', { 'aria-label': '系统发现的待核对项' },
					h('h3', null, `待核对 · ${(doc.suggestions || []).length} 项`),
					doc.suggestions?.length ? doc.suggestions.map((item) => {
						const contract = contracts.find((entry) => entry.contract_id === item.contract_id);
						return h('article', { className: 'cts-item', key: item.contract_id + ':' + item.reason },
							h('strong', null, contract?.title || item.contract_id),
							h('p', null, item.reason),
							item.related ? h('p', null, `「${contract?.title || item.contract_id}」预期 ${contract?.expected || ''} / 「${item.related.title}」预期 ${item.related.expected}`) : null,
							h('div', { className: 'cts-filter' },
								h('button', { className: 'cts-btn', onClick: () => onOpen('model', item.contract_id) }, '查看合同'),
								item.related ? h('button', { className: 'cts-btn', onClick: () => onOpen('model', item.related.id) }, '查看另一条合同') : null,
								item.evidence_refs.map((id) => h('button', { key: id, className: 'cts-btn', onClick: () => read(id) }, '查看 ' + id)),
								h('button', { className: 'cts-btn', disabled: busy, onClick: () => save({
									contract_id: item.contract_id, kind: item.kind, reason: item.reason, evidence_refs: item.evidence_refs, related: item.related
								}) }, '加入裁决')),
							item.evidence_refs.filter((id) => evidence[id]).map((id) => h('div', { key: id },
								h('strong', null, evidence[id].source + ' · ' + evidence[id].location),
								h('pre', { className: 'cts-evidence-text' }, evidence[id].text))));
					}) : h('p', { className: 'cts-hint' }, '当前合同未发现明显的待核对项。'),
					doc.factQuestions?.length ? h('details', { open: !doc.suggestions?.length, className: 'cts-model-tools' },
						h('summary', null, `来源事实待确认 · ${doc.factQuestions.length} 项`),
						doc.factQuestions.map((item) => h('article', { className: 'cts-item', key: item.id },
							h('p', null, item.question),
							h('div', { className: 'cts-filter' },
								h('button', { className: 'cts-btn', onClick: () => onOpen('fact', item.fact_id) }, '查看来源事实'),
								h('button', { className: 'cts-btn', onClick: () => onOpen('questions') }, '去待回答处理'))))) : null) : null,
				h('details', { className: 'cts-model-tools' }, h('summary', null, '手动登记问题'),
				h('div', { className: 'cts-filter' },
					h('select', { 'aria-label': '关联需求', value: form.contract_id, onChange: (event) => setForm({ ...form, contract_id: event.target.value }) },
						h('option', { value: '' }, '选择关联需求'), contracts.map((item) => h('option', { key: item.contract_id, value: item.contract_id }, item.title))),
					h('select', { 'aria-label': '问题类型', value: form.kind, onChange: (event) => setForm({ ...form, kind: event.target.value }) },
						h('option', { value: 'conflict' }, '资料冲突'), h('option', { value: 'missing_evidence' }, '缺少证据'), h('option', { value: 'binding' }, '绑定问题')),
					h('input', { 'aria-label': '问题描述', placeholder: '说明差异或缺什么', value: form.reason, onChange: (event) => setForm({ ...form, reason: event.target.value }) }),
					h('input', { 'aria-label': '证据编号', placeholder: '例如 E-0001 E-0002', value: form.refs, onChange: (event) => setForm({ ...form, refs: event.target.value }) }),
					h('button', { className: 'cts-btn', disabled: busy || !doc || !form.contract_id || !form.reason.trim(),
						onClick: () => save({ ...form, evidence_refs: form.refs.split(/[\s,，]+/).filter(Boolean) }) }, '登记问题'))),
				h('h3', null, `已登记 · ${(doc?.items || []).filter((item) => item.status === 'open').length} 项待裁决`),
				(doc?.items || []).map((item) => h('article', { className: 'cts-item', key: item.id },
					h('h3', null, item.reason),
					h('p', null, (contracts.find((entry) => entry.contract_id === item.contract_id)?.title || item.contract_id) + ' · ' + (item.status === 'open' ? '待裁决' : '已裁决')),
					h('div', { className: 'cts-filter' }, item.evidence_refs.map((id) => h('button', { className: 'cts-btn', key: id, onClick: () => read(id) }, '查看 ' + id))),
					h('div', { className: 'cts-model-evidence' }, item.evidence_refs.filter((id) => evidence[id]).map((id) => h('section', { key: id },
						h('strong', null, evidence[id].source + ' · ' + evidence[id].location), h('pre', { className: 'cts-evidence-text' }, evidence[id].text)))),
					h('div', { className: 'cts-filter' },
						h('button', { className: 'cts-btn', onClick: () => onOpen('model', item.contract_id) }, '打开关联需求'),
						item.related ? h('button', { className: 'cts-btn', onClick: () => onOpen('model', item.related.id) }, '查看另一条合同') : null,
						(item.points || []).map(({ id, title }) => h('button', { key: id, className: 'cts-btn', onClick: () => onOpen('points', id) }, '测试点 · ' + title)),
						(item.cases || []).map(({ id, title }) => h('button', { key: id, className: 'cts-btn', onClick: () => onOpen('cases', id) }, '用例 · ' + title))),
					item.status === 'open' ? h('div', { className: 'cts-filter' },
						h('input', { 'aria-label': '裁决结论', value: decision[item.id]?.conclusion || '', onChange: (event) => setDecision({ ...decision, [item.id]: { ...decision[item.id], conclusion: event.target.value } }) }),
						h('input', { 'aria-label': '裁决理由', placeholder: '裁决依据', value: decision[item.id]?.rationale || '', onChange: (event) => setDecision({ ...decision, [item.id]: { ...decision[item.id], rationale: event.target.value } }) }),
						h('input', { 'aria-label': '裁决人', value: decision[item.id]?.reviewer || '', onChange: (event) => setDecision({ ...decision, [item.id]: { ...decision[item.id], reviewer: event.target.value } }) }),
						h('button', { className: 'cts-btn', disabled: busy || !decision[item.id]?.conclusion || !decision[item.id]?.reviewer,
							onClick: () => save({ id: item.id, ...decision[item.id] }) }, '保存裁决'))
						: h('p', null, item.conclusion + ' · ' + item.reviewer))),
				notice ? h('p', { role: 'status' }, notice) : null);
		}

		function SourceScope({ projectId, moduleId, onSaved, refresh, onFact }) {
			const [state, setState] = React.useState(null);
			const [roles, setRoles] = React.useState({});
			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState('');
			const load = (result) => { setState(result); setRoles(Object.fromEntries((result.items || []).map((item) => [item.path, item.role]))); };
			React.useEffect(() => {
				let active = true;
				request('sources.view', { project: projectId, module: moduleId }).then((result) => {
					if (active) load(result);
				}).catch((err) => {
					if (active) setNotice(err.message);
				});
				return () => { active = false; };
			}, [projectId, moduleId, refresh]);
			const save = async () => {
				setBusy(true);
				try {
					load(await request('sources.save', { project: projectId, module: moduleId, version: state.version,
						items: Object.entries(roles).filter(([, role]) => role).map(([path, role]) => ({ path, role })) }));
					await onSaved();
					setNotice('已保存模块资料范围');
				} catch (err) { setNotice(err.message); }
				finally { setBusy(false); }
			};
			return h('section', null, h('h2', null, '模块资料范围与来源版本'),
				notice ? h('p', { role: 'status' }, notice) : !state ? h('p', { role: 'status' }, '正在读取资料范围…') : null,
				state?.unresolved?.length ? h('details', null, h('summary', null, `${state.unresolved.length} 条事实需要核对来源`),
					state.unresolved.slice(0, 40).map((item) => h('button', { key: item.id, className: 'cts-btn', onClick: () => onFact(item.id) }, item.id + ' · ' + item.statement))) : null,
				h('p', null, '构建证据后，可以指定本模块使用的资料。留空沿用项目默认范围。'),
				(state?.sources || []).map((item) => h('div', { key: item.path, className: 'cts-filter' },
					h('label', null, item.path, ' ', h('select', { className: 'cts-select', value: roles[item.path] || '',
						onChange: (event) => setRoles({ ...roles, [item.path]: event.target.value }) },
						[['', '未选'], ['requirement', '产品规则'], ['interface', '接口定义'], ['design', '界面设计'], ['reference', '历史参考']]
							.map(([id, name]) => h('option', { key: id, value: id }, name)))),
					h('span', { className: 'cts-item-m' }, item.error || [item.version, item.items + ' 条证据'].filter(Boolean).join(' · ')))),
				state?.sources?.length ? h('button', { className: 'cts-btn', disabled: busy, onClick: save }, '保存资料范围') : null);
		}

		function AgentReviewPanel({ projectId, moduleId, stage, objects, onSaved, onLocate, locked, revision, fastTrack = false }) {
			const [report, setReport] = React.useState(null);
			const [chosen, setChosen] = React.useState('');
			const [checked, setChecked] = React.useState([]);
			const [preview, setPreview] = React.useState(null);
			const [repairDiff, setRepairDiff] = React.useState(null);
			const [reviewer, setReviewer] = React.useState('');
			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState('');
			const [progress, setProgress] = React.useState(null);
			const abortRef = React.useRef(null);
			const target = objects.some((item) => item.id === chosen) ? chosen : objects[0]?.id;
			const receipt = report?.items?.find((item) => item.object_id === target);
			const call = (action, fields) => request(action, { project: projectId, module: moduleId, stage, ...fields });
			const load = () => call('agent.review.view');
			React.useEffect(() => {
				let active = true;
				load().then((data) => { if (active) setReport(data); }).catch((error) => { if (active) setNotice(error.message); });
				return () => { active = false; };
			}, [projectId, moduleId, stage, revision]);
			const perform = async (action) => {
				setBusy(true); setNotice(''); setProgress(null);
				try { await action(); }
				catch (error) {
					if (error?.name === 'AbortError') setNotice('已取消审查（已完成的页已自动留档，下次重跑只补剩余页）。');
					else setNotice(error.message);
				} finally {
					abortRef.current = null;
					setProgress(null);
					setBusy(false);
				}
			};
			const cancelReview = () => {
				abortRef.current?.abort();
				abortRef.current = null;
			};
			const review = (all) => perform(async () => {
				setPreview(null); setChecked([]);
				let complete = false;
				const controller = new AbortController();
				abortRef.current = controller;
				await streamSse('cts/api/review', { project: projectId, module: moduleId, stage, ...(all ? {} : { object_ids: [target] }) }, (event, data) => {
					if (event === 'phase') {
						setNotice(data.label);
						if (data.total) setProgress({ step: data.step || 0, total: data.total, label: data.label || '' });
					}
					if (event === 'review.retry') setNotice(`正在自动重试 ${data.pages} 个失败页（第 ${data.round} 轮）…`);
					if (event === 'error') setNotice(data.message);
					if (event === 'run.end' && data.published) complete = true;
				}, controller.signal);
				setReport(await load());
				await onSaved?.();
				if (complete) setNotice('独立审查已完成并发布，可直接批量批准通过项。');
			});
			const defectiveReceipts = stage === 'cases' && report && !report.stale
				? (report.items || []).filter((item) => item.conclusion === '待修改' && (item.findings || []).length > 0)
				: [];
			const repairAllDefective = () => perform(async () => {
				if (!defectiveReceipts.length) return;
				const objById = new Map(objects.map((o) => [o.id, o]));
				const defectiveCaseIds = defectiveReceipts.map((r) => r.object_id).filter((id) => objById.has(id));
				const defectivePointIds = [...new Set(defectiveCaseIds.map((id) => objById.get(id)?.point_id).filter(Boolean))];
				if (!defectiveCaseIds.length || !defectivePointIds.length) throw new Error('没有可定向重做的待修改用例');
				const controller = new AbortController();
				abortRef.current = controller;
				let genEnd = null;
				setNotice(`正在定向重做 ${defectiveCaseIds.length} 条待修改用例…`);
				await streamSse('cts/api/generate', {
					project: projectId,
					module: moduleId,
					kind: 'cases',
					draft: false,
					...(fastTrack ? { source_mode: 'facts', require_outline: false } : {}),
					retry_defective: true,
					case_ids: defectiveCaseIds,
					point_ids: defectivePointIds
				}, (event, data) => {
					if (event === 'phase') {
						setNotice(`批量重做 · ${data.label}`);
						if (data.total) setProgress({ step: data.step || 0, total: data.total, label: `批量重做 · ${data.label || ''}` });
					}
					if (event === 'error') setNotice(data.message);
					if (event === 'run.end') genEnd = data;
				}, controller.signal);
				await onSaved?.();
				const completedPts = new Set(genEnd?.completed_ids || []);
				const repairedCaseIds = defectiveCaseIds.filter((id) => completedPts.has(objById.get(id)?.point_id));
				if (!repairedCaseIds.length) {
					setReport(await load());
					setNotice('本次批量重做未产出新修订（原用例已保留），可查看单条意见后重试。');
					return;
				}
				setNotice(`已完成 ${repairedCaseIds.length} 条重做，正在自动复审改动用例…`);
				let reviewPublished = false;
				await streamSse('cts/api/review', {
					project: projectId,
					module: moduleId,
					stage: 'cases',
					object_ids: repairedCaseIds
				}, (event, data) => {
					if (event === 'phase') {
						setNotice(`自动复审 · ${data.label}`);
						if (data.total) setProgress({ step: data.step || 0, total: data.total, label: `自动复审 · ${data.label || ''}` });
					}
					if (event === 'review.retry') setNotice(`自动复审重试 ${data.pages} 个失败页（第 ${data.round} 轮）…`);
					if (event === 'error') setNotice(data.message);
					if (event === 'run.end' && data.published) reviewPublished = true;
				}, controller.signal);
				setReport(await load());
				await onSaved?.();
				setNotice(reviewPublished
					? `已完成 ${repairedCaseIds.length}/${defectiveCaseIds.length} 条定向重做与自动复审，可直接点击「一键批准全部符合门禁项」。`
					: `已完成 ${repairedCaseIds.length} 条重做，部分复审页未完成，请再点一次审查补齐。`);
			});
			const repairSelection = () => ({ object_id: target, finding_indexes: checked });
			const previewRepair = () => perform(async () => {
				const selection = repairSelection();
				const base = await call('agent.review.repairPreview', selection);
				setPreview(stage === 'cases' ? base : await call('agent.review.suggest', { ...selection, basis: base.basis }));
			});
			const apply = () => perform(async () => {
				setRepairDiff(null);
				const selection = repairSelection();
				const current = await call('agent.review.repairPreview', selection);
				if (current.basis !== preview.basis) throw new Error('修改范围或基线已变化，请重新预览');
				if (stage === 'cases') {
					let complete = false;
					await streamSse('cts/api/generate', { project: projectId, module: moduleId, kind: 'cases', draft: false,
						retry_defective: true, point_ids: [preview.point_id], case_ids: [target],
						review_repair: { ...selection, basis: preview.basis } }, (event, data) => {
						if (event === 'phase') setNotice(data.label);
						if (event === 'error') setNotice(data.message);
						if (event === 'repair.diff') setRepairDiff(data);
						if (event === 'run.end') complete = data.completed_ids?.includes(preview.point_id) && !data.failed_ids?.includes(preview.point_id);
					});
					if (!complete) throw new Error('当前变体未生成可用修订，可查看动作记录后重试');
				} else {
					const patch = Object.fromEntries(preview.changes.map(({ field, after }) => [field, after]));
					if (stage === 'contracts') await call('contracts.save', { id: target, version: preview.version, patch });
					if (stage === 'points') await call('artifact.update', { kind: 'points', id: target, version: preview.version, digest: preview.digest, patch });
					if (stage === 'outline') await call('outline.apply', { digest: preview.digest, reviewer: reviewer.trim(),
						changes: [{ id: target, action: 'edit', comment: patch.requirement }] });
				}
				setPreview(null); setChecked([]); setChosen('');
				await onSaved?.();
				setReport(await load());
				setNotice('新修订已保存，待复审。');
			});
			if (!objects.length) return null;
			return h('details', { className: 'cts-findings' },
				h('summary', null, '质量审查 Agent' + (report?.items?.length ? ` · 已审 ${report.items.length}/${objects.length}` : '')),
				h('div', { className: 'cts-filter' },
					h('select', { className: 'cts-select', 'aria-label': '审查条目', value: target, disabled: busy,
						onChange: (event) => { setChosen(event.target.value); setPreview(null); setChecked([]); } },
						objects.map(({ id, title }) => h('option', { key: id, value: id }, id + ' · ' + (title || '')))),
					h('button', { className: 'cts-btn', disabled: busy, onClick: () => review(false) }, '独立审查所选'),
					h('button', { className: 'cts-btn primary', disabled: busy, onClick: () => review(true) }, '审查本阶段全部'),
					stage === 'cases' && defectiveReceipts.length > 0 && !locked ? h('button', { className: 'cts-btn primary', disabled: busy, onClick: repairAllDefective }, `一键重做待修改（${defectiveReceipts.length}）并复审`) : null,
					busy ? h('button', { className: 'cts-btn danger', onClick: cancelReview }, '取消') : null,
					onLocate ? h('button', { className: 'cts-btn', onClick: () => onLocate(target) }, '定位条目') : null),
				busy && progress ? h('div', { className: 'cts-filter', style: { margin: '4px 0' } },
					h('progress', { className: 'cts-progress', value: progress.step, max: progress.total }),
					h('span', { className: 'cts-hint' }, `${progress.step}/${progress.total} · ${progress.label}`)) : null,
				report?.stale ? h('p', { className: 'cts-hint' }, '产物或来源已有更新，请重新审查。') : null,
				receipt ? h('div', null, h('p', null, '模型意见 · ' + receipt.conclusion),
					receipt.findings.map((finding, index) => h('div', { className: 'cts-finding', key: index },
						h('label', null, h('input', { type: 'checkbox', checked: checked.includes(index), disabled: busy || locked || report.stale,
							onChange: (event) => { setPreview(null); setChecked(event.target.checked ? [...checked, index] : checked.filter((n) => n !== index)); } }),
						[finding.field, finding.message].filter(Boolean).join(' · ')),
						finding.evidence_ref ? h('div', null, [finding.evidence_ref, finding.quote].filter(Boolean).join(' · ')) : null,
						finding.suggestion ? h('div', null, finding.suggestion) : null)),
					receipt.findings.length ? h('button', { className: 'cts-btn', disabled: busy || locked || report.stale || !checked.length,
						onClick: previewRepair }, '按选中意见重做') : null) : null,
				preview ? h('div', { className: 'cts-model-tools' },
					h('p', null, `修订范围 · ${target} · v${preview.version}`),
					stage === 'cases' ? preview.findings.map((finding, index) => h('p', { key: index }, finding.message))
						: preview.changes.map((change) => h('p', { key: change.field }, `${change.field} · ${change.before} → ${change.after}`)),
					stage === 'outline' ? h('input', { className: 'cts-input', value: reviewer, 'aria-label': '评审人',
						placeholder: '评审人', onChange: (event) => setReviewer(event.target.value) }) : null,
					h('button', { className: 'cts-btn primary', disabled: busy || locked || (stage !== 'cases' && !preview.changes.length)
						|| (stage === 'outline' && !reviewer.trim()), onClick: apply }, stage === 'cases' ? '确认只重做此用例' : '保存为待评审修订')) : null,
				repairDiff ? h('details', { open: true },
					h('summary', null, `修订差异 · ${repairDiff.before_id} → ${repairDiff.after_id}`),
					repairDiff.changes.map((change) => h('details', { key: change.field },
						h('summary', null, ({ title: '标题', precondition: '前置', prepare_detail: '准备', steps: '步骤', expected: '预期',
							deferred_items: '延期', restore_steps: '恢复', failure_policy: '失败留证' })[change.field] || change.field),
						h('pre', null, '修改前\n' + JSON.stringify(change.before ?? '', null, 2)),
						h('pre', null, '修改后\n' + JSON.stringify(change.after ?? '', null, 2))))) : null,
				notice ? h('p', { role: 'status' }, notice) : null);
		}

		function OutlinePanel({ projectId, moduleId, ecsmModel, artifacts, generate, onJump, onOpen, onOutlineStatus, refreshAll, busy, locked }) {
			const [data, setData] = React.useState(null);
			const [scope, setScope] = React.useState([]);
			const [budget, setBudget] = React.useState('30');
			const [risk, setRisk] = React.useState('');
			const [environment, setEnvironment] = React.useState('');
			const [reviewer, setReviewer] = React.useState('');
			const [filter, setFilter] = React.useState('all');
			const [file, setFile] = React.useState('');
			const [preview, setPreview] = React.useState(null);
			const [suggestion, setSuggestion] = React.useState({ id: '', action: 'edit', comment: '', feature_id: '' });
			const [delay, setDelay] = React.useState(null);
			const [coverageAdvice, setCoverageAdvice] = React.useState(null);
			const [notice, setNotice] = React.useState('');
			const [pending, setPending] = React.useState(false);
			const call = (action, fields) => request(action, { project: projectId, module: moduleId, ...fields });
			const load = (result) => {
				setData(result);
				if (result.outlineStatus !== undefined) onOutlineStatus(result.outlineStatus);
				const eligible = result.features.map((feature) => feature.id);
				setScope(result.outline ? result.outline.scope.filter((id) => eligible.includes(id)) : eligible);
				setBudget(String(result.outline?.budget ?? 30));
				setRisk(result.outline?.risk || '');
				setEnvironment(result.outline?.environment || '');
			};
			React.useEffect(() => {
				let active = true;
				call('outline.view').then((result) => { if (active) load(result); }).catch((err) => { if (active) setNotice(err.message); });
				return () => { active = false; };
			}, [projectId, moduleId, ecsmModel?.model?.digest, artifacts.points?.version, artifacts.cases?.version]);
			const apply = async (action, fields) => {
				setPending(true); setNotice('');
				try {
					if (action === 'outline.save' && fields.from_branches && data?.branchesStale && data.tkrPack) {
						await call('tkr.select', { pack: data.tkrPack });
					}
					const result = await call(action, fields);
					if (action === 'agent.design.coverageAdvice') { setCoverageAdvice(result); return; }
					if (action === 'outline.reviewPreview') { setPreview(result); return; }
					if (action === 'outline.export') { setNotice('已导出大纲与评审表 · ' + result.dir); return; }
					load(['deferral.save', 'outline.apply'].includes(action) ? await call('outline.view') : result);
					await refreshAll();
					setPreview(null);
					setDelay(null);
				} catch (err) { setNotice(err.message); }
				finally { setPending(false); }
			};
			const outline = data?.outline;
			const rebuild = outline?.status === 'draft' && Boolean(outline.pending?.length || outline.empty?.length);
			const outside = (outline?.outside || []).filter((item) => data.features.some((feature) => feature.id === item.id));
			const names = { optional: '可选', not_applicable: '不适用', missing: '缺测试点', review: '待评审测试点', covered: '判据齐全', deferred: '已延期', case_missing: '缺用例', case_incomplete: '判据不全' };
			const rows = (data?.rows || []).filter((row) => filter === 'all' || (filter === 'review' ? row.state === 'review' : ['missing', 'case_missing', 'case_incomplete'].includes(row.state)));
			const frozen = ecsmModel?.current && !ecsmModel.drifted;
			const base = { version: data?.version, model_digest: data?.model_digest };
			const disabled = busy || locked || pending;
			const fromBranches = outline?.source_kind === 'branches';
			const saveOutline = () => apply('outline.save', { ...base, scope, budget: Number(budget), risk, environment, from_branches: fromBranches });
			const button = (label, fn, off = false) => h('button', { className: 'cts-btn', onClick: fn, disabled: off }, label);
			return h('section', { className: 'cts-right cts-model-shell', 'aria-label': '测试大纲' },
				h('h2', null, '本轮测试范围'),
				!frozen ? h('div', { className: 'cts-flow-next' }, h('span', null, '请先确认需求并冻结本轮模型。'), button('去核对需求', () => onOpen('model'))) : null,
				frozen && data && !data.features.length ? h('div', { className: 'cts-flow-next' },
					h('span', null, '本轮模型还没有可用于生成大纲的已确认需求。'),
					button('去核对需求', () => onOpen('model'))) : null,
				outline ? h('p', null, `大纲 v${data.version} · ${data.branchesStale ? '需求分支已更新' : data.stale ? '模型已更新' : outline.status === 'approved' ? '已批准' : '待评审'} · ${outline.items.length} 个场景`) : null,
				outline ? h('div', { className: 'cts-model-tools' },
					button('让测试设计 Agent 核对覆盖范围', () => apply('agent.design.coverageAdvice'), pending || busy),
					coverageAdvice?.versions.outline === data.version ? h(Markdown, { text: coverageAdvice.summary }) : null) : null,
				outline ? h(AgentReviewPanel, { projectId, moduleId, stage: 'outline', locked, revision: data.version,
					objects: outline.items.map((item) => ({ id: item.scenario_id, title: item.requirement })),
					onSaved: async () => { load(await call('outline.view')); await refreshAll(); } }) : null,
				fromBranches ? h('div', { className: 'cts-flow-next' }, h('span', null, '本轮范围来自已导入的需求分支。'), button('按需求分支更新大纲', saveOutline, disabled || !frozen))
					: h('details', { open: outline ? undefined : true, className: 'cts-model-tools' }, h('summary', null, '选择本轮功能与组合预算'),
					h('div', { className: 'cts-filter' }, (data?.features || []).map(({ id, name }) => h('label', { key: id },
						h('input', { type: 'checkbox', checked: scope.includes(id), disabled: disabled,
							onChange: () => setScope(scope.includes(id) ? scope.filter((entry) => entry !== id) : [...scope, id]) }), name))),
					h('label', null, '组合预算 ', h('input', { type: 'number', min: 0, max: 10000, value: budget, onChange: (event) => setBudget(event.target.value) })),
					h('label', { className: 'cts-field' }, '本轮风险重点', h('input', { value: risk, onChange: (event) => setRisk(event.target.value) })),
					h('label', { className: 'cts-field' }, '执行环境与可观察范围', h('textarea', { className: 'cts-input cts-input-sm', rows: 2,
						placeholder: '例如仅可查看页面与应用日志，无法观察外部服务执行结果', value: environment, onChange: (event) => setEnvironment(event.target.value) })),
					button(outline ? '更新大纲草稿' : '生成大纲草稿', saveOutline, disabled || !frozen || !scope.length)),
				rebuild && frozen && data.features.length ? h('div', { className: 'cts-flow-next' },
					h('span', null, '这份草稿使用旧的范围规则。请按已确认需求重建草稿，再评审场景。'),
					button('按已确认需求重建草稿', saveOutline, disabled || !scope.length)) : null,
				outline && !data.stale && outline.status !== 'approved' ? h('div', { className: 'cts-filter' },
					h('label', null, '评审人 ', h('input', { value: reviewer, onChange: (event) => setReviewer(event.target.value) })),
					button('批准大纲', () => apply('outline.approve', { ...base, reviewer }), disabled || !reviewer.trim() || rebuild)) : null,
				outline?.status === 'approved' && !data.stale ? h('div', { className: 'cts-filter' },
					data.points_current ? button('查看本轮测试点', () => onJump('points')) : button('从大纲生成测试点', () => generate('points'), disabled || !data.generatable),
					!data.generatable ? h('span', null, '当前没有可生成测试点的场景，请检查覆盖分类和组合预算。') : null,
					button('查看测试用例', () => onJump('cases'))) : null,
				notice ? h('p', { role: 'status' }, notice) : null,
				outline ? h('details', { className: 'cts-model-tools' }, h('summary', null, '大纲评审意见与导出'),
					h('div', { className: 'cts-filter' }, button('导出 XMind 与 Excel', () => apply('outline.export'), pending),
						h('label', null, '评审文件路径 ', h('input', { value: file, onChange: (event) => setFile(event.target.value) })),
						button('预览文件意见', () => apply('outline.reviewPreview', { file }), pending || !file.trim())),
					h('div', { className: 'cts-filter' },
						h('select', { 'aria-label': '场景', value: suggestion.id, onChange: (event) => setSuggestion({ ...suggestion, id: event.target.value }) },
							h('option', { value: '' }, '选择场景'), outline.items.map((row) => h('option', { key: row.scenario_id, value: row.scenario_id }, row.requirement))),
						h('select', { 'aria-label': '评审动作', value: suggestion.action, onChange: (event) => setSuggestion({ ...suggestion, action: event.target.value }) },
							Object.entries({ accept: '接受', edit: '改标题', move: '移动建议', add: '新增建议', delete: '删除建议', split: '拆分建议', merge: '合并建议', conflict: '产品冲突', required: '设为必测', optional: '设为可选', not_applicable: '设为不适用', needs_evidence: '待补证据' })
								.map(([id, label]) => h('option', { key: id, value: id }, label))),
						h('input', { 'aria-label': '意见', value: suggestion.comment, onChange: (event) => setSuggestion({ ...suggestion, comment: event.target.value }) }),
						h('select', { 'aria-label': '目标功能', value: suggestion.feature_id, onChange: (event) => setSuggestion({ ...suggestion, feature_id: event.target.value }) },
							h('option', { value: '' }, '选择目标功能'), data.features.map(({ id, name }) => h('option', { key: id, value: id }, name))),
						button('预览意见', () => apply('outline.reviewPreview', { changes: [suggestion] }), pending)),
					preview ? h('div', { className: 'cts-item' },
						preview.changes.map((entry, index) => h('p', { key: index }, [entry.id, entry.action, entry.comment, entry.feature_id].filter(Boolean).join(' · '))),
						h('label', null, '评审人 ', h('input', { value: reviewer, onChange: (event) => setReviewer(event.target.value) })),
						button('应用评审意见', () => apply('outline.apply', { ...preview, reviewer }), disabled || !preview.changes.length || !reviewer.trim())) : null) : null,
				outline ? h('label', null, '覆盖筛选 ', h('select', { value: filter, onChange: (event) => setFilter(event.target.value) },
					h('option', { value: 'all' }, '全部场景'), h('option', { value: 'gap' }, '只看缺口'), h('option', { value: 'review' }, '只看待评审'))) : null,
				outline?.tkr ? h('details', { className: 'cts-flow-next' },
					h('summary', null, `选规记录 · ${outline.tkr.bundle_ref} · ${outline.tkr.pack_status === 'candidate_under_review' ? '候选包，未放行' : outline.tkr.pack_status}`),
					h('p', null, `规则包摘要 ${outline.tkr.bundle_digest} · 选规摘要 ${outline.tkr.selection_digest}`),
					(outline.tkr.capabilities || []).map((capability) => h('div', { key: capability.capability_id },
						h('strong', null, `${capability.name || capability.capability_id} · 选中 ${capability.applied_rules.length} 排除 ${capability.not_applied_rules.length} · ${capability.status}`),
						h('p', null, `匹配分支 ${capability.matched_branches} · 缺口 ${capability.gaps.length} · 问题 ${capability.findings.length}`),
						capability.gaps.length ? h('details', null, h('summary', null, '缺什么'),
							capability.gaps.map((gap) => h('p', { key: gap.output_id }, `${gap.dimension} · ${gap.reason} · ${gap.rule_id}`))) : null,
						capability.blockers.length ? h('p', null, '放行阻断：' + capability.blockers.join('、')) : null))) : null,
				Object.entries(outline?.feature_names || {}).map(([id, name]) => {
					const selected = rows.filter((row) => (row.group_id || row.feature_id) === id);
					return selected.length ? h(ModelBranch, { key: id, title: name, meta: selected.length + ' 个场景' },
						selected.map((row) => h('article', { key: row.scenario_id, className: 'cts-item' },
							h('strong', null, row.requirement), h('p', null, row.condition + ' → ' + row.action + ' → ' + row.expected),
							h('div', { className: 'cts-item-m' }, (row.budget_exceeded ? '超出组合预算 · ' : row.classification === 'needs_evidence' ? '待补证据 · ' : '') + names[row.state] + ' · ' + row.rule_ids.map((rule) => testMethodLabels[rule] || rule).join('、')),
							row.scope_reason ? h('p', null, row.scope_reason) : null,
							(row.coverage_targets || []).length ? h('details', { className: 'cts-item-m' },
								h('summary', null, `为什么测 · ${row.coverage_targets.length} 个覆盖目标`),
								row.coverage_targets.map((target) => h('p', { key: target.output_id },
									`${target.dimension} · ${target.rule_id}@${target.rule_revision} · 判据依据 ${(target.oracle_refs || []).join('、') || '缺'} · ${target.formal_eligibility}`))) : null,
							row.deferral ? h('p', null, row.deferral.reason + ' · ' + row.deferral.owner) : null,
							h('div', { className: 'cts-filter' }, row.contract_refs.map((id) => h('button', { key: id, className: 'cts-btn', onClick: () => onOpen('model', id) }, '查看需求')),
								row.point_id ? button('查看测试点', () => onJump('points', row.point_id)) : null,
								(row.state === 'case_missing' || row.state === 'case_incomplete' || (row.state === 'missing' && data.points_current && (row.budget_exceeded || row.omitted || row.classification === 'needs_evidence'))) && !data.stale ? button('登记延期', () => setDelay({ scenario_id: row.scenario_id, point_id: row.point_id, reason: '', impact: '', owner: '', reviewer })) : null),
							delay?.scenario_id === row.scenario_id ? h('div', { className: 'cts-filter' },
								[['reason', '延期原因'], ['impact', '影响范围'], ['owner', '责任人'], ['reviewer', '评审人']].map(([key, title]) => h('label', { key }, title, h('input', { value: delay[key], onChange: (event) => setDelay({ ...delay, [key]: event.target.value }) }))),
								button('确认延期', () => apply('deferral.save', { ...delay, outline_digest: data.digest }), disabled)) : null))) : null;
				}),
				outside.length ? h(ModelBranch, { title: '本轮范围外', meta: String(outside.length) }, outside.map((item) => h('p', { key: item.id }, item.name))) : null);
		}
		const testMethodLabels = { baseline: '需求行为', boundary: '边界值', transition: '状态迁移', combination: '组合条件',
			exception: '异常处理', timeout: '时序与超时', recovery: '恢复', permission: '权限', interaction: '联动' };

		function RightPanel(props) {
			const scopedQuestions = (props.questions?.items || []).filter((item) => (item.scope || 'design') === props.mode);
			const openQuestions = scopedQuestions.filter((item) => item.status === 'open').length;
			const modelLists = [['features', '功能点'], ['states', '状态'], ['facts', '事实']];
			const inModel = props.mode === 'ecsm' && (props.tab === 'model' || modelLists.some(([key]) => key === props.tab));
			const activeTab = inModel ? 'model' : props.tab;
			const modelTab = props.tab === 'model' ? props.modelSection : props.tab;
			const tabs = props.mode === 'ecsm'
				? [['model', '产品模型'], ['conflicts', '需求裁决'], ['bindings', '确认绑定'], ['questions', `待回答 ${openQuestions}`]]
				: [['outline', '测试大纲'], ['points', '测试点'], ['cases', '用例'], ['bindings', `绑定 ${(props.bindings?.items || []).filter((item) => item.status === 'bound').length}`], ['questions', `待回答 ${openQuestions}`], ['issues', `问题 ${props.issuesState?.total || 0}`]];
			const selectModelTab = (key) => {
				if (key === modelTab) return;
				if (key === 'contracts' || key === 'tree') {
					if (props.tab !== 'model') props.setTab('model');
					props.setModelSection(key);
				} else props.setTab(key);
			};
			return h('section', { className: 'cts-workspace' },
				h('nav', { className: 'cts-tabs', 'aria-label': '产物导航' }, tabs.map(([key, label]) =>
					h('button', { key, className: `cts-tab${activeTab === key ? ' on' : ''}`,
						'aria-pressed': activeTab === key, onClick: () => {
							if (key !== 'model') props.setTab(key);
							else if (!inModel) props.onOpen('model');
						} }, label))),
				inModel ? h('nav', { className: 'cts-tabs cts-model-tabs', 'aria-label': '产品模型内容' },
					h('span', { className: 'cts-model-tabs-label' }, '模型内容'),
					[['contracts', '需求合同'], ['tree', '模型树与问题'], ...modelLists].map(([key, label]) =>
						h('button', { key, className: `cts-tab${modelTab === key ? ' on' : ''}`,
							'aria-pressed': modelTab === key, onClick: () => selectModelTab(key) }, label))) : null,
				props.tab === 'outline' ? h(OutlinePanel, props) : props.tab === 'conflicts' ? h(ConflictPanel, { ...props, contracts: props.ecsmModel?.model?.inputs?.contracts?.items || [], onSaved: props.refreshAll }) : h(ArtifactPanel, props));
		}

		function ArtifactPanel({ artifacts, tab, setTab, onOpen, moduleId, refreshAll, generate, genBusy, phase, lintState, onClear, selected, setSelected, reviewState, onSave, onRegenerate, onDelete, onApprove, onBatchReview, itemBusy, bindings, bindingBusy, onSuggestBindings, onConfirmBinding, onManualBinding, issuesState, questions, onAnswerQuestion, onDismissQuestion, onDismissAll, agentsDoc, agentBusy, onRunAgent, mode, onExportEcsm, onReloadEcsm, onLoadVersion, ecsmModel, modelSection, setModelSection, contractTarget, projectId, onImages, onImpact, onJump, onRepair, onSaveContract, onApproveContracts, locked, projectQuality, onQuickQualityChange, onOpenIncrementalImpact }) {
			const [query, setQuery] = React.useState('');
			const [filter, setFilter] = React.useState('');
			const [page, setPage] = React.useState(0);
			const [scroll, setScroll] = React.useState(0);
			const [checked, setChecked] = React.useState([]);
			const [showClosedLoop, setShowClosedLoop] = React.useState(false);
			const panelRef = React.useRef(null);
			React.useEffect(() => { if (panelRef.current) panelRef.current.scrollTop = scroll; }, [selected]);
			React.useEffect(() => { setQuery(''); setFilter(''); setPage(0); setScroll(0); setChecked([]); }, [tab]);
			const batchable = tab === 'points' || tab === 'cases';
			const toggleChecked = (id) => setChecked((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
			const gaps = artifacts.delivery?.gaps || {};
			const pointQuality = artifacts.pointQuality || {};

			const counts = {
				states: (artifacts.states?.items || []).length,
				features: (artifacts.features?.items || []).length,
				facts: (artifacts.facts?.items || []).length,
				points: (artifacts.points?.items || []).length,
				cases: (artifacts.cases?.items || []).length
			};
			const bindingItems = bindings?.items || [];
			const bindingStats = {
				bound: bindingItems.filter((item) => item.status === 'bound').length,
				pending: bindingItems.filter((item) => item.status === 'ambiguous' || item.status === 'unmatched').length
			};
			const scopedQuestions = (questions?.items || []).filter((item) => (item.scope || 'design') === mode);
			const openQuestions = scopedQuestions.filter((item) => item.status === 'open').length;
			const items = tab === 'bindings' ? bindingItems : tab === 'issues' ? (issuesState?.issues || []) : tab === 'questions' ? scopedQuestions : (artifacts[tab]?.items || []);
			const idField = tab === 'features' ? 'feature_id' : tab === 'states' ? 'feature_id' : tab === 'facts' ? 'fact_id' : tab === 'bindings' ? 'binding_id' : tab === 'points' ? 'point_id' : 'case_id';

			if (tab === 'model') {
				return h(EcsmView, { state: ecsmModel, generate, genBusy, contractTarget, section: modelSection, setSection: setModelSection, onExport: onExportEcsm, onReload: onReloadEcsm, onLoadVersion, projectId, moduleId, locked, onJump: (_, id) => onOpen('model', id), onRepair, onConfirm: onConfirmBinding, onManual: onManualBinding, onImpact, onSaveContract, onApproveContracts });
			}

			if (tab === 'questions') {
				const list = scopedQuestions;
				return h('div', { className: 'cts-right' },
					h('div', { className: 'cts-h' }, h('b', null, '待回答')),
					mode === 'ecsm' ? h('div', { className: 'cts-actions' }, h('button', { className: 'cts-btn', onClick: onExportEcsm }, '导出 ECSM')) : null,
					h('div', { className: 'cts-actions' },
						h('button', { className: 'cts-btn', disabled: openQuestions === 0, onClick: onDismissAll }, `全部忽略（${openQuestions}）`)),
					h('div', { className: 'cts-cov' }, `共 ${list.length} 条 · 未回答 ${openQuestions}`),
					h('div', { className: 'cts-list' },
						list.length === 0
							? h('div', { className: 'cts-hint' }, '没有待回答问题。跑完一轮生成后会自动汇总。')
							: list.map((question) => h(QuestionRow, { key: question.id, question, onAnswer: onAnswerQuestion, onDismiss: onDismissQuestion }))));
			}

			if (tab === 'issues') {
				const sources = issuesState?.bySource || {};
				return h('div', { className: 'cts-right' },
					h('div', { className: 'cts-h' }, h('b', null, '问题清单')),
					h('div', { className: 'cts-cov' }, `共 ${issuesState?.total || 0} 条 · 错误 ${issuesState?.bySeverity?.error || 0} · 警告 ${issuesState?.bySeverity?.warning || 0}`),
					h('div', { className: 'cts-cov' }, `来源：linter ${sources.lint || 0} · 状态机 ${sources.state || 0} · 绑定 ${sources.binding || 0} · 审查 ${sources.review || 0}`),
					issuesState?.reviewStale ? h('div', { className: 'cts-lint' }, '审查结果基于旧版用例，建议重跑审查') : null,
					h('div', { className: 'cts-actions' },
						h('button', { className: 'cts-btn', disabled: agentBusy !== '', onClick: () => onRunAgent('facts') }, agentBusy === 'facts' ? '复核中…' : '事实复核'),
						h('button', { className: 'cts-btn', disabled: agentBusy !== '', onClick: () => onRunAgent('cases') }, agentBusy === 'cases' ? '复核中…' : '用例复核')),
					agentsDoc
						? h('div', { className: 'cts-cov' }, `复核（${agentsDoc.kind}）：检查 ${agentsDoc.checked} 条 · 发现 ${(agentsDoc.findings || []).length} 个`)
						: null,
					(agentsDoc?.findings || []).length > 0
						? h('div', { className: 'cts-list', style: { marginBottom: 8 } },
							(agentsDoc.findings || []).slice(0, 10).map((finding, index) => h('div', { className: 'cts-item', key: `agent-${index}` },
								h('div', { className: 'cts-item-t' }, `● ${finding.code || finding.verdict || 'findings'}`),
								h('div', { className: 'cts-item-s' }, finding.message),
								h('div', { className: 'cts-item-m' }, `${finding.ref || ''} ${(finding.evidence_refs || []).join(' ')}`))))
						: null,
					h('div', { className: 'cts-list' },
						(issuesState?.issues || []).length === 0
							? h('div', { className: 'cts-hint' }, '没有问题')
							: (issuesState?.issues || []).slice(0, 80).map((issue, index) => h('div', { className: 'cts-item', key: index },
								h('div', { className: 'cts-item-t' }, `${issue.severity === 'error' ? '●' : '○'} ${issue.code}`),
								h('div', { className: 'cts-item-s' }, issue.message),
								(artifacts.cases?.items || []).some((item) => item.case_id === issue.ref)
									? h('button', { className: 'cts-btn', onClick: () => onJump('cases', issue.ref) }, '打开 ' + issue.ref)
									: h('div', { className: 'cts-item-m' }, `${issue.source}${issue.ref ? ' · ' + issue.ref : ''}`)))));
			}

			if (tab === 'bindings') {
				return h('div', { className: 'cts-right' },
					h('div', { className: 'cts-h' }, h('b', null, '绑定')),
					h('div', { className: 'cts-actions' },
						h('button', { className: 'cts-btn', onClick: onSuggestBindings, disabled: bindingBusy }, bindingBusy ? '匹配中…' : '自动匹配'),
						h('button', { className: 'cts-btn', onClick: () => setTab(mode === 'ecsm' ? 'facts' : 'points') }, mode === 'ecsm' ? '回到事实' : '回到测试点')),
					h('div', { className: 'cts-cov' }, `已绑定 ${bindingStats.bound} · 待确认 ${bindingStats.pending}`),
					h('div', { className: 'cts-list' },
						bindingItems.length === 0
							? h('div', { className: 'cts-hint' }, '还没有绑定。先「自动匹配」，再把待确认的逐条定下来。')
							: bindingItems.map((item) => h(BindingRow, { key: item.binding_id, item, onConfirm: onConfirmBinding, onManual: onManualBinding, busy: bindingBusy }))));
			}

			let detail = null;
			if (selected && selected.kind === tab) {
				const item = items.find((entry) => entry[idField] === selected.id);
				if (item && !FIELDS[tab]) {
					const feature = (ecsmModel?.model?.features || []).find((entry) => entry.feature_id === item.feature_id);
					detail = h('div', { className: 'cts-right', key: item[idField] },
						h('button', { className: 'cts-btn', onClick: () => setSelected(null) }, '返回列表'),
						h('h2', null, item.name || item.feature_id),
						h('p', null, item.summary || feature?.summary),
						(feature?.facts || []).map((fact) => h('button', { key: fact.fact_id, className: 'cts-btn', onClick: () => { setTab('facts'); setSelected({ kind: 'facts', id: fact.fact_id }); } }, fact.fact_id)),
						(feature?.transitions || []).map((entry) => h('div', { className: 'cts-item', key: entry.transition_id },
							h('div', null, `${entry.from} → ${entry.to} · ${entry.trigger}`),
							h('button', { className: 'cts-btn', onClick: () => onImpact('transition_id', entry.transition_id) }, '查看影响范围'))),
						(feature?.issues || []).map((issue, index) => h('p', { key: index, className: 'cts-lint' }, issue.message)));
				} else if (item) {
					detail = h('div', { className: 'cts-right', key: item[idField] },
						h(DetailEditor, {
							key: item[idField], kind: tab, onJump, onOpen,
							item, gaps: gaps[item.case_id] || [], quality: pointQuality[item.point_id] || [],
							projectId, moduleId, locked, onVariantGenerated: refreshAll, onImages, onImpact,
							onClose: () => setSelected(null),
							onSave: (patch) => onSave(tab, item[idField], patch),
							onRegenerate: () => onRegenerate(tab, item[idField]),
							onDelete: () => onDelete(tab, item[idField]),
							onApprove: (status) => onApprove(tab, item[idField], status),
							busy: itemBusy
						}));
				}
			}

			const row = (item, key) => {
				const onClick = () => { setScroll(panelRef.current?.scrollTop || 0); setSelected({ kind: tab, id: item[idField] }); };
				const flag = item.review_status === 'approved' ? ' ✓' : item.review_status === 'rejected' ? ' ✕' : '';
				const pick = batchable ? h('input', { type: 'checkbox', className: 'cts-item-pick', checked: checked.includes(item[idField]),
					'aria-label': `选择 ${item[idField]}`, onClick: (event) => event.stopPropagation(), onChange: () => toggleChecked(item[idField]) }) : null;
				if (tab === 'states') {
					const issues = (item.issues || []).length;
					return h('div', { className: 'cts-item', key, onClick, role: 'button', 'aria-current': selected?.id === item[idField], tabIndex: 0, onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); } }, style: { cursor: 'pointer' } },
						h('div', { className: 'cts-item-t' }, `${item.feature_id} ${item.name || ''}${issues > 0 ? ` ⚠${issues}` : ''}`),
						h('div', { className: 'cts-item-s' }, `${(item.states || []).length} 状态 · ${(item.transitions || []).length} 转移`),
						h('div', { className: 'cts-item-m' }, (item.states || []).map((state) => state.name).join(' / ').slice(0, 60)));
				}
				if (tab === 'features') {
					return h('div', { className: 'cts-item', key, onClick, role: 'button', 'aria-current': selected?.id === item[idField], tabIndex: 0, onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); } }, style: { cursor: 'pointer' } },
						h('div', { className: 'cts-item-t' }, `${item.feature_id || ''} ${item.name || ''}${flag}`),
						h('div', { className: 'cts-item-s' }, item.summary || ''),
						h('div', { className: 'cts-item-m' }, `${(item.fact_refs || []).length} 条事实`));
				}
				if (tab === 'facts') {
					return h('div', { className: 'cts-item', key, onClick, role: 'button', 'aria-current': selected?.id === item[idField], tabIndex: 0, onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); } }, style: { cursor: 'pointer' } },
						h('div', { className: 'cts-item-t' }, `${item.statement || '…'}${flag}`),
						h('div', { className: 'cts-item-m' }, `${item.type || ''} · ${(item.evidence_refs || []).join(' ')}`));
				}
				if (tab === 'points') {
					return h('div', { className: 'cts-item', key, onClick, role: 'button', 'aria-current': selected?.id === item[idField], tabIndex: 0, onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); } }, style: { cursor: 'pointer' } },
						pick,
						h('div', { className: 'cts-item-t' }, `${item.priority || ''} ${item.requirement || ''}${flag}`),
						h('div', { className: 'cts-item-s' }, `条件：${item.condition || ''}`),
						h('div', { className: 'cts-item-m' }, [item.point_id, ...(item.fact_refs || []), pointQuality[item.point_id]?.length ? '待核对质量' : ''].filter(Boolean).join(' · ')));
				}
				return h('div', { className: 'cts-item', key, onClick, role: 'button', 'aria-current': selected?.id === item[idField], tabIndex: 0, onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); } }, style: { cursor: 'pointer' } },
					pick,
					h('div', { className: 'cts-item-t' }, `${item.priority || ''} ${item.title || '…'}${flag}`),
					h('div', { className: 'cts-item-s' }, `预期：${(item.expected || '').slice(0, 90)}`),
					h('div', { className: 'cts-item-m' }, `${item.point_id || ''} · ${(item.steps || []).length} 步 · ${gaps[item.case_id]?.length ? '待补界面图' : item.image_refs?.some((f) => f.role !== '信号参考') ? '有界面图' : item.image_refs?.length ? '信号参考' : '无配图'}`));
			};

			const findings = reviewState?.items || [];
			const search = query.trim().toLowerCase();
			const filtered = items.filter((item) => {
				if (filter === 'pending' && item.review_status === 'approved') return false;
				if (filter === 'gaps' && !gaps[item.case_id]?.length) return false;
				if (filter === 'quality' && !pointQuality[item.point_id]?.length) return false;
				return !search || [item[idField], item.feature_id, item.title, item.name, item.statement, item.requirement]
					.some((value) => String(value || '').toLowerCase().includes(search));
			});
			const pages = Math.max(1, Math.ceil(filtered.length / 40));
			const currentPage = Math.min(page, pages - 1);
			const pageItems = filtered.slice(currentPage * 40, (currentPage + 1) * 40);
			const pageIds = pageItems.map((item) => item[idField]);
			const allPicked = pageItems.length > 0 && pageItems.every((item) => checked.includes(item[idField]));
			const runBatch = async (status, scope = 'selected') => {
				if (scope === 'selected' && !checked.length) return;
				const result = await onBatchReview(tab, scope === 'selected' ? checked : [], status, scope);
				setChecked((result.blocked || []).map((entry) => entry.id));
			};
			const clCov = artifacts.points?.closed_loop_coverage || null;
			const clTotal = clCov?.cells?.length || 0;
			const clCovered = clCov?.covered_cells?.length || 0;
			const clMissing = clCov?.missing_cells?.length || 0;
			const approvedCount = items.filter((item) => item.review_status === 'approved').length;
			const droppedPoints = artifacts.delivery?.droppedPoints || [];
			const curCovMode = projectQuality?.coverage_mode === 'exhaustive' ? 'exhaustive' : 'standard';
			const hasFrozenOutline = Boolean(ecsmModel?.current && !ecsmModel.drifted && artifacts.outlineStatus?.status === 'approved');
			return h('div', { className: 'cts-records' + (detail ? ' selected' : '') },
				h('div', { className: 'cts-right', ref: panelRef },
				h('div', { className: 'cts-h' },
					h('b', null, ({ features: '功能点', states: '状态', facts: '事实', points: '测试点', cases: '用例' })[tab]),
					tab === 'points' ? h('span', { className: 'cts-pill info' }, curCovMode === 'exhaustive' ? '全量展开' : '标准粒度') : null,
					batchable && items.length ? h('span', { className: `cts-pill ${approvedCount === items.length ? 'ok' : ''}` }, `已批准 ${approvedCount}/${items.length}`) : null,
					FIELDS[tab] ? h('button', { className: 'cts-btn', style: { marginLeft: 'auto', padding: '2px 8px', fontSize: 11 }, onClick: () => onClear(tab), disabled: counts[tab] === 0 }, '重置') : null),
				tab === 'points' ? h('div', { className: 'cts-summary-strip' },
					h('span', { className: 'cts-hint' }, '展开粒度'),
					h('select', {
						className: 'cts-select',
						style: { padding: '2px 6px', fontSize: 11.5 },
						disabled: Boolean(genBusy) || locked || !onQuickQualityChange,
						value: curCovMode,
						onChange: (event) => onQuickQualityChange?.({ coverage_mode: event.target.value })
					},
						h('option', { value: 'standard' }, '标准（等价类/边界）'),
						h('option', { value: 'exhaustive' }, '全量展开（逐枚举/受限矩阵）')),
					clTotal > 0 ? h('button', {
						className: `cts-pill ${clMissing === 0 ? 'ok' : 'warn'}`,
						onClick: () => setShowClosedLoop((v) => !v)
					}, `闭环覆盖 ${clCovered}/${clTotal}${clMissing ? `（缺 ${clMissing}）` : ' ✓'}`) : null,
					h('button', { className: 'cts-pill', onClick: () => setTab('bindings') }, `绑定 ${bindingStats.bound} · 待核 ${bindingStats.pending}`),
					counts.facts > 0 && !locked ? h('button', {
						className: 'cts-btn primary',
						style: { marginLeft: 'auto', padding: '3px 10px', fontSize: 11.5 },
						disabled: Boolean(genBusy),
						onClick: () => generate('points', items.length > 0, undefined, undefined, hasFrozenOutline ? undefined : 'facts')
					}, items.length ? (hasFrozenOutline ? '按大纲重生成测试点' : '按事实重生成测试点') : (hasFrozenOutline ? '按大纲生成测试点' : '从事实生成测试点')) : null) : null,
				tab === 'points' && showClosedLoop && clCov ? h('details', { className: 'cts-findings', open: true },
					h('summary', null, `全局闭环覆盖明细 · ${clCovered}/${clTotal} 已覆盖 · 排除入口 ${(clCov.excluded_entries || []).length}`),
					(clCov.missing_cells || []).length > 0
						? clCov.missing_cells.map((cell) => h('div', { className: 'cts-finding', key: cell.cell_id }, `缺口 · ${cell.entry_label} × ${cell.branch_label}（${(cell.required_fact_refs || []).join('、')}）`))
						: h('div', { className: 'cts-finding' }, '全部适用入口 × 结果分支均已 100% 覆盖。')) : null,
				tab === 'points' && items.length ? h('p', { className: 'cts-hint', style: { margin: '2px 0 4px' } }, artifacts.points?.source_ecsm_version
					? `依据 ECSM v${artifacts.points.source_ecsm_version}${ecsmModel?.drifted || artifacts.delivery?.pointsStale ? ' · 当前模型有变化，需重新生成' : ''}`
					: `快速事实轨生成 · 依据当前产品事实（${counts.facts} 条）`) : null,
				tab === 'cases' ? h('div', { className: 'cts-summary-strip' },
					h('span', { className: `cts-pill ${approvedCount === items.length && items.length > 0 ? 'ok' : 'info'}` }, `已批准 ${approvedCount}/${items.length}`),
					artifacts.delivery?.missingCases > 0 ? h('span', { className: 'cts-pill warn' }, `待生成 ${artifacts.delivery.missingCases} 点`) : null,
					droppedPoints.length > 0 ? h('span', { className: 'cts-pill err' }, `门禁退回 ${droppedPoints.length} 点`) : null,
					Object.keys(gaps).length > 0 ? h('span', { className: 'cts-pill warn' }, `待补图 ${Object.keys(gaps).length}`) : null,
					items.length > 0 && !locked && onOpenIncrementalImpact ? h('button', { className: 'cts-pill', disabled: Boolean(genBusy), onClick: () => onOpenIncrementalImpact('') }, '变更增量重跑') : null,
					counts.points > 0 && !locked && (items.length === 0 || artifacts.delivery?.missingCases > 0) ? h('button', {
						className: 'cts-btn primary',
						style: { marginLeft: 'auto', padding: '3px 10px', fontSize: 11.5 },
						disabled: Boolean(genBusy),
						onClick: () => generate('cases', items.length === 0 ? true : false, undefined, undefined, artifacts.points?.source_ecsm_version ? undefined : 'facts')
					}, items.length ? `补齐剩余 ${artifacts.delivery?.missingCases || ''} 条用例` : '生成测试用例') : null) : null,
				tab === 'cases' && artifacts.delivery?.failedPoints?.length ? (() => {
					const failed = artifacts.delivery.failedPoints;
					return h('div', { className: 'cts-lint', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
						h('span', null, `生成失败 ${failed.length} 个测试点：${failed.slice(0, 3).map((entry) => `${entry.point_id}（${String(entry.error || '').slice(0, 60)}）`).join('、')}${failed.length > 3 ? ' 等' : ''}`),
						h('button', { className: 'cts-btn', disabled: Boolean(genBusy), onClick: () => generate('cases', false, undefined, failed.map((entry) => entry.point_id), artifacts.points?.source_ecsm_version ? undefined : 'facts') }, '重试失败点'));
				})() : null,
				tab === 'cases' && droppedPoints.length > 0 ? h('details', { className: 'cts-findings' },
					h('summary', null, `门禁退回候选（${droppedPoints.length} 个测试点未生成用例）`),
					h('div', { className: 'cts-filter', style: { margin: '6px 0' } },
						h('button', { className: 'cts-btn', disabled: Boolean(genBusy), onClick: () => generate('cases', false, undefined, droppedPoints.map((d) => d.point_id), artifacts.points?.source_ecsm_version ? undefined : 'facts') }, '一键重试全部退回点')),
					droppedPoints.map((entry) => h('div', { className: 'cts-finding', key: entry.point_id },
						h('button', { className: 'cts-btn', style: { padding: '1px 6px', fontSize: 11, marginRight: 6 }, onClick: () => onJump('points', entry.point_id) }, entry.point_id),
						`${entry.reason}${entry.messages?.length ? ' · ' + entry.messages.join('；') : ''}`))) : null,
				['points', 'cases'].includes(tab) ? h(AgentReviewPanel, { key: tab, projectId, moduleId, stage: tab, locked,
					fastTrack: !artifacts.points?.source_ecsm_version,
					revision: artifacts[tab]?.version, onSaved: refreshAll, onLocate: (id) => setSelected({ kind: tab, id }),
					objects: items.map((item) => ({ id: item[idField], title: item.title || item.requirement, point_id: item.point_id })) }) : null,
				lintState?.errorCount > 0 ? h('div', { className: 'cts-lint' }, `校验发现 ${lintState.errorCount} 处问题`) : null,
				tab === 'cases' && items.length ? h(CaseReviewImport, { projectId, moduleId, onSaved: refreshAll }) : null,
				tab === 'cases' && findings.length ? h('details', { className: 'cts-findings' },
					h('summary', null, `独立审查发现 ${findings.length} 条`),
					findings.map((finding, index) => h('div', { className: 'cts-finding', key: index },
						finding.case_id ? h('button', { className: 'cts-btn', onClick: () => setSelected({ kind: 'cases', id: finding.case_id }) }, finding.case_id) : null,
						' ' + finding.message))) : null,
				h('div', { className: 'cts-filter' },
					h('input', { className: 'cts-input', type: 'search', value: query, 'aria-label': '搜索产物', placeholder: '搜索名称、编号或功能点', onChange: (event) => { setQuery(event.target.value); setPage(0); } }),
					FIELDS[tab] ? h('select', { className: 'cts-select', value: filter, 'aria-label': '筛选产物', onChange: (event) => { setFilter(event.target.value); setPage(0); } },
						h('option', { value: '' }, '全部'),
						h('option', { value: 'pending' }, '待评审'),
						tab === 'points' ? h('option', { value: 'quality' }, `待核对质量（${Object.keys(pointQuality).length}）`) : null,
						tab === 'cases' ? h('option', { value: 'gaps' }, '待补界面图') : null) : null,
					h('span', { className: 'cts-hint' }, `${filtered.length} 条`)),
				batchable && items.length ? h('div', { className: 'cts-filter' },
					h('label', null, h('input', { type: 'checkbox', checked: allPicked,
						onChange: (event) => setChecked(event.target.checked
							? [...new Set([...checked, ...pageIds])]
							: checked.filter((id) => !pageIds.includes(id))) }), ' 全选本页'),
					h('span', { className: 'cts-hint' }, `已选 ${checked.length}`),
					h('button', { className: 'cts-btn', disabled: !checked.length || itemBusy || locked, onClick: () => runBatch('approved', 'selected') }, '批准选中'),
					h('button', { className: 'cts-btn', disabled: !checked.length || itemBusy || locked, onClick: () => runBatch('rejected', 'selected') }, '退回选中'),
					approvedCount < items.length ? h('button', { className: 'cts-btn primary', disabled: itemBusy || locked, onClick: () => runBatch('approved', 'all_pending') }, `一键批准全部符合门禁项（${items.length - approvedCount}）`) : null) : null,
				h('div', { className: 'cts-list' },
					filtered.length === 0 ? h('div', { className: 'cts-hint' }, items.length ? '没有匹配项，试试其他搜索条件。' : '暂无内容。可以从上方生成对应产物。')
						: pageItems.map((item, index) => row(item, item[idField] || index))),
				pages > 1 ? h('div', { className: 'cts-filter' },
					h('button', { className: 'cts-btn', disabled: currentPage === 0, onClick: () => { setPage(currentPage - 1); panelRef.current?.scrollTo(0, 0); } }, '上一页'),
					h('span', null, `${currentPage + 1} / ${pages}`),
					h('button', { className: 'cts-btn', disabled: currentPage + 1 >= pages, onClick: () => { setPage(currentPage + 1); panelRef.current?.scrollTo(0, 0); } }, '下一页')) : null), detail);
		}

		function Delivery({ packages, ecsmModel, artifacts, projectId, moduleId, exportCases, exportCandidate, busy, report, openCases, onOpen, blocker, nextState, projectQuality, onQuickQualityChange }) {
			const [exporting, setExporting] = React.useState(false);
			const [coverage, setCoverage] = React.useState(null);
			const [diff, setDiff] = React.useState(null);
			const [agentSummary, setAgentSummary] = React.useState(null);
			const [summarizing, setSummarizing] = React.useState(false);
			const [exportTemplate, setExportTemplate] = React.useState(projectQuality?.export_template || 'standard');
			const [customColsText, setCustomColsText] = React.useState(() => formatCustomExportColumns(projectQuality?.export_columns || [
				{ key: 'case_id', label: '用例编号' },
				{ key: 'module', label: '模块' },
				{ key: 'title', label: '用例标题' },
				{ key: 'priority', label: '优先级' },
				{ key: 'precondition', label: '前置条件' },
				{ key: 'steps', label: '步骤' },
				{ key: 'expected', label: '预期结果' },
				{ key: 'signals', label: '信号' }
			]));
			const [lastDownloads, setLastDownloads] = React.useState([]);
			React.useEffect(() => {
				if (projectQuality?.export_template) setExportTemplate(projectQuality.export_template);
				if (Array.isArray(projectQuality?.export_columns) && projectQuality.export_columns.length) {
					setCustomColsText(formatCustomExportColumns(projectQuality.export_columns));
				}
			}, [projectQuality?.export_template, projectQuality?.export_columns]);
			const currentExportOptions = () => ({
				export_template: exportTemplate,
				...(exportTemplate === 'custom' ? { export_columns: parseCustomExportColumns(customColsText) } : {})
			});
			const saveExportTemplate = async () => {
				if (!onQuickQualityChange) return;
				await onQuickQualityChange(currentExportOptions());
			};
			const summarize = async () => {
				setSummarizing(true);
				try { setAgentSummary(await request('agent.review.deliverySummary', { project: projectId, module: moduleId })); }
				catch (error) { report(error.message); }
				finally { setSummarizing(false); }
			};
			React.useEffect(() => {
				let active = true;
				request('outline.view', { project: projectId, module: moduleId }).then((data) => { if (active) setCoverage(data); }).catch(() => {});
				return () => { active = false; };
			}, [projectId, moduleId]);
			const compare = async (from) => {
				try { setDiff(await request('package.diff', { project: projectId, module: moduleId, from, to: packages.current?.package_id })); }
				catch (err) { report(err.message); }
			};
			const status = artifacts.delivery || {};
			const latest = ecsmModel?.current;
			const count = artifacts.cases?.items?.length || 0;
			const imageGaps = status.casesStale || ecsmModel?.drifted ? {} : status.scopedGaps || status.gaps || {};
			const gaps = Object.keys(imageGaps).length;
			const handleDraftExport = async () => {
				const state = await exportCases(currentExportOptions());
				if (state?.download_url) {
					setLastDownloads([{ key: 'xlsx', label: '草稿 Excel', name: state.name || '用例.xlsx', url: state.download_url }]);
					triggerDownload(state.download_url, state.name || '用例.xlsx');
				}
			};
			const handleCandidateExport = async () => {
				const state = await exportCandidate(currentExportOptions());
				if (state?.downloads?.length) setLastDownloads(state.downloads);
				if (state?.download_url) triggerDownload(state.download_url, '用例.xlsx');
			};
			const exportPackage = async (item) => {
				setExporting(true);
				try {
					const state = await request('package.export', { project: projectId, module: moduleId, package_id: item.package_id, bundle: true, ...currentExportOptions() });
					if (state?.downloads?.length) setLastDownloads(state.downloads);
					if (state?.download_url) triggerDownload(state.download_url, '用例.xlsx');
					report(`已导出交付包 ${item.package_id}（${state.count} 条）并触发下载`);
				} catch (err) { report(err.message); }
				finally { setExporting(false); }
			};
			return h('section', { className: 'cts-workspace' },
				h('div', { className: 'cts-right' },
					h('h2', null, '交付检查'),
					nextState?.next_action && nextState.next_action.id !== 'delivery' ? h('div', { className: 'cts-flow-next' },
						h('span', null, `工作台下一步：${nextState.next_action.label}`),
						h('button', { className: 'cts-btn', onClick: () => {
							const action = nextState.next_action;
							const target = action.target;
							onOpen(target?.view === 'ecsm' ? 'model' : target?.tab === 'materials' ? 'assets' : target?.tab || 'cases', action.object_id);
						} }, '前往处理')) : null,
					blocker && packages.current?.status !== 'frozen' ? h('div', { className: 'cts-flow-next' },
						h('span', null, blocker.message),
						h('button', { className: 'cts-btn', onClick: () => onOpen(blocker.step) },
							'前往' + ({ model: 'ECSM', outline: '测试大纲', points: '测试点', cases: '用例', issues: '问题清单' })[blocker.step])) : null,
					coverage?.outline ? h('div', { className: 'cts-flow-next' },
						h('div', null, h('strong', null, '本轮覆盖'), h('p', null, `${coverage.rows.filter((row) => row.state === 'covered').length} 项判据齐全 · ${coverage.rows.filter((row) => row.state === 'deferred').length} 项延期 · ${coverage.rows.filter((row) => row.required && !['covered', 'deferred'].includes(row.state)).length} 项待处理`)),
						h('button', { className: 'cts-btn', onClick: () => onOpen('outline') }, '处理覆盖缺口')) : null,
					gaps ? h('div', { className: 'cts-filter' }, Object.keys(imageGaps).slice(0, 10).map((id) =>
						h('button', { key: id, className: 'cts-btn', onClick: () => onOpen('cases', id) }, '补图 ' + id))) : null,
					h('p', null, latest ? `冻结模型 v${latest.version} · ${latest.digest.slice(0, 8)}` : '尚未冻结产品模型'),
					h('ul', null,
						ecsmModel?.drifted ? h('li', null, 'ECSM 有改动，需重新确认并冻结') : null,
						status.pointsStale ? h('li', null, '测试点的模型版本未核对，或已过期') : null,
						count && status.casesStale ? h('li', null, '用例的测试点版本未核对，或已过期') : null,
						status.reviewStale ? h('li', null, '独立审查结果基于旧版用例') : null,
						!status.pointsStale && !ecsmModel?.drifted ? h('li', null, `${status.pointsPending || 0} 个本轮测试点待评审 · ${status.missingCases || 0} 个缺用例`) : null,
						!status.casesStale && !ecsmModel?.drifted ? h('li', null, `${status.casesPending || 0} 条本轮用例待评审 · ${gaps} 条缺界面图`) : null),
					h('div', { className: 'cts-summary-strip' },
						h('span', { className: 'cts-hint' }, 'Excel 列模板'),
						h('select', { className: 'cts-select', value: exportTemplate, onChange: (event) => setExportTemplate(event.target.value) },
							EXPORT_TEMPLATE_OPTIONS.map(([key, label]) => h('option', { key, value: key }, label))),
						onQuickQualityChange ? h('button', { className: 'cts-btn', style: { padding: '3px 9px', fontSize: 11.5 }, onClick: saveExportTemplate }, '设为项目默认') : null),
					exportTemplate === 'custom' ? h('div', { className: 'cts-field', style: { marginBottom: 8 } },
						h('span', { className: 'cts-field-l' }, '自定义列映射（格式：字段键:表头名，逗号分隔；可用字段：case_id, module, feature_id, point_id, title, type, priority, precondition, steps, expected, restore_steps, prepare_detail, signals, images, source_reference, review_conclusion, basis）'),
						h('input', { className: 'cts-input cts-input-sm', value: customColsText, onChange: (event) => setCustomColsText(event.target.value) })) : null,
					h('div', { className: 'cts-actions' },
						h('button', { className: 'cts-btn', onClick: openCases }, '查看用例'),
						coverage?.outline ? h('button', { className: 'cts-btn', disabled: summarizing, onClick: summarize },
							summarizing ? '正在整理…' : '让质量审查 Agent 解读缺口') : null,
						h('button', { className: 'cts-btn primary', disabled: !count || busy, onClick: handleDraftExport }, '导出并下载 Excel'),
						h('button', { className: 'cts-btn', disabled: !count || busy, onClick: handleCandidateExport }, '导出候选包（xlsx/html/json/md）')),
					lastDownloads.length ? h('div', { className: 'cts-summary-strip' },
						h('span', { className: 'cts-pill ok' }, '导出已就绪'),
						lastDownloads.map((item) => h('a', {
							key: item.key,
							className: 'cts-btn',
							style: { textDecoration: 'none', padding: '3px 9px', fontSize: 11.5 },
							href: item.url,
							download: item.name
						}, `下载 ${item.label}`)),
						lastDownloads.find((d) => d.key === 'html') ? h('a', {
							className: 'cts-btn',
							style: { textDecoration: 'none', padding: '3px 9px', fontSize: 11.5 },
							href: lastDownloads.find((d) => d.key === 'html').url + '&inline=1',
							target: '_blank',
							rel: 'noreferrer'
						}, '浏览器预览图文 HTML') : null) : null,
					agentSummary ? h('div', { className: 'cts-item' },
						h('strong', null, `缺口解读 · 大纲 v${agentSummary.versions.outline} · 用例 v${agentSummary.versions.cases}`),
						h(Markdown, { text: agentSummary.summary })) : null,
					h('h2', null, '历史交付包'),
					diff ? h('div', { className: 'cts-item' }, h('strong', null, '与当前版本的差异'),
						diff.changed.length ? diff.changed.map((item) => h('p', { key: item.name }, `${item.name} · ${item.before ?? 0} → ${item.after ?? 0}`)) : h('p', null, '内容一致')) : null,
					packages.packages.length ? packages.packages.map((item) =>
						h('div', { className: 'cts-item', key: item.package_id },
							h('div', { className: 'cts-item-t' }, item.package_id),
							h('div', { className: 'cts-item-m' }, item.ecsm ? `ECSM v${item.ecsm.version} · ${item.artifacts.cases?.count || 0} 条用例` : '旧记录 · 无内容快照'),
							item.ecsm ? h('button', { className: 'cts-btn', disabled: exporting, onClick: () => exportPackage(item) }, '导出 Excel、HTML、JSON、Markdown 与图片') : null,
							packages.current && packages.current.package_id !== item.package_id ? h('button', { className: 'cts-btn', onClick: () => compare(item.package_id) }, '与当前版本比较') : null))
						: h('p', { className: 'cts-hint' }, '完成评审后，可冻结并保留首个交付包。')));
		}

		function Workflow({ counts, ecsm, artifacts, mode, tab, busy, locked, onRun, onOpen, hasAssets, hideNext }) {
			const [tipCollapsed, setTipCollapsed] = React.useState(false);
			const contracts = ecsm?.model?.inputs?.contracts?.items || [];
			const approved = contracts.filter((item) => item.status === 'approved').length;
			const frozen = Boolean(ecsm?.current && !ecsm.drifted);
			const delivery = artifacts.delivery || {};
			const outline = artifacts.outlineStatus;
			const outlineCurrent = frozen && !outline?.stale && outline?.modelDigest === ecsm?.current?.digest;
			const outlineApproved = outlineCurrent && outline?.status === 'approved';
			const fastTrackPoints = counts.points > 0 && artifacts.points?.source_kind === 'facts' && !artifacts.points?.source_ecsm_digest;
			const currentPoints = (counts.points > 0 && outlineApproved && !delivery.pointsStale && artifacts.points?.source_kind === (outline.sourceKind || 'contracts') && Boolean(artifacts.points.source_outline_digest)) || fastTrackPoints;
			const currentCases = counts.cases > 0 && currentPoints && (fastTrackPoints ? !delivery.missingCases : !delivery.casesStale);
			const stage = mode === 'ecsm' ? 'model' : tab === 'cases' ? 'cases' : tab === 'outline' ? 'outline' : 'points';
			const steps = [
				['model', '核对需求', counts.facts ? (approved ? `${approved}/${contracts.length} 合同` : `${counts.facts} 条事实`) : '待整理'],
				['outline', '测试大纲', outline === undefined ? '可选' : !outline ? '可选' : !outlineCurrent ? '待更新' : outlineApproved ? '已批准' : '待评审'],
				['points', '测试点', counts.points ? `${counts.points} 条 · ${delivery.pointsPending || 0} 待审` : '待生成'],
				['cases', '测试用例', counts.cases ? `${counts.cases} 条 · ${delivery.casesPending || 0} 待审` : '待生成']
			];
			const preparation = [
				['evidence', '构建证据', counts.evidence, true, onRun.evidence],
				['facts', '生成事实', counts.facts, counts.evidence > 0, () => onRun.generate('facts')],
				['features', '归并功能点', counts.features, counts.facts > 0, () => onRun.generate('features')],
				['states', '推导状态', counts.states, counts.features > 0, () => onRun.generate('states')]
			];
			const missing = preparation.slice(0, 3).find(([, , count]) => !count);
			let next;
			if (!ecsm) {
				next = ['正在读取进度…'];
			} else if (locked) {
				next = ['交付包已冻结', '如需继续编辑，可在交付页派生新版本。', '查看交付', () => onOpen('delivery')];
			} else if (stage !== 'model' && !counts.facts && !approved) {
				next = ['先提取产品事实', '先在 ECSM 构建证据并生成事实，之后可直接快速生成测试点或走合同大纲受控流程。', '去 ECSM', () => onOpen('model')];
			} else if (stage === 'model') {
				if (!hasAssets && !counts.evidence && !contracts.length) {
					next = ['先添加项目资料', '上传 PRD / 信号矩阵 / 设计稿即可开始。', '添加资料', () => onOpen('assets')];
				} else if (missing && !contracts.length) {
					next = ['准备上游资料', '先解析资料并整理产品事实与功能点。', missing[1], missing[4]];
				} else if (!approved && !frozen) {
					next = ['快速轨已就绪，或继续受控合同流', `已有 ${counts.facts} 条事实：可直接去测试点页快速生成（自动启用闭环与展开规则），也可在此确认合同并冻结 ECSM。`, '快速生成测试点', () => onOpen('points')];
				} else if (!frozen) {
					next = ['冻结本轮产品模型', `已确认 ${approved} 条合同，冻结后即可进入受控测试大纲。`, '冻结产品模型', onRun.freeze];
				} else {
					next = [`模型 v${ecsm.current.version} 已冻结`, `${approved} 条已确认合同可用于测试设计。`, '去测试大纲', () => onOpen('outline')];
				}
			} else if (stage === 'outline' && !outlineApproved) {
				next = !outline || !outlineCurrent || outline.rebuild
					? [outline ? '更新测试大纲' : '生成测试大纲（受控轨）', '受控审计轨按已确认合同生成大纲；日常快速迭代可直接切到「测试点」按事实生成。']
					: ['评审并批准大纲', '核对场景后批准大纲，即可按大纲生成测试点。'];
			} else if (!currentPoints) {
				next = ['生成测试点', outlineApproved
					? '已批准受控大纲，可按大纲生成本轮测试点。'
					: `快速轨就绪（${counts.facts} 条事实）：直接生成测试点并启用全局闭环与展开粒度控制。`,
					outlineApproved ? '按大纲生成测试点' : '从事实生成测试点',
					() => onRun.generate('points', true, undefined, undefined, outlineApproved ? undefined : 'facts')];
			} else if (delivery.pointsPending) {
				next = ['核对并批准测试点', `还有 ${delivery.pointsPending} 条待评审（可在测试点页「一键批准全部符合门禁项」）。`, '查看测试点',
					() => onOpen('points', artifacts.points.items.find((item) => item.review_status !== 'approved')?.point_id)];
			} else if (stage === 'points') {
				next = ['测试点已全部批准', '下一步展开为可执行结构化测试用例。', '去测试用例', () => onOpen('cases')];
			} else if (delivery.failedPoints?.length) {
				const failed = delivery.failedPoints;
				next = ['补齐失败用例', `${failed.length} 个测试点生成失败，一键重试可自动补齐。`,
					'重试失败点', () => onRun.generate('cases', false, undefined, failed.map((entry) => entry.point_id), fastTrackPoints ? 'facts' : undefined)];
			} else if (!currentCases || delivery.missingCases) {
				next = ['生成测试用例', counts.cases ? `还有 ${delivery.missingCases} 个测试点缺用例。` : '按已批准测试点批量生成结构化用例。',
					counts.cases ? '补齐缺少的用例' : '生成用例', () => onRun.generate('cases', counts.cases ? false : true, undefined, undefined, fastTrackPoints ? 'facts' : undefined)];
			} else if (delivery.casesPending) {
				next = ['独立审查并批量批准用例', `还有 ${delivery.casesPending} 条待批准；独立审查后可一键批量批准通过项。`, '打开待审用例',
					() => onOpen('cases', delivery.pendingCaseIds ? delivery.pendingCaseIds[0] : artifacts.cases.items.find((item) => item.review_status !== 'approved')?.case_id)];
			} else {
				next = ['查看交付检查', '检查配图、独立审查和导出交付包。', '去交付检查', () => onOpen('delivery')];
			}
			return h('section', { className: 'cts-flow', 'aria-label': '当前工作进度' },
				h('div', { className: 'cts-flow-bar' },
					h('nav', { className: 'cts-flow-track', 'aria-label': '需求到用例' }, steps.flatMap(([key, title, status], index) => [
						index ? h('span', { key: key + '-arrow', 'aria-hidden': true, style: { opacity: .45 } }, '→') : null,
						h('button', { key, className: 'cts-btn', 'aria-current': stage === key ? 'step' : undefined, onClick: () => onOpen(key) }, `${title} · ${status}`)
					])),
					!hideNext ? h('button', { className: 'cts-btn', style: { padding: '2px 8px', fontSize: 11 }, onClick: () => setTipCollapsed((v) => !v) }, tipCollapsed ? '展开引导' : '收起引导') : null),
				hideNext || tipCollapsed ? null : h('div', { className: 'cts-flow-next' },
					h('div', { className: 'cts-flow-next-text' }, h('strong', null, next[0]), next[1] ? h('p', null, next[1]) : null),
					next[2] ? h('button', { className: 'cts-btn primary', style: { padding: '4px 10px', fontSize: 12 }, disabled: busy, onClick: next[3] }, next[2]) : null),
				!locked && !tipCollapsed ? h('details', { className: 'cts-flow-tools' },
					h('summary', null, mode === 'ecsm' ? '模型准备与高级操作' : '高级操作'),
					h('div', { className: 'cts-filter' },
						mode === 'ecsm' ? preparation.map(([key, label, count, ready, run]) => h('button', {
							key, className: 'cts-btn', disabled: busy || !ready, onClick: run
						}, `${label} · ${count}`)) : null,
						mode === 'design' && counts.facts > 0 ? h('button', { className: 'cts-btn', disabled: busy, onClick: () => onRun.generate('points', true, undefined, undefined, 'facts') }, '从事实重生成测试点（快速轨）') : null,
						mode === 'design' && currentPoints && outlineApproved ? h('button', { className: 'cts-btn', disabled: busy, onClick: () => onRun.generate('points', true) }, '按大纲重生成测试点（受控轨）') : null,
						mode === 'design' && counts.cases > 0 ? h('button', { className: 'cts-btn', disabled: busy || Boolean(delivery.pointsPending), onClick: () => onRun.generate('cases', true, undefined, undefined, fastTrackPoints ? 'facts' : undefined) }, '重新生成本轮用例') : null,
						mode === 'ecsm' ? h('button', { className: 'cts-btn', disabled: busy, onClick: onRun.all }, '一键生成上游草稿') : null)) : null);
		}

		function Workbench({ projects, dataDir, onCreate, onOpen, onRefresh }) {
			const configured = projects.filter((project) => projectQualityReady(project)).length;
			const stamp = (value) => value ? String(value).slice(0, 10) : '';
			return h('div', { className: 'cts-workbench' },
				h('section', { className: 'cts-hero' },
					h('div', { className: 'cts-hero-kicker' }, '测试工作台'),
					h('h1', null, projects.length ? '把需求变成可评审的测试资产' : '从第一份需求开始'),
					h('p', null, projects.length
						? '先选一个项目继续，或新建一个项目。生成配置、模块和资料都在项目内维护。'
						: '建一个项目，上传 PRD / 信号矩阵 / 设计稿，就能依次整理事实、合同、大纲、测试点和用例。'),
					h('div', { className: 'cts-hero-actions' },
						h('button', { className: 'cts-btn primary', onClick: onCreate }, '+ 新建项目'),
						onRefresh ? h('button', { className: 'cts-btn', onClick: onRefresh }, '刷新项目') : null,
						h('span', { className: 'cts-hint' }, `${projects.length} 个项目 · ${configured} 个生成配置已就绪`))),
				h('div', { className: 'cts-workbench-grid' },
					h('section', { className: 'cts-workbench-section' },
						h('div', { className: 'cts-workbench-section-head' },
							h('h2', null, '最近项目'),
							projects.length ? h('span', { className: 'cts-hint' }, '按最近更新排序') : null),
						projects.length ? h('div', { className: 'cts-project-grid' },
							projects.map((project) => {
								const ready = projectQualityReady(project);
								return h('div', { key: project.id, className: 'cts-project-card', role: 'button', tabIndex: 0,
									onClick: () => onOpen(project), onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(project); } } },
									h('div', { className: 'cts-project-meta' },
										h('span', { className: `cts-badge ${ready ? 'ok' : 'warn'}` }, ready ? '生成配置已就绪' : (project.quality ? '生成配置待完善' : '待自动识别配置')),
										project.readonly ? h('span', { className: 'cts-badge' }, '只读') : null),
									h('strong', null, project.name || project.id),
									h('div', { className: 'cts-project-meta' },
										h('span', null, `${(project.modules || []).length} 个模块`),
										stamp(project.updatedAt) ? h('span', null, stamp(project.updatedAt)) : null),
									h('span', { className: 'cts-project-foot' }, project.readonly ? '查看项目' : '打开项目 →'));
							}))
						: h('div', { className: 'cts-workbench-empty' },
							h('strong', null, '三步开始'),
							h('div', null,
								[['新建项目', '填项目名和首个模块名。'],
									['配置生成规则', '在「项目设置 → 生成配置」选模板或手填来源/界面词表。'],
									['上传资料并建证据', '在「资产中心」上传 PRD/信号/设计稿，构建证据后生成上游草稿。']].map(([title, detail], index) =>
									h('div', { className: 'cts-workflow-step', key: title },
										h('b', null, index + 1),
										h('span', null, h('strong', null, title), detail)))),
							h('button', { className: 'cts-btn primary', onClick: onCreate }, '新建第一个项目'))),
					h('aside', { className: 'cts-workflow-card' },
						h('h2', null, '工作流'),
						h('p', null, '每一步都有产物和门槛；需要人确认的地方会停下来等你。'),
						[['资料', '上传 PRD、信号矩阵、DBC 与设计稿。'],
							['模型', '证据 → 事实 → 功能点 → 状态机 → 需求合同。'],
							['设计', '大纲 → 测试点 → 用例 → 复审与人工评审。'],
							['交付', '冻结版本，导出 xlsx / html / json / md。']].map(([title, detail], index) =>
							h('div', { className: 'cts-workflow-step', key: title },
								h('b', null, index + 1),
								h('span', null, h('strong', null, title), detail))),
						h('p', { className: 'cts-hint', style: { marginTop: 10 } }, dataDir ? `数据目录：${dataDir}` : ''))));
		}

		function DesignMcpPanel({ projectId, moduleId, moduleContext = false, onImported, onError }) {
			const [mcp, setMcp] = React.useState(null);
			const [probing, setProbing] = React.useState(false);
			const [selectedPages, setSelectedPages] = React.useState([]);
			const [job, setJob] = React.useState(null);
			const [importing, setImporting] = React.useState(false);
			const [panelMsg, setPanelMsg] = React.useState('');

			const isModuleTarget = Boolean(moduleContext && projectId && moduleId);

			const probe = React.useCallback(async () => {
				setProbing(true);
				setPanelMsg('');
				try {
					const state = await request('design.mcp', isModuleTarget
						? { project: projectId, module: moduleId, mode: 'local' }
						: { scope: 'pool', mode: 'local' });
					setMcp(state);
					const docPages = state?.document?.pages || [];
					if (docPages.length) {
						setSelectedPages(docPages.map((p) => p.id));
					} else {
						setSelectedPages([]);
					}
				} catch (err) {
					setMcp({ connected: false, status: 'disconnected', error: err.message });
				} finally {
					setProbing(false);
				}
			}, [isModuleTarget, projectId, moduleId]);

			React.useEffect(() => { probe(); }, [probe]);

			const doc = mcp?.document || null;
			const docPages = doc?.pages || [];
			const statusKey = mcp?.status || (mcp?.connected ? (doc ? 'ready' : 'no_document') : 'disconnected');
			const statusLabel = !mcp ? '正在检测本地 MCP…'
				: statusKey === 'ready' ? `MCP 已连接 · 检测到「${doc.name}」`
				: statusKey === 'no_document' ? 'MCP 已连接 · 请在 Pixso 打开设计稿'
				: 'MCP 未连接';

			const togglePage = (id) => {
				setSelectedPages((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
			};

			const startImport = async () => {
				if (!selectedPages.length) { setPanelMsg('请至少选择一个原型页面'); return; }
				setImporting(true);
				setPanelMsg('');
				try {
					const targetPayload = isModuleTarget ? { project: projectId, module: moduleId } : { scope: 'pool' };
					let current = await request('design.importCurrent', {
						...targetPayload,
						pages: selectedPages
					});
					setJob(current);
					while (current?.running) {
						await new Promise((resolve) => setTimeout(resolve, 800));
						current = await request('design.previewStatus', targetPayload);
						if (current) setJob(current);
					}
					if (current?.error) throw new Error(current.error);
					setPanelMsg(`导入${isModuleTarget ? '当前模块' : '资产池'}完成：${current?.source || doc?.name || ''}（${selectedPages.length} 页，截图 ${current?.done || 0}/${current?.total || 0}）`);
					await probe();
					await onImported?.(current);
				} catch (err) {
					setPanelMsg(`导入失败：${err.message}`);
					onError?.(err.message);
				} finally {
					setImporting(false);
				}
			};

			const importedList = mcp?.importedSources || [];

			return h('div', { className: 'cts-mcp-box' },
				h('div', { className: 'cts-mcp-head' },
					h('span', { className: `cts-mcp-dot ${mcp ? statusKey : ''}` }),
					h('span', { className: 'cts-mcp-status' }, statusLabel),
					mcp?.url ? h('span', { className: 'cts-mcp-url' }, mcp.url) : null,
					h('button', { className: 'cts-btn', style: { marginLeft: 'auto' }, disabled: probing || importing, onClick: probe }, probing ? '检测中…' : '刷新 MCP')),
				statusKey !== 'ready' && mcp
					? h('div', { className: 'cts-hint' }, mcp.hint || mcp.error || '请确认 Pixso 桌面端已打开并开启 Local MCP（默认 3667 端口）。')
					: null,
				!isModuleTarget && statusKey === 'ready'
					? h('div', { className: 'cts-hint' }, '导入后进入全局资产池（未绑定项目），之后可在任意项目或模块入口中分配使用。')
					: null,
				statusKey === 'ready' && docPages.length
					? h(React.Fragment, null,
						h('div', { className: 'cts-mcp-doc' },
							h('strong', { style: { fontSize: 12 } }, doc.name),
							h('span', { className: 'cts-hint' }, `共 ${docPages.length} 个原型页面 · 已选 ${selectedPages.length} 个`),
							h('div', { className: 'cts-filter', style: { marginLeft: 'auto' } },
								h('button', { className: 'cts-btn', type: 'button', disabled: importing, onClick: () => setSelectedPages(docPages.map((p) => p.id)) }, '全选'),
								doc.currentPageId ? h('button', { className: 'cts-btn', type: 'button', disabled: importing, onClick: () => setSelectedPages([doc.currentPageId]) }, '仅当前页') : null,
								h('button', { className: 'cts-btn', type: 'button', disabled: importing, onClick: () => setSelectedPages([]) }, '清空'))),
						h('div', { className: 'cts-mcp-pages' },
							docPages.map((page) => {
								const previewNames = (page.frames || []).slice(0, 4).map((f) => f.name).filter(Boolean).join('、');
								return h('label', { className: 'cts-mcp-page', key: page.id },
									h('input', {
										type: 'checkbox',
										checked: selectedPages.includes(page.id),
										disabled: importing,
										onChange: () => togglePage(page.id)
									}),
									h('div', null,
										h('div', null,
											h('strong', null, page.name || page.id),
											page.id === doc.currentPageId ? h('span', { className: 'cts-badge ok', style: { marginLeft: 6 } }, '当前页') : null,
											h('span', { className: 'cts-hint', style: { marginLeft: 6 } }, `${page.framesCount || 0} 个画板`)),
										previewNames ? h('div', { className: 'cts-mcp-page-meta' }, previewNames + ((page.framesCount || 0) > 4 ? ' 等' : '')) : null));
							})),
						h('div', { className: 'cts-filter' },
							h('button', {
								className: 'cts-btn primary',
								type: 'button',
								disabled: importing || !selectedPages.length,
								onClick: startImport
							}, importing ? '正在通过 MCP 导入…' : (isModuleTarget ? `从 MCP 导入所选原型到当前模块（${selectedPages.length}/${docPages.length} 页）` : `从 MCP 导入所选原型到资产池（${selectedPages.length}/${docPages.length} 页）`))))
					: null,
				job?.running
					? h('div', { className: 'cts-mcp-progress' },
						job.phase === 'connect' ? '正在连接 Pixso 设计稿…'
						: job.phase === 'import' ? `正在读取「${job.source}」· 页面 ${job.pagesDone || 0}/${job.pagesTotal || 0}`
						: `正在缓存画板截图 ${job.done || 0}/${job.total || 0}（失败 ${job.failed || 0}）${job.layer ? ' · ' + job.layer : ''}`)
					: null,
				panelMsg ? h('div', { className: 'cts-hint' }, panelMsg) : null,
				importedList.length ? h('div', { className: 'cts-hint' }, `${isModuleTarget ? '当前项目已导入' : '资产池已导入'}：${importedList.map((s) => s.name).join('、')}`) : null);
		}

		function AssetCenter({ projects, initialProjectId, initialModuleId, initialScope = 'pool', moduleContext = false, onOpenProject, onBackToModule, onProjectChange, onOpenTools, onOpenSettings, onAssetsChanged }) {
			const [scope, setScope] = React.useState(initialScope === 'trash' ? 'trash' : 'pool');
			const [projectId, setProjectId] = React.useState(initialProjectId || '');
			const [filterProjectId, setFilterProjectId] = React.useState('');
			const [moduleId, setModuleId] = React.useState(initialModuleId || '');
			const [pool, setPool] = React.useState(null);
			const [trash, setTrash] = React.useState([]);
			const [refsAsset, setRefsAsset] = React.useState(null);
			const [refsData, setRefsData] = React.useState(null);
			const [uploadOpen, setUploadOpen] = React.useState(false);
			const [uploadDir, setUploadDir] = React.useState('prd');
			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState(null);
			const [query, setQuery] = React.useState('');
			const [kind, setKind] = React.useState('');
			const [viewMode, setViewMode] = React.useState('table');
			const [confirmModal, setConfirmModal] = React.useState(null);
			const uploadDialog = React.useRef(null);
			const refsDialog = React.useRef(null);
			const uploadFile = React.useRef(null);
			const setFeedback = (text, tone = 'info') => setNotice(text ? { tone, text } : null);
			const activeProject = (pool?.projects || projects).find((item) => item.id === projectId) || null;
			const modules = (projects.find((item) => item.id === projectId)?.modules) || [];
			const projectName = (id) => (pool?.projects || projects).find((item) => item.id === id)?.name || id || '';
			const moduleName = (id) => modules.find((item) => item.id === id)?.name || id || '';
			React.useEffect(() => { if (uploadOpen) uploadDialog.current?.showModal(); else uploadDialog.current?.close(); }, [uploadOpen]);
			React.useEffect(() => { if (refsAsset) refsDialog.current?.showModal(); else if (refsDialog.current?.open) refsDialog.current.close(); }, [refsAsset]);
			const load = async () => {
				setBusy(true);
				try {
					const state = await request('assets.pool.list');
					setPool(state);
					if (scope === 'trash' && projectId) {
						const items = await request('assets.trashList', { scope: 'project', project: projectId });
						setTrash(items.items || []);
					}
				} catch (err) { setFeedback(err.message, 'error'); }
				finally { setBusy(false); }
			};
			React.useEffect(() => { void load(); }, [scope, projectId, moduleId]);
			const assets = pool?.assets || [];
			const scoped = filterProjectId ? assets.filter((asset) => (asset.projects || []).some((project) => project.id === filterProjectId) || (asset.copies || []).some((copy) => copy.storage === 'inbox' || copy.storage === 'mcp-pool')) : assets;
			const all = scope === 'trash' ? trash : [...scoped, ...(pool?.global || [])];
			const isInboxAsset = (asset) => !(asset.projects || []).length && asset.scope !== 'global' && !asset.virtual;
			const kindCounts = all.reduce((acc, item) => {
				const k = item.kind || '其他';
				acc[k] = (acc[k] || 0) + 1;
				return acc;
			}, {});
			const unassignedCount = all.filter(isInboxAsset).length;
			const kinds = Object.keys(kindCounts).sort();
			const search = query.trim().toLowerCase();
			const shown = all.filter((item) => {
				if (kind === '__unassigned__' && !isInboxAsset(item)) return false;
				if (kind && kind !== '__unassigned__' && (item.kind || '其他') !== kind) return false;
				return !search || `${item.name} ${item.kind || ''} ${(item.projects || []).map((project) => project.name).join(' ')}`.toLowerCase().includes(search);
			});
			const tagged = (asset) => (asset.tags || []).some((tag) => tag.project_id === projectId && tag.module_id === moduleId);
			const currentCopy = (asset) => projectId ? (asset.copies || []).find((copy) => copy.project_id === projectId) : null;
			const tagItems = (asset) => {
				const tags = asset.tags || [];
				if (!tags.length) return [];
				const seen = new Set();
				const out = [];
				for (const tag of tags) {
					const entry = tag.module_id
						? { text: tag.module_name || moduleName(tag.module_id), shared: false }
						: { text: tag.project_id ? `${projectName(tag.project_id)}（共享）` : '项目共享', shared: true };
					if (seen.has(entry.text)) continue;
					seen.add(entry.text);
					out.push(entry);
				}
				return out;
			};
			const typeBadgeFor = (asset) => {
				const k = String(asset.kind || '').toLowerCase();
				if (asset.scope === 'global' || asset.virtual) return { code: 'RULE', tone: 'global' };
				if (k.includes('prd') || k.includes('需求')) return { code: 'PRD', tone: 'prd' };
				if (k.includes('dbc') || k.includes('信号') || k.includes('矩阵') || k.includes('signal')) return { code: 'SIG', tone: 'signals' };
				if (k.includes('设计') || k.includes('pix') || k.includes('design') || k.includes('ui') || k.includes('mcp')) return { code: 'UI', tone: 'design' };
				return { code: 'DOC', tone: 'other' };
			};
			const upload = async (files, dir) => {
				const list = [...(files || [])].filter(Boolean);
				if (!list.length) { setFeedback('请先选择需要上传的文件', 'warning'); return; }
				setBusy(true); setNotice(null);
				try {
					const added = [];
					for (const file of list) {
						const response = await fetch('cts/api/upload', {
							method: 'POST',
							headers: { 'content-type': 'application/octet-stream', 'x-scope': 'pool', 'x-dir': dir, 'x-filename': encodeURIComponent(file.name) },
							body: file
						});
						const body = await response.json().catch(() => null);
						if (!response.ok || !body?.ok) throw new Error(body?.error || '上传失败');
						added.push(body.state.added);
					}
					if (moduleContext && projectId && moduleId) {
						for (const relative of added) await request('assets.pool.import', { storage: 'inbox', path: relative, project: projectId, module: moduleId });
					}
					setUploadOpen(false);
					await load();
					await onAssetsChanged?.();
					setFeedback(`已上传 ${added.length} 个文件${moduleContext ? '并导入当前模块' : '到资产池'}`, 'success');
				} catch (err) { setFeedback(err.message, 'error'); }
				finally { setBusy(false); }
			};
			const tag = async (asset) => {
				if (!projectId || !moduleId) { setFeedback('请先从具体模块进入后再分配资产', 'warning'); return; }
				if (asset.scope === 'global' || asset.virtual) { setFeedback('全局 Skill 为内置规则，无需导入模块', 'info'); return; }
				setBusy(true);
				try {
					const copy = currentCopy(asset);
					const isTagged = tagged(asset);
					if (isTagged && copy) {
						await request('assets.tags.update', { project: projectId, path: copy.path, module: moduleId, add: false });
						await request('sources.selection.remove', { project: projectId, module: moduleId, path: copy.path }).catch(() => {});
						setFeedback(`已将「${asset.name}」移出当前模块`, 'success');
					} else {
						const source = copy || (asset.copies || []).find((item) => item.storage === 'inbox' || item.storage === 'mcp-pool') || (asset.copies || [])[0];
						if (!source) throw new Error('找不到资产来源');
						await request('assets.pool.import', { storage: source.storage, source_project: source.project_id || '', path: source.path, asset_hash: asset.hash || '', project: projectId, module: moduleId });
						setFeedback(`已将「${asset.name}」导入模块「${moduleName(moduleId)}」`, 'success');
					}
					await load();
					await onAssetsChanged?.();
				} catch (err) { setFeedback(err.message, 'error'); }
				finally { setBusy(false); }
			};
			const showRefs = async (asset) => {
				const copy = currentCopy(asset);
				if (!copy) return;
				setRefsAsset(asset);
				setRefsData(null);
				try {
					setRefsData(await request('assets.refs', { project: copy.project_id, path: copy.path }));
				} catch (err) { setFeedback(err.message, 'error'); }
			};
			const doRemove = async (asset) => {
				const copy = currentCopy(asset);
				if (!copy) return;
				setBusy(true);
				try {
					await request('assets.trash', { scope: 'project', project: copy.project_id, path: copy.path });
					await load();
					await onAssetsChanged?.();
					setFeedback(`已将「${asset.name}」移入回收站`, 'success');
				} catch (err) { setFeedback(err.message, 'error'); }
				finally { setBusy(false); }
			};
			const remove = (asset) => {
				if (!currentCopy(asset)) return;
				setConfirmModal({
					title: '移入回收站',
					message: `确认将「${asset.name}」的当前项目副本移入回收站？移入后仍可在回收站随时恢复。`,
					confirmText: '移入回收站',
					danger: true,
					onDone: (ok) => { if (ok) void doRemove(asset); }
				});
			};
			const restore = async (item) => {
				setBusy(true);
				try {
					await request('assets.restore', { scope: 'project', project: projectId, trash: item.trash });
					await load();
					await onAssetsChanged?.();
					setFeedback(`已恢复「${item.name}」`, 'success');
				} catch (err) { setFeedback(err.message, 'error'); }
				finally { setBusy(false); }
			};
			const buildEvidence = async () => {
				if (!projectId) return;
				setBusy(true);
				try {
					await request('project.autoConfig', { project: projectId });
					await request('evidence.build', { project: projectId, module: moduleId || undefined });
					await onAssetsChanged?.();
					setFeedback('证据构建完成，已自动同步项目生成配置', 'success');
				} catch (err) { setFeedback(err.message, 'error'); }
				finally { setBusy(false); }
			};
			const size = (bytes) => bytes ? (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`) : '';
			const stamp = (value) => value ? String(value).slice(0, 10) : '';
			const renderActions = (asset) => {
				const copy = currentCopy(asset);
				const isGlobal = asset.scope === 'global' || asset.virtual;
				if (isGlobal) return h('span', { className: 'cts-hint' }, '全局规则');
				return h(React.Fragment, null,
					moduleContext && moduleId
						? h('button', { className: `cts-btn${tagged(asset) && copy ? '' : ' primary'}`, disabled: busy, onClick: () => tag(asset) },
							(tagged(asset) && copy) ? '移出模块' : copy ? '用于本轮' : '导入模块')
						: null,
					copy && !copy.mcp && copy.storage !== 'mcp-project' ? h('button', { className: 'cts-btn', disabled: busy, onClick: () => showRefs(asset) }, '影响') : null,
					copy && !copy.mcp && copy.storage !== 'mcp-project' ? h('button', { className: 'cts-btn danger', disabled: busy, onClick: () => remove(asset) }, '删除') : null);
			};
			const renderOwnership = (asset) => {
				const isGlobal = asset.scope === 'global' || asset.virtual;
				if (isGlobal) return h('span', { className: 'asset-tag-chip none' }, '全工作台生效');
				const projNames = (asset.projects || []).map((p) => p.name);
				const mods = tagItems(asset);
				if (!projNames.length && !mods.length) return h('span', { className: 'asset-tag-chip none' }, '未分配项目/模块');
				return h('div', { className: 'ac-chips' },
					projNames.slice(0, 2).map((p, idx) => h('span', { className: 'asset-tag-chip shared', key: `p-${idx}` }, p)),
					projNames.length > 2 ? h('span', { className: 'asset-tag-chip' }, `+${projNames.length - 2} 项目`) : null,
					mods.slice(0, 3).map((item, idx) => h('span', { className: 'asset-tag-chip', key: `m-${idx}` }, item.text)),
					mods.length > 3 ? h('span', { className: 'asset-tag-chip' }, `+${mods.length - 3}`) : null);
			};
			const renderTableRow = (asset) => {
				const isInbox = isInboxAsset(asset);
				const isGlobal = asset.scope === 'global' || asset.virtual;
				const icon = typeBadgeFor(asset);
				return h('tr', { key: asset.id },
					h('td', null, h('div', { className: 'ac-name-cell' },
						h('span', { className: 'ac-type-icon', 'data-kind': icon.tone }, icon.code),
						h('div', { className: 'ac-name-main' },
							h('div', { className: 'ac-name-title' }, asset.name),
							h('div', { className: 'ac-name-sub' },
								h('span', null, asset.kind || '资产'),
								size(asset.bytes) ? h('span', null, size(asset.bytes)) : null,
								stamp(asset.modified) ? h('span', null, stamp(asset.modified)) : null)))),
					h('td', null, renderOwnership(asset)),
					h('td', null, h('span', { className: `asset-badge ${isInbox ? 'warn' : isGlobal ? 'readonly' : 'project'}` },
						isInbox ? '未分配' : isGlobal ? '全局' : (moduleContext && tagged(asset) ? '本模块已用' : '已绑定'))),
					h('td', null, h('div', { className: 'ac-row-actions' }, renderActions(asset))));
			};
			const card = (asset) => {
				const isInbox = isInboxAsset(asset);
				const isGlobal = asset.scope === 'global' || asset.virtual;
				const icon = typeBadgeFor(asset);
				return h('article', { className: 'asset-card', key: asset.id },
					h('div', { className: 'asset-card-head' },
						h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
							h('span', { className: 'ac-type-icon', 'data-kind': icon.tone }, icon.code),
							h('span', { className: 'asset-type' }, asset.kind || '资产')),
						h('span', { className: `asset-badge ${isInbox ? 'warn' : isGlobal ? 'readonly' : 'project'}` },
							isInbox ? '未分配' : isGlobal ? '全局' : (moduleContext && tagged(asset) ? '本模块已用' : '已绑定'))),
					h('div', { className: 'asset-name' }, asset.name),
					renderOwnership(asset),
					h('div', { className: 'asset-meta' },
						size(asset.bytes) ? h('span', null, size(asset.bytes)) : null,
						stamp(asset.modified) ? h('span', null, stamp(asset.modified)) : null),
					h('div', { className: 'asset-actions' }, renderActions(asset)));
			};
			const trashRow = (item) => h('tr', { key: item.trash },
				h('td', null, h('div', { className: 'ac-name-cell' },
					h('span', { className: 'ac-type-icon', 'data-kind': 'other' }, 'DEL'),
					h('div', { className: 'ac-name-main' },
						h('div', { className: 'ac-name-title' }, item.name),
						h('div', { className: 'ac-name-sub' }, h('span', null, item.original_path || item.trash), size(item.bytes) ? h('span', null, size(item.bytes)) : null)))),
				h('td', null, h('span', { className: 'asset-badge readonly' }, '回收站')),
				h('td', null, h('div', { className: 'ac-row-actions' },
					h('button', { className: 'cts-btn primary', disabled: busy, onClick: () => restore(item) }, '恢复'))));

			return h('div', { className: 'asset-center' },
				h('header', { className: 'ac-header' },
					h('div', null,
						h('h1', null, scope === 'trash' ? '回收站' : moduleContext ? `资产中心 · ${moduleName(moduleId)}` : '资产中心'),
						h('p', null, scope === 'trash'
							? '已软删除的项目副本，可随时恢复（恢复后按需重新分配模块）。'
							: '所有 PRD、信号矩阵与设计稿先统一入库，再按需分配到任意项目与模块多对多复用。')),
					h('div', { className: 'ac-header-actions' },
						moduleContext && onBackToModule ? h('button', { className: 'cts-btn', onClick: onBackToModule }, '← 返回模块') : null,
						scope === 'trash'
							? h('button', { className: 'cts-btn', onClick: () => setScope('pool') }, '返回资产池')
							: h('button', { className: 'cts-btn', onClick: () => { if (!projectId) { setFeedback('请先在下方选择一个项目再查看回收站', 'warning'); return; } setScope('trash'); } }, '回收站'),
						h('button', { className: 'cts-btn primary', disabled: busy, onClick: () => { setUploadDir('prd'); setUploadOpen(true); } }, '+ 上传到资产池'))),
				notice ? h('div', { className: 'cts-notice', 'data-tone': notice.tone, style: { margin: 0 } },
					h('span', null, notice.text),
					h('button', { className: 'cts-notice-close', 'aria-label': '关闭提示', onClick: () => setNotice(null) }, '×')) : null,
				scope === 'pool' ? h('div', { className: 'ac-pills' },
					h('div', { className: 'ac-pill-group' },
						h('button', { className: `cts-pill${kind === '' ? ' active' : ''}`, onClick: () => setKind('') }, `全部 (${all.length})`),
						unassignedCount > 0 ? h('button', { className: `cts-pill${kind === '__unassigned__' ? ' active' : ''}`, onClick: () => setKind('__unassigned__') }, `未分配 (${unassignedCount})`) : null,
						kinds.map((k) => h('button', { key: k, className: `cts-pill${kind === k ? ' active' : ''}`, onClick: () => setKind(k) }, `${k} (${kindCounts[k]})`))),
					h('div', { className: 'cts-modes' },
						h('button', { className: `cts-mode${viewMode === 'table' ? ' on' : ''}`, onClick: () => setViewMode('table') }, '列表'),
						h('button', { className: `cts-mode${viewMode === 'grid' ? ' on' : ''}`, onClick: () => setViewMode('grid') }, '卡片'))) : null,
				h('div', { className: 'ac-toolbar' },
					!moduleContext ? h('select', { className: 'cts-select', 'aria-label': '按项目筛选', value: filterProjectId, onChange: (event) => { setFilterProjectId(event.target.value); setProjectId(event.target.value); setModuleId(''); } },
						h('option', { value: '' }, '全部项目'),
						(pool?.projects || projects).map((project) => h('option', { key: project.id, value: project.id }, project.name))) : null,
					h('input', { className: 'cts-input', type: 'search', value: query, placeholder: '搜索文件名、类型或项目…', onChange: (event) => setQuery(event.target.value) }),
					h('div', { className: 'ac-toolbar-right' },
						activeProject ? h('button', { className: 'cts-btn', disabled: busy, onClick: buildEvidence }, '构建证据') : null,
						activeProject && onOpenTools ? h('button', { className: 'cts-btn', onClick: onOpenTools }, '资料工具') : null,
						activeProject && onOpenSettings ? h('button', { className: 'cts-btn', onClick: onOpenSettings }, '项目设置') : null,
						activeProject ? h('button', { className: 'cts-btn', onClick: () => onOpenProject?.(activeProject) }, '打开项目') : null)),
				shown.length === 0
					? h('div', { className: 'asset-empty' }, scope === 'trash' ? '回收站为空。' : '当前筛选下没有资产，可切换分类或点击右上角「+ 上传到资产池」。')
					: scope === 'trash'
						? h('div', { className: 'ac-table-wrap' },
							h('table', { className: 'ac-table' },
								h('thead', null, h('tr', null, h('th', null, '资产'), h('th', null, '状态'), h('th', { style: { textAlign: 'right' } }, '操作'))),
								h('tbody', null, shown.map(trashRow))))
						: viewMode === 'table'
							? h('div', { className: 'ac-table-wrap' },
								h('table', { className: 'ac-table' },
									h('thead', null, h('tr', null, h('th', null, '资产名称'), h('th', null, '归属项目 / 模块'), h('th', null, '状态'), h('th', { style: { textAlign: 'right' } }, '操作'))),
									h('tbody', null, shown.map(renderTableRow))))
							: h('div', { className: 'asset-grid' }, shown.map(card)),
				refsAsset ? h('dialog', { ref: refsDialog, className: 'cts-confirm-dialog', onClose: () => { setRefsAsset(null); setRefsData(null); } },
					h('h3', null, `引用影响 · ${refsAsset.name}`),
					!refsData ? h('p', null, '正在统计引用关系…') : h('div', { className: 'cts-summary-strip', style: { margin: '10px 0' } },
						h('span', { className: 'cts-pill info' }, `模块 ${refsData.visibility}/${(refsData.modules || []).length}`),
						h('span', { className: 'cts-pill' }, `证据 ${refsData.evidence}`),
						h('span', { className: 'cts-pill' }, `事实 ${refsData.facts}`),
						h('span', { className: 'cts-pill' }, `合同 ${refsData.contracts}`)),
					h('div', { className: 'cts-filter', style: { justifyContent: 'flex-end', marginBottom: 0 } },
						h('button', { className: 'cts-btn primary', onClick: () => { setRefsAsset(null); setRefsData(null); } }, '关闭'))) : null,
				uploadOpen ? h('dialog', { ref: uploadDialog, onClose: () => setUploadOpen(false), style: { width: 'min(640px, 94vw)', maxHeight: '85vh', overflow: 'auto' } },
					h('h3', null, '上传到资产池'),
					h('p', { className: 'cts-hint' }, moduleContext ? '上传后直接导入当前模块（自动绑定项目和模块），也可之后被其他模块复用。' : '上传后进入资产池，不绑定项目；之后从模块入口导入时再自动绑定项目/模块。'),
					h('div', { className: 'cts-field' }, h('span', { className: 'cts-field-l' }, '资料目录'),
						h('select', { className: 'cts-select', value: uploadDir, onChange: (event) => setUploadDir(event.target.value) },
							[['prd', 'PRD 目录'], ['signals', '信号目录'], ['design', '设计稿目录'], ['other', '其他资料目录']].map(([key, label]) => h('option', { key, value: key }, label)))),
					uploadDir === 'design' ? h(DesignMcpPanel, {
						projectId,
						moduleId,
						moduleContext,
						onImported: async () => {
							await load();
							await onAssetsChanged?.();
						},
						onError: (msg) => setFeedback(msg, 'info')
					}) : null,
					h('div', { className: 'cts-field', style: { marginTop: 8 } }, h('span', { className: 'cts-field-l' }, uploadDir === 'design' ? '本地文件（可选）' : '文件'),
						h('input', { type: 'file', multiple: true, ref: uploadFile })),
					h('div', { className: 'cts-filter', style: { justifyContent: 'flex-end', marginTop: 12 } },
						h('button', { className: 'cts-btn', onClick: () => setUploadOpen(false) }, '关闭'),
						h('button', { className: 'cts-btn primary', disabled: busy, onClick: () => upload([...(uploadFile.current?.files || [])], uploadDir) }, busy ? '上传中…' : '上传'))) : null,
				h(ConfirmDialog, {
					modal: confirmModal,
					onClose: (res) => { const cb = confirmModal?.onDone; setConfirmModal(null); cb?.(res); }
				}));
		}

		function ProjectHome({ project, modules, moduleWorkbench, onSelectModule, onAssets, onSettings, onWorkbench }) {
			if (!project) return h('div', { className: 'cts-empty' }, '项目不存在');
			const ready = projectQualityReady(project);
			return h('div', { className: 'cts-project-home' },
				h('section', { className: 'cts-hero' },
					h('div', { className: 'cts-hero-kicker' }, '项目首页'),
					h('h1', null, project.name || project.id),
					h('p', null, `${(project.modules || []).length} 个模块。不同模块的产物、资料范围和测试设计相互独立，先选一个模块进入。`),
					h('div', { className: 'cts-hero-actions' },
						h('span', { className: `cts-badge ${ready ? 'ok' : 'warn'}` }, ready ? '生成配置已就绪' : '生成配置待完善'),
						project.readonly ? h('span', { className: 'cts-badge' }, '只读') : null,
						h('button', { className: 'cts-btn', onClick: onWorkbench }, '返回工作台'),
						h('button', { className: 'cts-btn', onClick: onAssets }, '项目资产'),
						h('button', { className: 'cts-btn', onClick: onSettings }, '项目设置'))),
				h('section', { className: 'cts-workbench-section' },
					h('div', { className: 'cts-workbench-section-head' },
						h('h2', null, '选择模块'),
						h('span', { className: 'cts-hint' }, '进入模块后才能做 ECSM / 测试设计 / 交付')),
					modules.length
						? h('div', { className: 'cts-module-grid' },
							modules.map((module) => h('button', {
								key: module.id, className: 'cts-project-card', onClick: () => onSelectModule(module.id)
							},
								h('div', { className: 'cts-project-meta' },
									h('span', { className: 'cts-badge' }, '模块'),
									h('span', null, (module.keywords || []).join('、') || module.name)),
								h('strong', null, module.name || module.id),
								h('div', { className: 'cts-project-meta' }, h('span', null, module.id)),
								h('span', { className: 'cts-hint' }, moduleWorkbench?.[module.id]?.next_action ? `下一步：${moduleWorkbench[module.id].next_action.label}` : '等待前置'),
								h('span', { className: 'cts-project-foot' }, '进入模块 →'))))
						: h('div', { className: 'asset-empty' }, '正在读取模块，或该项目还没有模块。')));
		}

		function EcsmGuide({ hasAssets, evidenceCount, facts, features, states, contracts, approved, frozen, busy, nextState, onAssets, onBuild, onUpstream, onContracts, onConfirm, onFreeze, onDesign }) {
			const steps = [
				{ key: 'material', label: '资料与证据', done: evidenceCount > 0 },
				{ key: 'model', label: '生成上游', done: facts > 0 && features > 0 },
				{ key: 'contract', label: '确认合同', done: contracts > 0 && approved > 0 },
				{ key: 'freeze', label: '冻结模型', done: frozen }
			];
			let current = steps.findIndex((step) => !step.done);
			if (current < 0) current = steps.length;
			let title = '';
			let detail = '';
			let action = null;
			let label = '';
			const nextAction = nextState?.next_action;
			const handlers = { select_materials: onAssets, build_evidence: onBuild, generate_upstream: onUpstream,
				generate_contracts: onContracts, review_contract: onConfirm, freeze_model: onFreeze,
				design_outline: onDesign, review_outline: onDesign, generate_points: onDesign, generate_cases: onDesign,
				retry_failed_cases: onDesign, address_delivery_blocker: onDesign, delivery: onDesign };
			const phaseText = { materials: '资料与证据', evidence: '资料与证据', upstream: '生成上游', contracts: '确认合同',
				contract_review: '确认合同', freeze: '冻结模型', outline: '测试设计', points: '测试设计', cases: '测试设计', delivery: '交付' };
			if (nextAction && handlers[nextAction.id]) {
				title = nextAction.label;
				label = nextAction.label;
				action = handlers[nextAction.id];
				const firstBlocker = nextState?.blockers?.[0];
				detail = firstBlocker?.reason || `当前阶段：${phaseText[nextState.phase] || nextState.phase}。按最早可处理项继续，其他阶段可手动查看。`;
			} else if (!hasAssets) {
				title = '先把项目资料放进资产中心';
				detail = '上传 PRD、DBC、设计稿后，系统会自动识别生成配置，再构建证据。';
				action = onAssets; label = '去资产中心上传资料';
			} else if (evidenceCount === 0) {
				title = '第 1 步：构建证据';
				detail = '把已上传的资料解析成可引用的证据块；后续事实、合同和测试点都要回溯到这些证据。';
				action = onBuild; label = '构建证据';
			} else if (facts === 0 || features === 0 || states === 0) {
				title = '第 2 步：生成上游草稿';
				detail = '从证据提取产品事实，归并功能点并推导状态机；这是 ECSM 的模型基础。';
				action = onUpstream; label = '生成上游草稿';
			} else if (contracts === 0) {
				title = '第 3 步：生成并核对需求合同';
				detail = '按功能把事实整理成“前置条件 → 触发动作 → 可观察预期”的合同，确认后测试设计只使用已确认合同。';
				action = onContracts; label = '按功能生成合同';
			} else if (approved === 0) {
				title = '第 3 步：确认需求合同';
				detail = `${contracts} 条合同还没确认。逐条核对条件、动作、预期和来源原文，至少确认一条。`;
				action = onConfirm; label = '去核对合同';
			} else if (!frozen) {
				title = '第 4 步：冻结产品模型';
				detail = `已确认 ${approved}/${contracts} 条合同。冻结会固定本轮模型版本，测试点只使用其中已确认的合同。`;
				action = onFreeze; label = '冻结产品模型';
			} else {
				title = '产品模型已冻结';
				detail = '模型版本已固定，可以进入测试设计：生成大纲、测试点和用例。';
				action = onDesign; label = '去测试设计';
			}
			return h('section', { className: 'cts-guide', 'aria-label': 'ECSM 下一步' },
				h('div', { className: 'cts-guide-kicker' }, 'ECSM 产品模型准备'),
				h('h2', null, title),
				h('p', null, detail),
				nextState?.blockers?.length > 1 ? h('p', { className: 'cts-hint' }, `另有 ${nextState.blockers.length - 1} 项阻断，可在对应页面查看。`) : null,
				h('div', { className: 'cts-guide-steps' },
					steps.map((step, index) => h('span', {
						key: step.key,
						className: `cts-guide-step${step.done ? ' done' : index === current ? ' on' : ''}`
					}, h('b', null, step.done ? '✓' : index + 1), step.label))),
				h('div', { className: 'cts-guide-actions' },
					action ? h('button', { className: 'cts-btn primary', disabled: busy, onClick: action }, busy ? '处理中…' : label) : null,
					!frozen ? h('button', { className: 'cts-btn', onClick: onAssets }, '查看项目资产') : null));
		}

		function ModuleAssets({ project, module, moduleId, assets, pool, materials, busy, onUpload, onImport, onBatch, onAdopt, onNext, onOpenCenter, onRefreshAssets, onError }) {
			const [bucket, setBucket] = React.useState('prd');
			const [uploading, setUploading] = React.useState(false);
			const projectId = project?.id || '';
			const pickerKey = `cts.picker.${projectId}.${moduleId}`;
			const savedPicker = (() => { try { return JSON.parse(sessionStorage.getItem(pickerKey) || '{}'); } catch { return {}; } })();
			const [query, setQuery] = React.useState(savedPicker.query || '');
			const [kindFilter, setKindFilter] = React.useState(savedPicker.kindFilter || '');
			const [selectedId, setSelectedId] = React.useState(savedPicker.selectedId || '');
			const [batchIds, setBatchIds] = React.useState(Array.isArray(savedPicker.batchIds) ? savedPicker.batchIds : []);
			const searchRef = React.useRef(null);
			const listRef = React.useRef(null);
			const restoredScroll = React.useRef(false);
			const scrollKey = pickerKey + '.scrollTop';
			React.useEffect(() => {
				try { sessionStorage.setItem(pickerKey, JSON.stringify({ query, kindFilter, selectedId, batchIds })); } catch {}
			}, [pickerKey, query, kindFilter, selectedId, batchIds]);
			const candidates = (pool || []).filter((asset) => asset.scope !== 'global' && !asset.virtual);
			const isTagged = (asset) => (asset.tags || []).some((tag) => tag.project_id === projectId && tag.module_id === moduleId);
			const currentCopy = (asset) => (asset.copies || []).find((copy) => copy.project_id === projectId);
			const rowFor = (asset) => { const copy = currentCopy(asset); return copy ? (materials || []).find((row) => row.path === copy.path) : null; };
			const tagged = candidates.filter(isTagged);
			const taggedPaths = new Set(tagged.map((asset) => currentCopy(asset)?.path).filter(Boolean));
			const mcpDesigns = (materials || []).filter((row) => row.kind === 'pixso-mcp' && row.selected && !taggedPaths.has(row.path));
			const taggedCount = tagged.length + mcpDesigns.length;
			const search = query.trim().toLowerCase();
			const kinds = [...new Set(candidates.map((asset) => asset.kind || '其他'))].sort();
			const shown = candidates.filter((asset) => (!kindFilter || (asset.kind || '其他') === kindFilter)
				&& (!search || `${asset.name} ${(asset.projects || []).map((item) => item.name).join(' ')} ${(asset.tags || []).map((tag) => tag.module_name || '').join(' ')}`.toLowerCase().includes(search)));
			const selected = shown.find((asset) => asset.id === selectedId) || shown[0] || null;
			React.useLayoutEffect(() => {
				if (!listRef.current || restoredScroll.current) return;
				restoredScroll.current = true;
				try { listRef.current.scrollTop = Number(sessionStorage.getItem(scrollKey)) || 0; } catch {}
			}, [scrollKey, shown.length]);
			React.useEffect(() => {
				if (!selectedId && candidates.length) setSelectedId(candidates[0].id);
			}, [candidates.length, selectedId]);
			const upload = async (files) => {
				const list = [...(files || [])].filter(Boolean);
				if (!list.length) return;
				setUploading(true);
				try { await onUpload(list, bucket); }
				catch (err) { onError?.(err.message); }
				finally { setUploading(false); }
			};
			const pickerList = h('div', { className: 'cts-picker-list', ref: listRef, onScroll: (event) => {
				try { sessionStorage.setItem(scrollKey, String(event.currentTarget.scrollTop)); } catch {}
			} }, shown.map((asset) => h('div', { key: asset.id, className: 'cts-picker-row' },
				h('input', { type: 'checkbox', 'aria-label': `选择 ${asset.name}`, checked: batchIds.includes(asset.id),
					onChange: (event) => setBatchIds((current) => event.target.checked ? [...current, asset.id] : current.filter((id) => id !== asset.id)) }),
				h('button', { className: `cts-picker-item${selected?.id === asset.id ? ' on' : ''}`, onClick: () => setSelectedId(asset.id) },
					h('span', { className: 'cts-picker-name' }, asset.name),
					h('span', { className: 'cts-picker-meta' }, `${asset.kind || '资产'}${isTagged(asset) ? ' · 已在本模块' : ''}${(asset.projects || []).length ? ` · ${(asset.projects || []).length} 个项目` : ' · 未分配'}`)))));
			const projectBlock = (selected?.projects || []).length
				? h('div', { className: 'cts-preview-block' },
					h('div', { className: 'cts-preview-label' }, '绑定项目'),
					h('ul', { className: 'cts-preview-projects' }, (selected.projects || []).map((item) => h('li', { key: item.id }, item.name))))
				: h('div', { className: 'cts-hint' }, '尚未绑定项目，导入时会自动绑定当前项目');
			const moduleBlock = (selected?.tags || []).length
				? h('div', { className: 'cts-preview-block' },
					h('div', { className: 'cts-preview-label' }, '已绑定模块'),
					h('div', { className: 'asset-tag-row' }, (selected.tags || []).map((tag, index) => h('span', { className: 'asset-tag-chip', key: `pv-${index}` }, tag.module_name || tag.module_id || '项目共享'))))
				: null;
			const sameNameVersions = selected && !selected.mcp ? (pool || []).filter((asset) => asset.id !== selected.id && !asset.mcp && asset.name === selected.name && asset.hash !== selected.hash) : [];
			const versionBlock = sameNameVersions.length && currentCopy(selected) ? h('div', { className: 'cts-preview-block' },
				h('div', { className: 'cts-preview-label' }, '同名其他版本'),
				sameNameVersions.map((asset) => h('div', { className: 'cts-filter', key: asset.id },
					h('span', { className: 'cts-hint' }, `v${String(asset.hash || '').slice(0, 8)} · ${Math.max(1, Math.round((asset.bytes || 0) / 1024))} KB`),
					h('button', { className: 'cts-btn', disabled: busy, onClick: () => onAdopt(selected, asset) }, '比较并采用')))) : null;
			const previewPane = selected ? h('div', { className: 'cts-picker-preview' },
				h('div', { className: 'cts-picker-preview-head' }, h('strong', null, selected.name), h('span', { className: 'cts-hint' }, selected.kind || '资产')),
				h('div', { className: 'cts-picker-preview-meta' }, `${selected.bytes ? `${Math.max(1, Math.round(selected.bytes / 1024))} KB` : ''}${selected.modified ? ` · ${String(selected.modified).slice(0, 10)}` : ''}`),
				projectBlock,
				moduleBlock,
				versionBlock,
				h('div', { className: 'cts-preview-actions' },
					rowFor(selected)?.selected ? h('span', { className: 'cts-badge ok' }, '已选入本轮')
						: h('button', { className: 'cts-btn primary', disabled: busy, onClick: () => onImport(selected) }, currentCopy(selected) ? '用于本轮' : `导入「${module?.name || moduleId}」`)),
				currentCopy(selected) ? h('div', { className: 'cts-preview-block' },
					h('div', { className: 'cts-preview-label' }, '来源'),
					h('div', { className: 'cts-hint' }, `${currentCopy(selected).project_name || ''} / ${currentCopy(selected).path}`),
					h('div', { className: 'cts-hint' }, `内容版本：${String(rowFor(selected)?.content_version || selected.hash || '').slice(0, 18) || '未解析'} · 用途：${rowFor(selected)?.usage || (selected.kind === 'PRD' ? 'requirement' : selected.kind === '信号矩阵' ? 'interface' : selected.kind === 'UI 设计' ? 'design' : 'reference')} · ${rowFor(selected)?.used ? '本轮生效' : rowFor(selected)?.selected ? '已选入，待核对' : isTagged(selected) ? '在本模块，待选入或解析' : '未选入本轮'}`),
					rowFor(selected)?.exclusion ? h('div', { className: 'cts-hint' }, `状态：${rowFor(selected).exclusion}`) : null,
					currentCopy(selected).storage !== 'mcp-project' && !selected.mcp ? h('a', { className: 'cts-btn', href: `cts/file?path=${encodeURIComponent(`${currentCopy(selected).project_id}/${currentCopy(selected).path}`)}`, target: '_blank', rel: 'noreferrer' }, '打开原文') : null) : null)
				: null;
			const pickerSection = h('section', { className: 'cts-workbench-section' },
				h('div', { className: 'cts-workbench-section-head' },
					h('h2', null, `资产池 · 预览与选择（${shown.length}/${candidates.length}）`),
					h('div', { className: 'cts-filter' },
						h('select', { className: 'cts-select', 'aria-label': '筛选资产类型', value: kindFilter, onChange: (event) => { setKindFilter(event.target.value); setSelectedId(''); } },
							h('option', { value: '' }, '全部类型'),
							kinds.map((kind) => h('option', { key: kind, value: kind }, `${kind}（${candidates.filter((asset) => (asset.kind || '其他') === kind).length}）`))),
						h('input', { className: 'cts-input', type: 'search', ref: searchRef, value: query, placeholder: '搜索资产 / 项目 / 模块', onChange: (event) => setQuery(event.target.value) }),
						batchIds.length ? h('button', { className: 'cts-btn primary', disabled: busy, onClick: () => onBatch(shown.filter((asset) => batchIds.includes(asset.id))) }, `批量用于本轮（${batchIds.length}）`) : null)),
				!shown.length ? h('div', { className: 'cts-empty' }, '资产池为空，先上传新资产。')
					: h('div', { className: 'cts-picker' }, pickerList, previewPane));
			const taggedSection = taggedCount ? h('section', { className: 'cts-workbench-section' },
				h('div', { className: 'cts-workbench-section-head' }, h('h2', null, '本模块已添加'), h('span', { className: 'cts-hint' }, `${taggedCount} 份`)),
				h('div', { className: 'cts-list' },
					tagged.map((asset) => h('div', { className: 'cts-item', key: asset.id },
						h('div', { className: 'cts-item-t' }, asset.name),
						h('div', { className: 'cts-item-m' }, `${asset.kind || '资产'} · 项目：${(asset.projects || []).map((item) => item.name).join('、') || '未分配'}`))),
					mcpDesigns.map((row) => h('div', { className: 'cts-item', key: row.path },
						h('div', { className: 'cts-item-t' }, row.name || row.path),
						h('div', { className: 'cts-item-m' }, `UI 设计（Pixso MCP）· 版本 ${String(row.content_version || '').slice(0, 12)} · ${row.used ? '本轮生效' : row.exclusion || '已绑定'}`)))))
				: null;
			return h('div', { className: 'cts-module-start' },
				h('section', { className: 'cts-hero' },
					h('div', { className: 'cts-hero-kicker' }, '模块入口'),
					h('h1', null, `${module?.name || moduleId} · 第一步：添加资产`),
					h('p', null, '在下面直接预览资产池并选择导入，也可以上传新文件或从 Pixso MCP 导入当前设计稿；导入时自动绑定当前项目和模块。'),
					h('div', { className: 'cts-hero-actions' },
						h('button', { className: 'cts-btn primary', disabled: busy, onClick: taggedCount ? onNext : () => searchRef.current?.focus() }, taggedCount ? '下一步：进入 ECSM' : '选择本轮需求资料'),
						onOpenCenter ? h('button', { className: 'cts-btn', onClick: onOpenCenter }, '打开完整资产中心') : null,
						h('span', { className: 'cts-hint' }, `本模块已用 ${taggedCount} 份资产`))),
				h('div', { className: 'cts-option-grid' },
					h('section', { className: 'cts-option-card' },
						h('h3', null, '上传新资产 / 从 MCP 导入设计稿'),
						h('p', null, '上传后自动进入项目资产池并打上本模块标签；选择「设计稿目录」可直接查看本地 Pixso MCP 状态并选择原型页面导入。'),
						h('div', { className: 'cts-filter' },
							h('select', { className: 'cts-select', value: bucket, onChange: (event) => setBucket(event.target.value) },
								[['prd', 'PRD 目录'], ['signals', '信号目录'], ['design', '设计稿目录'], ['other', '其他资料目录']].map(([key, label]) => h('option', { key, value: key }, label))),
							h('label', { className: 'cts-btn primary', style: { cursor: 'pointer', margin: 0 } }, uploading ? '上传中…' : (bucket === 'design' ? '上传本地设计文件' : '选择文件上传'),
								h('input', { type: 'file', multiple: true, disabled: uploading || busy, style: { display: 'none' }, onChange: async (event) => { const files = [...(event.target.files || [])]; event.target.value = ''; await upload(files); } }))),
						bucket === 'design' ? h(DesignMcpPanel, {
							projectId,
							moduleId,
							moduleContext: true,
							onImported: onRefreshAssets,
							onError
						}) : null)),
				pickerSection,
				taggedSection);
		}

		function Page() {
			const navigationKey = 'cts:workbench-navigation-v1';
			const savedNavigation = React.useRef(null);
			const navigationReady = React.useRef(false);
			const [projects, setProjects] = React.useState([]);
			const [projectId, setProjectId] = React.useState('');
			const [messages, setMessages] = React.useState([]);
			const [evidence, setEvidence] = React.useState(null);
			const [building, setBuilding] = React.useState(false);
			const [designState, setDesignState] = React.useState(null);
			const [designBusy, setDesignBusy] = React.useState(false);
			const [artifacts, setArtifacts] = React.useState({ features: { items: [] }, facts: { items: [] }, points: { items: [] }, cases: { items: [] } });
			const [tab, changeTab] = React.useState('model');
			const [contractTarget, setContractTarget] = React.useState('');
			const [modelSection, setModelSection] = React.useState('contracts');
			const setTab = (value) => { setSelected(null); changeTab(value); };
			const [genBusy, setGenBusy] = React.useState('');
			const [phase, setPhase] = React.useState('');
			const [lintState, setLintState] = React.useState(null);
			const [selected, setSelected] = React.useState(null);
			const [coverageState, setCoverageState] = React.useState(null);
			const [reviewState, setReviewState] = React.useState(null);
			const [bindings, setBindings] = React.useState({ items: [] });
			const [packages, setPackages] = React.useState({ current: null, packages: [] });
			const [issuesState, setIssuesState] = React.useState({ total: 0, issues: [], bySource: {} });
			const [questions, setQuestions] = React.useState({ items: [] });
			const [impact, setImpact] = React.useState(null);
			const impactDialog = React.useRef(null);
			React.useEffect(() => { if (impact) impactDialog.current?.showModal(); }, [impact]);
			const [chatOpen, setChatOpen] = React.useState(false);
			const [newProjectOpen, setNewProjectOpen] = React.useState(false);
			const [newProjectName, setNewProjectName] = React.useState('');
			const [newModuleName, setNewModuleName] = React.useState('默认模块');
			const [settingsOpen, setSettingsOpen] = React.useState(false);
			const [settingsTab, setSettingsTab] = React.useState('project');
			const [settingsName, setSettingsName] = React.useState('');
			const [newSettingsModule, setNewSettingsModule] = React.useState('');
			const [qualityDraft, setQualityDraft] = React.useState(null);
			const [settingsBusy, setSettingsBusy] = React.useState(false);
			const [assetEntry, setAssetEntry] = React.useState({ project: '', module: '', scope: 'global' });
			const [centerOpen, setCenterOpen] = React.useState(false);
			const [centerStatus, setCenterStatus] = React.useState(null);
			const newProjectDialog = React.useRef(null);
			const settingsDialog = React.useRef(null);
			const centerDialog = React.useRef(null);
			React.useEffect(() => { if (newProjectOpen) newProjectDialog.current?.showModal(); else newProjectDialog.current?.close(); }, [newProjectOpen]);
			React.useEffect(() => { if (settingsOpen) settingsDialog.current?.showModal(); else settingsDialog.current?.close(); }, [settingsOpen]);
			React.useEffect(() => { if (centerOpen) centerDialog.current?.showModal(); else centerDialog.current?.close(); }, [centerOpen]);
			const [view, setView] = React.useState('home');
			const [navStack, setNavStack] = React.useState([]);
			const [navForward, setNavForward] = React.useState([]);
			const workPosition = React.useRef(new Map());
			const [modules, setModules] = React.useState([]);
			const [moduleId, setModuleId] = React.useState('');
			const post = (action, payload) => request(action, { module: moduleId || undefined, ...payload });
			const mode = view === 'design' ? 'design' : 'ecsm';
			const currentProject = projects.find((item) => item.id === projectId) || null;
			const refreshProjects = async (preferred) => {
				const state = await post('state');
				setProjects(state.projects || []);
				setDataDir(state.dataDir || '');
				const target = preferred ?? projectId;
				if (!target || !(state.projects || []).some((item) => item.id === target)) {
					const first = (state.projects || [])[0];
					setProjectId(first?.id || '');
					setModuleId('');
				}
				return state;
			};
			const openSettings = (tab = 'project') => {
				const project = projects.find((item) => item.id === projectId);
				setSettingsName(project?.name || '');
				setSettingsTab(tab);
				setNewSettingsModule('');
				setQualityDraft(project?.quality ? cloneQuality(project.quality) : null);
				setSettingsOpen(true);
			};
			const openCenter = async () => {
				try {
					setCenterStatus(await post('settings.status'));
					setCenterOpen(true);
				} catch (error) {
					setError(error.message);
				}
			};
			const refreshCenter = async () => {
				try { setCenterStatus(await post('settings.status')); } catch (error) { setError(error.message); }
			};
			const navSnapshot = () => ({ view, projectId, moduleId, assetEntry, tab, modelSection, contractTarget, selected, scrollY: (typeof window !== 'undefined' ? window.scrollY : 0) });
			React.useEffect(() => {
				if (!navigationReady.current || (view !== 'home' && projectId && !projects.some((item) => item.id === projectId))) return;
				try { sessionStorage.setItem(navigationKey, JSON.stringify(navSnapshot())); } catch {}
			}, [view, projectId, moduleId, assetEntry, tab, modelSection, contractTarget, selected, projects]);
			const pushHistory = () => {
				setNavStack((prev) => [...prev, navSnapshot()].slice(-60));
				setNavForward([]);
			};
			const openView = (next) => {
				if (next !== view) pushHistory();
				setError('');
				setView(next);
				setSelected(null);
				if (next === 'home' || next === 'center') setChatOpen(false);
				if (next === 'ecsm') { setTab('model'); setModelSection('contracts'); setContractTarget(''); }
				if (next === 'design') setTab('outline');
			};
			const applyNav = (target) => {
				setError('');
				setProjectId(target.projectId);
				setModuleId(target.moduleId);
				setAssetEntry(target.assetEntry);
				setView(target.view);
				changeTab(target.tab);
				setModelSection(target.modelSection);
				setContractTarget(target.contractTarget);
				setSelected(target.selected || null);
				setChatOpen(false);
				setTimeout(() => { try { window.scrollTo(0, Number(target.scrollY) || 0); } catch {} }, 0);
			};
			const goBack = () => {
				if (!navStack.length) return;
				const target = navStack[navStack.length - 1];
				setNavForward((prev) => [navSnapshot(), ...prev].slice(0, 60));
				applyNav(target);
				setNavStack((prev) => prev.slice(0, -1));
			};
			const goForward = () => {
				if (!navForward.length) return;
				const target = navForward[0];
				setNavStack((prev) => [...prev, navSnapshot()].slice(-60));
				applyNav(target);
				setNavForward((prev) => prev.slice(1));
			};
			const openProject = (project) => {
				if (!project) return;
				pushHistory();
				setProjectId(project.id);
				setModuleId('');
				setSelected(null);
				setChatOpen(false);
				setView('project');
			};
			const enterModule = async (id) => {
				if (!id) return;
				pushHistory();
				setModuleId(id);
				setSelected(null);
				try {
					const state = await post('assets.tags.view', { project: projectId, module: id });
					const assets = state.assets || [];
					setTaggedAssets(assets);
					const visible = assets.filter((asset) => (asset.tags || []).includes(id) || (asset.tags || []).includes(''));
					setChatOpen(false);
					if (visible.length) openView('ecsm');
					else setView('module-assets');
				} catch {
					setView('module-assets');
				}
			};
			const selectModule = enterModule;
			const refreshModuleTags = async () => {
				const state = await post('assets.tags.view', { project: projectId, module: moduleId });
				setTaggedAssets(state.assets || []);
				return state.assets || [];
			};
			const moduleUpload = async (files, bucket) => {
				const added = [];
				for (const file of files) {
					const response = await fetch('cts/api/upload', {
						method: 'POST',
						headers: {
							'content-type': 'application/octet-stream',
							'x-scope': 'project',
							'x-project': projectId,
							'x-dir': bucket,
							'x-filename': encodeURIComponent(file.name)
						},
						body: file
					});
					const body = await response.json().catch(() => null);
					if (!response.ok || !body?.ok) throw new Error(body?.error || '上传失败');
					added.push(body.state.added);
				}
				for (const relative of added) await post('assets.tags.update', { project: projectId, path: relative, module: moduleId, add: true });
				await refreshModuleTags();
				await loadAssets();
				setError(`已上传并加入本模块：${added.length} 份资产`);
			};
			const moduleTag = async (path, add) => {
				setError('');
				setItemBusy(true);
				try {
					await post('assets.tags.update', { project: projectId, path, module: moduleId, add });
					await refreshModuleTags();
					await loadAssets();
				} catch (err) { setError(err.message); }
				finally { setItemBusy(false); }
			};
			const moduleBatch = async (list) => {
				const assets = (list || []).filter(Boolean);
				if (!assets.length) return;
				setItemBusy(true); setError('');
				try {
					const items = assets.map((asset) => {
						const copy = (asset.copies || []).find((item) => item.project_id === projectId) || (asset.copies || []).find((item) => item.storage === 'inbox' || item.storage === 'mcp-pool') || (asset.copies || [])[0];
						return { id: asset.id, storage: copy?.storage || 'inbox', source_project: copy?.project_id || asset.projects?.[0]?.id || '', path: copy?.path || '', asset_hash: asset.hash || '' };
					});
					const preview = await post('assets.pool.batch', { project: projectId, module: moduleId, items });
					const lines = (preview.items || []).map((item) => `${item.action === 'error' ? '✗' : '✓'} ${item.path}: ${item.reason || item.action}`);
					if (!(await askConfirm({ title: `批量导入预览（${assets.length} 项）`, message: '确认将下列资产导入当前模块？', previewLines: lines, confirmText: '确认导入' }))) return;
					const result = await post('assets.pool.batch', { project: projectId, module: moduleId, items, commit: true });
					await refreshModuleTags();
					await loadAssets();
					const pool = await post('assets.pool.list').catch(() => null);
					if (pool) setPoolAssets(pool.assets || []);
					const materials = await post('sources.resolve', { project: projectId, module: moduleId }).catch(() => null);
					if (materials) setMaterialRows(materials.rows || []);
					if (result.failed?.length) setError(`批量导入完成，失败 ${result.failed.length} 项：${result.failed.join('、')}`);
					else setError(`批量导入完成：${result.results?.length || 0} 项`);
				} catch (err) { setError(err.message); }
				finally { setItemBusy(false); }
			};
			const moduleAdopt = async (targetAsset, sourceAsset) => {
				const target = (targetAsset.copies || []).find((copy) => copy.project_id === projectId);
				const source = (sourceAsset.copies || []).find((copy) => copy.storage === 'inbox') || (sourceAsset.copies || [])[0];
				if (!target || !source) { setError('找不到目标或来源副本'); return; }
				setItemBusy(true); setError('');
				try {
					const compared = await post('assets.compare', { project: projectId, module: moduleId,
						left: { storage: 'project', project_id: projectId, path: target.path },
						right: { storage: source.storage, project_id: source.project_id || '', path: source.path } });
					if (compared.same) { notify('两个版本内容相同，无需更新', 'info'); return; }
					const impacted = (compared.impact?.modules || []).filter((item) => item.visible).map((item) => item.name).join('、') || '无';
					if (!(await askConfirm({ title: '采用新版资产', message: `目标：${target.path}\n来源版本：${String(compared.right.hash).slice(0, 18)}\n影响模块：${impacted}`, confirmText: '采用新版' }))) return;
					await post('assets.adopt', { project: projectId, module: moduleId, target_path: target.path,
						source: { storage: source.storage, project_id: source.project_id || '', path: source.path }, source_hash: compared.right.hash });
					await refreshModuleTags();
					await loadAssets();
					const pool = await post('assets.pool.list').catch(() => null); if (pool) setPoolAssets(pool.assets || []);
					const materials = await post('sources.resolve', { project: projectId, module: moduleId }).catch(() => null); if (materials) setMaterialRows(materials.rows || []);
					notify('已采用为新版，正在分析受影响测试点与用例…', 'success');
					void openIncrementalImpact(target.path);
				} catch (err) { setError(err.message); }
				finally { setItemBusy(false); }
			};
			const moduleImport = async (asset) => {
				setError('');
				setItemBusy(true);
				try {
					const copy = (asset.copies || []).find((item) => item.project_id === projectId);
					const source = copy || (asset.copies || []).find((item) => item.storage === 'inbox' || item.storage === 'mcp-pool') || (asset.copies || [])[0];
					if (!source) throw new Error('找不到资产来源');
					await post('assets.pool.import', { storage: source.storage, source_project: source.project_id || '', path: source.path, asset_hash: asset.hash || '', project: projectId, module: moduleId });
					await refreshModuleTags();
					await loadAssets();
					const pool = await post('assets.pool.list').catch(() => null);
					if (pool) setPoolAssets(pool.assets || []);
					const materials = await post('sources.resolve', { project: projectId, module: moduleId }).catch(() => null);
					if (materials) setMaterialRows(materials.rows || []);
				} catch (err) { setError(err.message); }
				finally { setItemBusy(false); }
			};
			const moduleRef = React.useRef('');
			const scope = JSON.stringify([projectId, moduleId]);
			moduleRef.current = scope;
			React.useEffect(() => {
				const saved = workPosition.current.get(scope);
				if (saved) { setView(saved.view); changeTab(saved.tab); setModelSection(saved.modelSection); setContractTarget(''); }
			}, [scope]);
			const [loadedScope, setLoadedScope] = React.useState('');
			React.useEffect(() => {
				if (loadedScope === scope && view !== 'home') workPosition.current.set(scope, { view, tab, modelSection });
			}, [scope, view, tab, modelSection, loadedScope]);
			const openImpact = async (key, id) => {
				try {
					const result = await post('ecsm.impact', { project: projectId, [key]: id });
					if (moduleRef.current === scope) setImpact({ id, ...result });
				} catch (err) { if (moduleRef.current === scope) setError(err.message); }
			};
			const jump = (kind, id) => {
				impactDialog.current?.close();
				if (view === 'design' && (tab !== kind || selected?.id !== id)) pushHistory();
				openView('design');
				setTab(kind);
				setSelected({ kind, id });
			};
			const openWorkflow = (step, id) => {
				if (step === 'model' || step === 'tree') {
					openView('ecsm');
					setModelSection(step === 'tree' ? 'tree' : 'contracts');
					setContractTarget(id || '');
				} else if (step === 'fact' || step === 'questions') {
					openView('ecsm');
					setTab(step === 'fact' ? 'facts' : 'questions');
					if (step === 'fact') setSelected({ kind: 'facts', id });
				} else if (step === 'outline') {
					openView('design');
					setTab('outline');
				} else if (step === 'assets') {
					setAssetEntry({ project: projectId, module: moduleId, scope: moduleId ? 'module' : 'project' });
					openView('center');
				} else if (step === 'delivery') {
					openView('delivery');
				} else {
					jump(step, id);
				}
			};
			const [assets, setAssets] = React.useState([]);
			const [taggedAssets, setTaggedAssets] = React.useState([]);
			const [poolAssets, setPoolAssets] = React.useState([]);
			const [workbenchState, setWorkbenchState] = React.useState(null);
			const [designActivity, setDesignActivity] = React.useState(null);
			const [materialRows, setMaterialRows] = React.useState([]);
			const [moduleWorkbench, setModuleWorkbench] = React.useState({});
			const [moduleEvidence, setModuleEvidence] = React.useState(null);
			const [authorizeUrl, setAuthorizeUrl] = React.useState('');
			const [ecsmModel, setEcsmModel] = React.useState(null);
			const [agentsDoc, setAgentsDoc] = React.useState(null);
			const [agentBusy, setAgentBusy] = React.useState('');
			const [pkgBusy, setPkgBusy] = React.useState(false);
			const [bindingBusy, setBindingBusy] = React.useState(false);
			const [itemBusy, setItemBusy] = React.useState(false);
			const [draft, setDraft] = React.useState('');
			const [status, setStatus] = React.useState('loading');
			const [notice, setNotice] = React.useState(null);
			const [genProgress, setGenProgress] = React.useState(null);
			const [confirmModal, setConfirmModal] = React.useState(null);
			const [impactRun, setImpactRun] = React.useState(null);
			const impactRunDialog = React.useRef(null);
			React.useEffect(() => { if (impactRun) impactRunDialog.current?.showModal(); else if (impactRunDialog.current?.open) impactRunDialog.current.close(); }, [impactRun]);
			const openIncrementalImpact = async (targetPath = '') => {
				if (!projectId) return;
				try {
					const state = await post('impact.sourceChanges', { project: projectId, path: targetPath || undefined });
					setImpactRun({ loading: false, ...state });
				} catch (err) {
					notify(err.message, 'error');
				}
			};
			const confirmResolver = React.useRef(null);
			const askConfirm = (opts) => new Promise((resolve) => {
				confirmResolver.current = resolve;
				setConfirmModal(opts);
			});
			const closeConfirm = (result) => {
				setConfirmModal(null);
				const resolve = confirmResolver.current;
				confirmResolver.current = null;
				resolve?.(result);
			};
			const notify = React.useCallback((text, tone = 'info') => {
				if (!text) { setNotice(null); return; }
				setNotice({ tone, text: String(text) });
			}, []);
			const setError = React.useCallback((value) => {
				if (!value) { setNotice(null); return; }
				const msg = String(value);
				const isWarn = /还有\s*\d+|未通过|待处理|缺必填|未生成用例|问题：|已取消/.test(msg);
				const isOk = !isWarn && /(?:^已|完成|已保存|已删除|已冻结|已导出|已刷新|已重命名|已采用|已识别|已解析|已创建|已上传|已恢复|已导入)/.test(msg);
				const isErr = !isOk && !isWarn && /(?:失败|错误|不能|不存在|缺少|未找到|必须|断开|超时|越界|异常|只读|请先|没有)/.test(msg);
				setNotice({ tone: isOk ? 'success' : isWarn ? 'warning' : isErr ? 'error' : 'info', text: msg });
			}, []);
			const error = notice?.text || '';
			React.useEffect(() => {
				if (!notice || notice.tone === 'error') return;
				const timer = setTimeout(() => setNotice((cur) => (cur === notice ? null : cur)), 6500);
				return () => clearTimeout(timer);
			}, [notice]);
			const [dataDir, setDataDir] = React.useState('');
			const abortRef = React.useRef(null);
			const genAbortRef = React.useRef(null);
			const scrollRef = React.useRef(null);
			const followChat = React.useRef(true);
			const busyScope = Boolean(genBusy || building || designBusy || itemBusy || pkgBusy || bindingBusy || agentBusy || status === 'running');
			const deliveryBlocker = ecsmModel?.drifted
				? { step: 'model', message: '产品模型已更新，请在 ECSM 重新确认并冻结。' }
				: artifacts.delivery?.blocker;

			React.useEffect(() => {
				let alive = true;
				post('state')
					.then((state) => {
						if (!alive) return;
						setProjects(state.projects || []);
						setDataDir(state.dataDir || '');
						const list = state.projects || [];
						try { savedNavigation.current = JSON.parse(sessionStorage.getItem(navigationKey) || 'null'); } catch {}
						const saved = savedNavigation.current;
						const owner = list.find((item) => item.id === saved?.projectId);
						if (owner && (!saved.moduleId || owner.modules?.some((item) => item.id === saved.moduleId))) applyNav(saved);
						else if (list[0]) { setModuleId(''); setProjectId(list[0].id); }
						navigationReady.current = true;
						setStatus('idle');
					})
					.catch((err) => {
						if (!alive) return;
						setError(err.message);
						setStatus('error');
					});
				return () => { alive = false; };
			}, []);

			React.useEffect(() => {
				if (!projectId) return;
				let alive = true;
				post('module.list', { project: projectId })
					.then((state) => {
						if (!alive) return;
						setModules(state.modules || []);
						setModuleId((current) => (state.modules || []).some((item) => item.id === current) ? current : '');
					})
					.catch(() => {});
				return () => { alive = false; };
			}, [projectId]);

			React.useEffect(() => {
				if (!projectId) return;
				let alive = true;
				setMessages([]);
				setStatus('idle');
				setPhase('');
				setLintState(null);
				setEvidence(null);
				setEcsmModel(null);
				setCoverageState(null);
				setIssuesState(null);
				setAgentsDoc(null);
				setError('');
				setQuestions({ items: [] });
				setBindings({ items: [] });
				setPackages({ current: null, packages: [] });
				setDesignState(null);
				setAssets([]);
				setTaggedAssets([]);
				setPoolAssets([]);
				setArtifacts({});
				post('assets.list', { project: projectId }).then((state) => { if (alive) setAssets(state.assets || []); }).catch(() => {});
				post('assets.tags.view', { project: projectId, module: moduleId || undefined }).then((state) => { if (alive) setTaggedAssets(state.assets || []); }).catch(() => {});
				post('assets.pool.list').then((state) => { if (alive) setPoolAssets(state.assets || []); }).catch(() => {});
				post('workbench.state', { project: projectId, module: moduleId || undefined }).then((state) => { if (alive) setWorkbenchState(state); }).catch(() => {});
				const moduleList = (projects.find((item) => item.id === projectId)?.modules || []);
				Promise.all(moduleList.map(async (item) => [item.id, await post('workbench.state', { project: projectId, module: item.id }).catch(() => null)])).then((pairs) => { if (alive) setModuleWorkbench(Object.fromEntries(pairs.filter(([, value]) => value))); }).catch(() => {});
				post('sources.resolve', { project: projectId, module: moduleId || undefined }).then((state) => { if (alive) setMaterialRows(state.rows || []); }).catch(() => {});
				post('artifacts.load', { project: projectId })
					.then((state) => {
						if (!alive) return;
						setArtifacts(state);
						setLoadedScope(scope);
						setReviewState(state.review || null);
					})
					.catch((err) => { if (alive) { setLoadedScope(scope); setError(err.message); } });
				post('agents.list', { project: projectId })
					.then((state) => { if (alive) setAgentsDoc(state.document || null); })
					.catch(() => {});
				post('ecsm.view', { project: projectId })
					.then((state) => { if (alive) setEcsmModel(state); })
					.catch(() => {});
				post('questions.list', { project: projectId })
					.then((state) => { if (alive) setQuestions(state.document || { items: [] }); })
					.catch(() => {});
				post('issues.list', { project: projectId })
					.then((state) => { if (alive) setIssuesState(state); })
					.catch(() => {});
				post('package.list', { project: projectId })
					.then((state) => { if (alive) setPackages(state); })
					.catch(() => {});
				post('binding.list', { project: projectId })
					.then((state) => { if (alive) setBindings(state.document || { items: [] }); })
					.catch(() => {});
				post('design.state', { project: projectId })
					.then((state) => { if (alive) setDesignState(state); })
					.catch(() => {});
				post('coverage.diff', { project: projectId })
					.then((state) => { if (alive) setCoverageState(state); })
					.catch(() => {});
				post('evidence.index', { project: projectId })
					.then((state) => { if (alive) setEvidence(state.index || null); })
					.catch(() => {});
				post('replay', { project: projectId })
					.then((state) => {
						if (!alive) return;
						setMessages(fromEvents(state.events || []));
					})
					.catch(() => {});
				return () => { alive = false; };
			}, [projectId, moduleId]);

			React.useEffect(() => {
				const node = scrollRef.current;
				if (node && followChat.current) node.scrollTop = node.scrollHeight;
			}, [messages, chatOpen, view, loadedScope]);

			const pushDelta = (text) => {
				setMessages((prev) => {
					if (prev.length === 0) return prev;
					const next = prev.slice();
					const last = { ...next[next.length - 1] };
					last.text = (last.text || '') + text;
					next[next.length - 1] = last;
					return next;
				});
			};

			const send = async () => {
				const message = draft.trim();
				if (message === '' || projectId === '' || status === 'running') return;
				followChat.current = true;
				setDraft('');
				setError('');
				setStatus('running');
				setMessages((prev) => [
					...prev,
					{ id: `u-${Date.now()}`, role: 'user', text: message },
					{ id: `a-${Date.now()}`, role: 'agent', text: '', tools: [] }
				]);
				const controller = new AbortController();
				abortRef.current = controller;
				try {
					await streamSse('cts/api/chat', { project: projectId, module: moduleId, message }, (event, data) => {
						if (event === 'tool.start') {
							setMessages((prev) => {
								const next = prev.slice();
								const last = { ...next[next.length - 1] };
								last.tools = [...(last.tools || []), { callId: data.callId, tool: data.tool, input: data.input, summary: '', done: false }];
								next[next.length - 1] = last;
								return next;
							});
						} else if (event === 'tool.end') {
							setMessages((prev) => {
								const next = prev.slice();
								const last = { ...next[next.length - 1] };
								last.tools = (last.tools || []).map((card) => card.callId === data.callId ? { ...card, done: true, summary: data.summary, data: data.data } : card);
								next[next.length - 1] = last;
								return next;
							});
						} else if (event === 'text.delta') {
							pushDelta(data.text || '');
						} else if (event === 'error') {
							setError(`${data.code || 'ERROR'}：${data.message || ''}`);
						}
					}, controller.signal);
					setStatus('idle');
				} catch (err) {
					if (err.name !== 'AbortError') {
						setError(err.message);
						// The stream died mid-run: rebuild from the durable log rather than
						// leaving a half-rendered answer on screen.
						try {
							const state = await post('replay', { project: projectId });
							setMessages(fromEvents(state.events || []));
						} catch {
							// keep whatever is on screen
						}
					}
					setStatus('idle');
				} finally {
					abortRef.current = null;
				}
			};

			const refreshAll = async () => {
				const fresh = await post('artifacts.load', { project: projectId, module: moduleId });
				if (moduleRef.current !== scope) return;
				setArtifacts(fresh);
				setReviewState(fresh.review || null);
				const cov = await post('coverage.diff', { project: projectId, module: moduleId }).catch(() => null);
				if (moduleRef.current === scope && cov) setCoverageState(cov);
				const issues = await post('issues.list', { project: projectId, module: moduleId }).catch(() => null);
				if (moduleRef.current === scope && issues) setIssuesState(issues);
				const qs = await post('questions.list', { project: projectId, module: moduleId }).catch(() => null);
				if (moduleRef.current === scope && qs) setQuestions(qs.document || { items: [] });
				const ecsm = await post('ecsm.view', { project: projectId, module: moduleId }).catch(() => null);
				if (moduleRef.current === scope && ecsm) setEcsmModel(ecsm);
				const wb = await post('workbench.state', { project: projectId, module: moduleId }).catch(() => null);
				if (moduleRef.current === scope && wb) setWorkbenchState(wb);
				const materials = await post('sources.resolve', { project: projectId, module: moduleId }).catch(() => null);
				if (moduleRef.current === scope && materials) setMaterialRows(materials.rows || []);
			};

			const itemAction = async (work) => {
				setItemBusy(true);
				setError('');
				try {
					await work();
					await refreshAll();
				} catch (err) {
					setError(err.message);
				} finally {
					setItemBusy(false);
				}
			};

			const onSave = (kind, id, patch) => itemAction(() => post('artifact.update', { project: projectId, kind, id, patch }));
			const onImages = (id, edit) => itemAction(() => post('cases.images', { project: projectId, id, ...edit }));
			const onRegenerate = (kind, id) => itemAction(() => post('artifact.regenerate', { project: projectId, kind, id }));
			const onApprove = (kind, id, status) => itemAction(() => post(status === 'approved' ? 'artifact.approve' : 'artifact.reject', { project: projectId, kind, id }));
			const batchApproveContracts = async () => {
				const state = await post('contracts.approveAll', { project: projectId });
				await refreshAll();
				setError(`合同批量确认：${state.approved?.length || 0} 条通过${state.blocked?.length ? `，${state.blocked.length} 条未通过` : ''}`);
				return state;
			};
			const batchReview = async (kind, ids, status, scope = 'selected') => {
				if (scope === 'selected' && !ids.length) return { approved: [], blocked: [] };
				setItemBusy(true);
				try {
					const action = status === 'approved' ? 'artifact.approveBatch' : 'artifact.rejectBatch';
					const result = await post(action, { project: projectId, kind, ids, scope });
					const approved = result.approved || [];
					const blocked = result.blocked || [];
					await refreshAll();
					const verb = status === 'approved' ? '批准' : '退回';
					notify(
						`批量${verb}：${approved.length} 条成功${blocked.length ? `，${blocked.length} 条未通过（${blocked[0].error}${blocked.length > 1 ? ' 等' : ''}）` : ''}`,
						blocked.length ? 'warning' : 'success'
					);
					return { approved, blocked };
				} catch (err) {
					notify(err.message, 'error');
					return { approved: [], blocked: [] };
				} finally {
					setItemBusy(false);
				}
			};
			const onDelete = async (kind, id) => {
				if (!(await askConfirm({ title: '删除条目', message: `确认删除 ${id}？删除后无法撤销。`, confirmText: '删除', danger: true }))) return;
				setSelected(null);
				itemAction(() => post('artifact.delete', { project: projectId, kind, id }));
			};
			const onClear = async (kind) => {
				const label = kind === 'facts' ? '事实' : kind === 'points' ? '测试点' : '用例';
				if (!(await askConfirm({ title: `清空全部${label}`, message: `确认清空当前模块的全部${label}？此操作不可撤销。`, confirmText: `清空${label}`, danger: true }))) return;
				try {
					await post('artifact.clear', { project: projectId, kind });
					await refreshAll();
					notify(`已清空全部${label}`, 'success');
				} catch (err) {
					notify(err.message, 'error');
				}
			};

			const suggestBindings = async () => {
				if (bindingBusy) return;
				setBindingBusy(true);
				setError('');
				try {
					await post('binding.suggest', { project: projectId });
					const state = await post('binding.list', { project: projectId });
					setBindings(state.document || { items: [] });
					await refreshAll();
				} catch (err) {
					setError(err.message);
				} finally {
					setBindingBusy(false);
				}
			};

			const confirmBinding = async (bindingId, candidate) => {
				setBindingBusy(true);
				try {
					await post('binding.confirm', { project: projectId, binding_id: bindingId, candidate });
					const state = await post('binding.list', { project: projectId });
					setBindings(state.document || { items: [] });
					await refreshAll();
				} catch (err) {
					setError(err.message);
				} finally {
					setBindingBusy(false);
				}
			};

			const packageAction = async (action) => {
				setPkgBusy(true);
				setError('');
				try {
					await post(`package.${action}`, { project: projectId });
					const state = await post('package.list', { project: projectId });
					if (moduleRef.current === scope) setPackages(state);
					if (moduleRef.current === scope) await refreshAll();
				} catch (err) {
					setError(err.message);
				} finally {
					setPkgBusy(false);
				}
			};

			const manualBinding = async (bindingId, nodeId) => {
				setBindingBusy(true);
				setError('');
				try {
					await post('binding.manual', { project: projectId, binding_id: bindingId, node_id: nodeId });
					const state = await post('binding.list', { project: projectId });
					setBindings(state.document || { items: [] });
					await refreshAll();
				} catch (err) {
					setError(err.message);
				} finally {
					setBindingBusy(false);
				}
			};

			const compileDesign = async (force) => {
				if (designBusy) return;
				setDesignBusy(true);
				setError('');
				try {
					const state = await post('design.compile', { project: projectId, force: force === true });
					setDesignState({ available: true, reused: state.reused, store: state.store, sources: state.sources });
					setError(`设计稿已解析：${state.sources.length} 份${state.reused ? '（复用旧编译结果）' : ''}`);
				} catch (err) {
					setError(err.message);
				} finally {
					setDesignBusy(false);
				}
			};

			const runKind = async (kind, draft = false, replace, feature_ids, point_ids, sourceMode, redoSelected = false) => {
				let result;
				let failure;
				const fastTrack = sourceMode === 'facts';
				const fromBranches = !draft && !fastTrack && kind === 'points' && artifacts.outlineStatus?.sourceKind === 'branches';
				const controller = new AbortController();
				genAbortRef.current = controller;
				setGenProgress(null);
				const payload = {
					project: projectId,
					module: moduleId,
					kind,
					draft,
					replace,
					feature_ids,
					point_ids,
					...(redoSelected ? { redo_selected: true } : {}),
					...(fastTrack ? { source_mode: 'facts', require_outline: false, from_branches: false, from_contracts: false }
						: { require_outline: !draft && ['points', 'cases'].includes(kind), from_branches: fromBranches, from_contracts: !draft && kind === 'points' && !fromBranches }),
					...(kind === 'points' && currentProject?.quality ? {
						coverage_mode: currentProject.quality.coverage_mode === 'exhaustive' ? 'exhaustive' : 'standard',
						include_single_entries: currentProject.quality.include_single_entries === true || currentProject.quality.coverage_mode === 'exhaustive'
					} : {})
				};
				try {
					await streamSse('cts/api/generate', payload, (event, data) => {
						if (event === 'run.end') result = data;
						if (event === 'phase') {
							setPhase(data.label || '');
							if (data.total) setGenProgress({ step: data.step || 0, total: data.total, label: data.label || '' });
						} else if (event === 'artifact.updated') {
							const label = { features: '个功能点', facts: '条事实', points: '个测试点', cases: '条用例' }[data.kind];
							if (data.kind === 'states') setPhase(`已推导 ${data.count} 个状态机…`);
							else if (label) setPhase(`已生成 ${data.count} ${label}…`);
						} else if (event === 'gate.request') {
							setMessages((prev) => {
								const next = prev.slice();
								const last = { ...next[next.length - 1] };
								last.gate = { gateId: data.gateId, question: data.question, options: data.options || [], answered: false };
								next[next.length - 1] = last;
								return next;
							});
						} else if (event === 'questions.updated') {
							setPhase(data.open > 0 ? `待回答 ${data.open} 个问题` : '没有待回答问题');
						} else if (event === 'worker') {
							setPhase(`事实 worker 调用 ${data.tool}…`);
						} else if (event === 'lint') setLintState(data);
						else if (event === 'dropped') {
							const reasons = Object.entries(data.reasons || {}).map(([key, value]) => `${key}×${value}`).join('，');
							setPhase(`门禁退回 ${data.total} 条候选（${reasons}）`);
						} else if (event === 'run.end' && data.kind === 'states') {
							setPhase(`状态推导完成，共 ${data.count} 个状态机`);
						} else if (event === 'run.end' && data.kind === 'points') {
							const scopeLabel = { outline: '本轮大纲', contracts: '已确认合同', model: '产品模型' }[data.transitionScope] || '当前范围';
							const clInfo = data.closed_loop_coverage?.total
								? ` · 闭环 ${data.closed_loop_coverage.covered}/${data.closed_loop_coverage.total}`
								: '';
							setPhase(`已生成 ${data.count} 个测试点${clInfo} · ${scopeLabel}`);
						} else if (event === 'run.end' && data.kind === 'cases') {
							setPhase([`已生成 ${data.count} 条用例`,
								data.missing > 0 ? `${data.missing} 个测试点未生成用例` : '',
								data.missingInterfaceImages > 0 ? `${data.missingInterfaceImages} 条待补界面图` : '',
								data.imageWarning ? `配图提示：${data.imageWarning}` : ''].filter(Boolean).join(' · '));
						} else if (event === 'error') failure = data.message || '生成失败';
					}, controller.signal);
				} finally {
					genAbortRef.current = null;
					setGenProgress(null);
				}
				if (failure || !result) throw new Error(failure || '生成连接已断开，请重试');
				if (result.count === 0 && kind === 'contracts') notify('没有新增合同，请检查所选功能的有效证据或已有合同。', 'warning');
				if (result.count === 0 && kind !== 'contracts') throw new Error('没有生成可用条目，请检查输入资料后重试');
				if (kind === 'contracts' && result.incomplete > 0) {
					const names = (result.incomplete_contracts || []).slice(0, 3).map((item) => item.title || item.contract_id).join('、');
					notify(`合同列表现有 ${result.incomplete} 份缺必填字段${names ? `（${names}）` : ''}（本次新增 ${result.count} 份），补齐后再确认。`, 'warning');
				}
				if (kind === 'cases' && result.failures?.length) {
					const first = result.failures[0];
					notify(`${result.failures.length} 个测试点未生成用例：${first.point_id}（${String(first.error || '').slice(0, 80)}）${result.failures.length > 1 ? ' 等' : ''}。可在用例页重试失败点。`, 'warning');
				} else if (kind === 'points' || kind === 'cases') {
					notify(`${kind === 'points' ? '测试点' : '用例'}生成完成（共 ${result.count} 条）`, 'success');
				}
				await refreshAll();
			};
			const cancelGenerate = async () => {
				genAbortRef.current?.abort();
				genAbortRef.current = null;
				setGenProgress(null);
				notify('已取消当前生成任务（已完成的批次已自动保留）', 'warning');
				await refreshAll().catch(() => {});
			};

			const autoConfigure = async () => {
				try {
					const state = await post('project.autoConfig', { project: projectId });
					if (state?.updated) await refreshProjects(projectId);
					return state;
				} catch {
					return null;
				}
			};
			const generateContracts = async () => {
				const ids = (artifacts.features?.items || []).map((item) => item.feature_id).filter(Boolean);
				if (!ids.length) { setError('还没有功能点，先「生成上游草稿」'); return; }
				await generate('contracts', undefined, ids);
			};
			const generate = async (kind, replace, featureIds, pointIds, sourceMode, redoSelected = false) => {
				if (busyScope || !projectId) return;
				if (kind !== 'contracts') setTab(kind);
				setGenBusy(kind);
				setPhase('');
				setLintState(null);
				setNotice(null);
				try {
					await autoConfigure();
					await runKind(kind, false, replace, featureIds, pointIds, sourceMode, redoSelected);
				} catch (err) {
					if (err?.name === 'AbortError') notify('已取消当前生成任务（已完成的批次已自动保留）', 'warning');
					else notify(err.message, 'error');
				} finally {
					setGenBusy('');
					setGenProgress(null);
				}
			};
			const updateQuickQuality = async (patch) => {
				if (!currentProject || currentProject.readonly) return;
				try {
					const base = currentProject.quality ? cloneQuality(currentProject.quality) : qualityTemplate('full');
					const next = { ...base, ...patch };
					await post('project.update', { project: projectId, quality: next });
					await refreshProjects(projectId);
					notify(`展开粒度已切换为「${next.coverage_mode === 'exhaustive' ? '全量展开' : '标准'}」`, 'success');
				} catch (err) {
					notify(err.message, 'error');
				}
			};

			/** Beginners: one click runs the whole chain in order. */
			const reloadEcsm = async () => {
				try {
					const state = await post('ecsm.view', { project: projectId });
					setEcsmModel(state);
				} catch (err) {
					setError(err.message);
				}
			};

			const freezeEcsm = async () => {
				try {
					const state = await post('ecsm.freeze', { project: projectId });
					const issues = state.stateIssues?.count || 0;
					setError(`ECSM v${state.version} 已冻结（摘要 ${state.digest.slice(0, 8)}）${issues
						? ` · 状态机 issue ${issues} 条待处理（不影响冻结，建议先在模型树核对）` : ''}`);
					await refreshAll();
				} catch (err) {
					setError(err.message);
				}
			};

			const loadAssets = async () => {
				try {
					const state = await post('assets.list', { project: projectId });
					if (moduleRef.current === scope) setAssets(state.assets || []);
				} catch (err) {
					setError(err.message);
				}
			};

			React.useEffect(() => {
				if (projectId && view === 'assets') loadAssets();
			}, [scope, view]);

			const addAsset = async (dir, filePath) => {
				const cleaned = String(filePath || '').trim().replace(/^['"]|['"]$/g, '');
				if (cleaned === '') { setError('请先填写文件路径'); return; }
				setError(`正在添加：${cleaned}`);
				try {
					const state = await post('assets.add', { project: projectId, dir, path: cleaned });
					await loadAssets();
					setError(`已添加：${state.added}`);
				} catch (err) {
					setError(`添加失败：${err.message}`);
				}
			};

			const uploadAsset = async (dir, file) => {
				setError(`上传中：${file.name}（${Math.round(file.size / 1024)} KB）…`);
				try {
					await fetch('cts/api/upload', {
						method: 'POST',
						headers: {
							'content-type': 'application/octet-stream',
							'x-project': projectId,
							'x-dir': dir,
							'x-filename': encodeURIComponent(file.name)
						},
						body: file
					}).then(async (response) => {
						const body = await response.json();
						if (!body.ok) throw new Error(body.error || '上传失败');
					});
					await loadAssets();
				} catch (err) {
					setError(err.message);
					throw err;
				}
			};

			const copyAuthorizeUrl = async () => {
				try {
					const state = await post('design.oauthUrl', { origin: window.location.origin });
					setAuthorizeUrl(state.url);
					try {
						await navigator.clipboard.writeText(state.url);
						setError('授权链接已生成并复制，粘贴到浏览器打开');
					} catch {
						setError('链接已生成，请手动复制下面的地址');
					}
				} catch (err) {
					setError(err.message);
				}
			};

			const [authorizeNote, setAuthorizeNote] = React.useState('');
			const [mcpNote, setMcpNote] = React.useState('');

			const authorizePixso = async () => {
				// window.open is denied for external origins inside the DSH webview,
				// so the host process launches the system browser instead.
				try {
					setAuthorizeNote('正在打开浏览器…');
					const state = await post('design.openAuthorize', { origin: window.location.origin });
					setAuthorizeUrl(state.url);
					setAuthorizeNote(state.opened
						? '已在浏览器打开授权页；登录同意后回这里点「检测连接」'
						: `浏览器没自动打开（${state.error || '未知原因'}），请复制下面的链接`);
				} catch (err) {
					setAuthorizeNote(`打开失败：${err.message}`);
				}
			};

			const probeMcp = async () => {
				setMcpNote('检测中…');
				try {
					const state = await post('design.mcp', { project: projectId });
					const oauth = state.oauth || {};
					const lines = [];
					lines.push(state.connected ? `已连接（${state.mode}）` : `未连接（${state.mode}）`);
					lines.push(`令牌：${state.token || 'none'}${oauth.hasToken ? '（有 access_token）' : ''}`);
					if (state.connected) lines.push(`工具：${(state.tools || []).join(' / ')}`);
					if (state.error) lines.push(`原因：${state.error}`);
					if (oauth.lastCallback) lines.push(`最近回调：${oauth.lastCallback.ok ? '成功' : '失败'} · ${oauth.lastCallback.at}${oauth.lastCallback.error ? ' · ' + oauth.lastCallback.error : ''}`);
					setMcpNote(lines.join('\n'));
				} catch (err) {
					setMcpNote(`检测失败：${err.message}`);
				}
			};

			const renderNode = async (nodeId, link) => {
				try {
					const state = await post('design.render', { project: projectId, guid: nodeId, link, dsl: true });
					setError(`已渲染：${state.file}`);
				} catch (err) {
					setError(err.message);
				}
			};

			const importLibrary = async () => {
				setMcpNote('正在导入组件库…（保持 Pixso 插件窗口与文件打开）');
				try {
					const state = await post('design.importLibrary', { project: projectId, limit: 40, scale: 1 });
					setMcpNote(`组件库：共 ${state.total} 个，本次处理 ${state.pool} 个（新导出 ${state.rendered}、已存在 ${state.skipped}、失败 ${state.failed}）\n目录：${state.dir}`);
				} catch (err) {
					setMcpNote(`组件库导入失败：${err.message}`);
				}
			};

			const renderAll = async () => {
				setMcpNote('正在整文件渲染…（保持 Pixso 插件窗口打开）');
				try {
					const state = await post('design.renderAll', { project: projectId, limit: 40, scale: 1 });
					setMcpNote(`整文件渲染完成：成功 ${state.rendered} 张，失败 ${state.failed} 张`);
				} catch (err) {
					setMcpNote(`整文件渲染失败：${err.message}`);
				}
			};

			const loadModuleEvidence = async (id) => {
				try {
					const state = await post('evidence.module', { project: projectId, module: id });
					setModuleEvidence(state);
				} catch (err) {
					setError(err.message);
				}
			};

			const removeAsset = async (relative) => {
				try {
					await post('assets.remove', { project: projectId, path: relative });
					await loadAssets();
				} catch (err) {
					setError(err.message);
				}
			};

			const createProject = async (name, moduleName) => {
				try {
					const state = await post('project.create', { name, module: moduleName || '默认模块' });
					await refreshProjects(state.project?.id);
					if (state.project?.id) {
						openProject(state.project);
					}
					setNewProjectOpen(false);
					notify(`已创建项目「${state.project?.name || name}」，点击模块即可导入资料并开始流程。`, 'success');
				} catch (err) {
					notify(err.message, 'error');
				}
			};

			const createModule = async (name, keywords) => {
				try {
					await post('module.create', { project: projectId, name, keywords });
					const state = await post('module.list', { project: projectId });
					setModules(state.modules || []);
				} catch (err) {
					setError(err.message);
				}
			};

			const updateModule = async (id, patch) => {
				try {
					await post('module.update', { project: projectId, id, ...patch });
					const state = await post('module.list', { project: projectId });
					setModules(state.modules || []);
					await refreshProjects(projectId);
				} catch (err) {
					setError(err.message);
				}
			};
			const deleteModule = async (id) => {
				if (!(await askConfirm({ title: '删除模块', message: '确认删除该模块？模块产物会移入项目回收目录，且不可在界面恢复。', confirmText: '删除模块', danger: true }))) return;
				try {
					setSettingsBusy(true);
					await post('module.delete', { project: projectId, id });
					const state = await post('module.list', { project: projectId });
					setModules(state.modules || []);
					if (moduleId === id) setModuleId(state.modules?.[0]?.id || '');
					await refreshProjects(projectId);
					notify('模块已删除', 'success');
				} catch (err) {
					notify(err.message, 'error');
				} finally {
					setSettingsBusy(false);
				}
			};
			const renameModule = async (module) => {
				const name = await askConfirm({ title: '重命名模块', inputLabel: '新的模块名称', inputValue: module.name, confirmText: '保存名称' });
				if (!name || typeof name !== 'string' || name.trim() === '' || name.trim() === module.name) return;
				try {
					setSettingsBusy(true);
					await updateModule(module.id, { name: name.trim() });
					notify('模块已重命名', 'success');
				} finally {
					setSettingsBusy(false);
				}
			};
			const saveProjectName = async () => {
				const name = settingsName.trim();
				if (name === '') { setError('项目名不能为空'); return; }
				try {
					setSettingsBusy(true);
					await post('project.update', { project: projectId, name });
					await refreshProjects(projectId);
					setError('项目名已更新');
				} catch (err) {
					setError(err.message);
				} finally {
					setSettingsBusy(false);
				}
			};
			const toggleQualityCapability = (capability) => {
				if (!qualityDraft) return;
				const current = Array.isArray(qualityDraft.capabilities) ? qualityDraft.capabilities : [];
				setQualityDraft({ ...qualityDraft,
					capabilities: current.includes(capability) ? current.filter((item) => item !== capability) : [...current, capability] });
			};
			const updateQualitySource = (role, value) => {
				if (!qualityDraft) return;
				setQualityDraft({ ...qualityDraft, sources: { ...(qualityDraft.sources || {}), [role]: value } });
			};
			const detectQuality = async () => {
				try {
					setSettingsBusy(true);
					const detected = await post('project.suggestQuality', { project: projectId });
					setQualityDraft((current) => ({
						...(current || {}),
						capabilities: detected.capabilities,
						surfaces: current?.surfaces?.length ? current.surfaces : detected.surfaces,
						default_surface: current?.default_surface || detected.default_surface,
						sources: { ...(current?.sources || {}), ...detected.sources }
					}));
					setError(detected.sources?.prd ? '已按项目资料识别生成配置，请核对页面词表后保存' : '没有识别到 PRD 文件，请先上传资料');
				} catch (err) { setError(err.message); }
				finally { setSettingsBusy(false); }
			};
			const saveQuality = async () => {
				if (!qualityDraft) { setError('请先选择生成配置模板'); return; }
				try {
					setSettingsBusy(true);
					const quality = cloneQuality(qualityDraft);
					quality.surfaces = (quality.surfaces || []).map((item) => item.trim()).filter(Boolean);
					if (!quality.default_surface && quality.surfaces.length) quality.default_surface = quality.surfaces[0];
					await post('project.update', { project: projectId, quality });
					await refreshProjects(projectId);
					const diagnosis = await post('project.diagnose', { project: projectId });
					const issues = diagnosis.issues || [];
					setError(issues.length ? `生成配置已保存，但还有 ${issues.length} 个问题：${issues.map((item) => item.message).join('；')}` : '生成配置已保存');
				} catch (err) {
					setError(err.message);
				} finally {
					setSettingsBusy(false);
				}
			};
			const deleteCurrentProject = async () => {
				if (!currentProject || currentProject.readonly) return;
				if (!(await askConfirm({ title: `永久删除项目「${currentProject.name}」`, message: '项目资料、证据、产物和导出都会被永久删除，不可恢复。', confirmText: '永久删除', danger: true }))) return;
				try {
					setSettingsBusy(true);
					await post('project.delete', { project: projectId });
					setSettingsOpen(false);
					await refreshProjects('');
					openView('home');
					setNavStack([]);
					setNavForward([]);
					setError('项目已删除');
				} catch (err) {
					setError(err.message);
				} finally {
					setSettingsBusy(false);
				}
			};

			const loadEcsmVersion = async (version) => {
				try { return await post('ecsm.version', { project: projectId, version }); }
				catch (err) { if (moduleRef.current === scope) setError(err.message); return null; }
			};

			const exportEcsm = async (frozen = false, version) => {
				try {
					const state = await post('ecsm.export', { project: projectId, frozen: frozen === true, version });
					setError(`ECSM 已导出：${state.file}（${state.stats.features} 功能点 / ${state.stats.facts} 事实 / ${state.stats.transitions} 转移，摘要 ${state.digest.slice(0, 8)}）`);
				} catch (err) {
					setError(err.message);
				}
			};

			const runAgent = async (kind) => {
				if (agentBusy) return;
				setAgentBusy(kind);
				setError('');
				try {
					const state = await post('agents.run', { project: projectId, kind, limit: 8 });
					const fresh = await post('agents.list', { project: projectId });
					setAgentsDoc(fresh.document || null);
					setError(`${kind === 'facts' ? '事实' : '用例'}复核完成：检查 ${state.checked} 条，发现 ${state.findings.length} 个问题`);
				} catch (err) {
					setError(err.message);
				} finally {
					setAgentBusy('');
				}
			};

			const dismissAll = async () => {
				try {
					await post('questions.dismiss', { project: projectId, ids: questions.items.filter((item) => (item.scope || 'design') === mode && item.status === 'open').map((item) => item.id) });
					const state = await post('questions.list', { project: projectId });
					setQuestions(state.document || { items: [] });
				} catch (err) {
					setError(err.message);
				}
			};

			const dismissQuestion = async (id) => {
				try {
					await post('questions.dismiss', { project: projectId, id });
					const state = await post('questions.list', { project: projectId });
					setQuestions(state.document || { items: [] });
				} catch (err) {
					setError(err.message);
				}
			};

			const answerQuestion = async (id, value, apply = false) => {
				try {
					await post('questions.answer', { project: projectId, id, answer: value, apply });
					await refreshAll();
				} catch (err) {
					setError(err.message);
				}
			};

			const answerGate = async (gateId, value) => {
				setMessages((prev) => prev.map((entry) => entry.gate && entry.gate.gateId === gateId
					? { ...entry, gate: { ...entry.gate, answered: true, answer: value } }
					: entry));
				try {
					await post('gate.answer', { project: projectId, gate_id: gateId, answer: value });
				} catch (err) {
					setError(err.message);
				}
			};

			const runAll = async () => {
				if (busyScope || !projectId) return;
				setGenBusy('all');
				setError('');
				setLintState(null);
				try {
					await autoConfigure();
					if (!evidence?.stats?.items) await build(true);
					for (const [kind, label] of [['facts', '生成事实'], ['features', '归并功能点'], ['states', '推导状态']]) {
						setPhase(`正在${label}…`);
						try { await runKind(kind, true); }
						catch (err) { throw new Error(`${label}失败：${err.message}`); }
					}
					setPhase('草稿已生成');
				} catch (err) {
					setError(err.message);
				} finally {
					setGenBusy('');
				}
			};

			const exportCases = async (options = {}) => {
				try {
					const state = await post('artifacts.export', { project: projectId, ...(options || {}) });
					if (moduleRef.current === scope) notify(`已导出草稿 Excel（${state.count} 条）${state.warning ? ' · ' + state.warning : ''}`, state.warning ? 'warning' : 'success');
					return state;
				} catch (err) {
					notify(err.message, 'error');
					return null;
				}
			};
			const exportCandidate = async (options = {}) => {
				try {
					const state = await post('artifacts.exportBundle', { project: projectId, module: moduleId, label: 'candidate', ...(options || {}) });
					const missing = state.missingImages?.length || 0;
					notify(`已导出候选包（${state.count} 条，含 xlsx/html/json/md）${missing ? ` · ${missing} 张引图缺失已跳过` : ''}`, 'success');
					return state;
				} catch (err) {
					notify(err.message, 'error');
					return null;
				}
			};

			const build = async (throwOnError = false) => {
				if (building || !projectId) return;
				setBuilding(true);
				setError('');
				try {
					const configured = await autoConfigure();
					const state = await post('evidence.build', { project: projectId });
					const fresh = await post('evidence.index', { project: projectId });
					setEvidence(fresh.index || null);
					await refreshAll();
					setError('');
					if (state && state.stats) setError(`证据构建完成：${state.stats.items} 条 / ${state.stats.chars} 字${configured?.updated ? ' · 已按资料自动识别生成配置' : ''}`);
				} catch (err) {
					if (throwOnError === true) throw err;
					setError(err.message);
				} finally {
					setBuilding(false);
				}
			};

			const stop = () => {
				abortRef.current?.abort();
				abortRef.current = null;
				setStatus('idle');
			};

			if (status === 'loading') {
				return h('div', { className: 'cts-page' }, h('style', null, CSS), h('div', { className: 'cts-empty' }, '正在读取项目…'));
			}

			return h('div', { className: 'cts-page' },
				h('style', null, CSS),
				h('div', { className: 'cts-head' },
					h('div', { className: 'cts-nav' },
						h('button', { className: 'cts-navbtn', title: '后退', 'aria-label': '后退', disabled: navStack.length === 0, onClick: goBack }, '←'),
						h('button', { className: 'cts-navbtn', title: '前进', 'aria-label': '前进', disabled: navForward.length === 0, onClick: goForward }, '→')),
					h('button', { className: 'cts-btn primary', disabled: busyScope,
						onClick: () => { setNewProjectName(''); setNewModuleName('默认模块'); setNewProjectOpen(true); } }, '+ 新建项目'),
					h('button', { className: 'cts-btn', onClick: openCenter }, '设置'),
					h('div', { className: 'cts-modes' },
						h('button', { className: `cts-mode${view === 'home' ? ' on' : ''}`, onClick: () => openView('home') }, '工作台'),
						h('button', { className: `cts-mode${view === 'center' ? ' on' : ''}`, onClick: () => { setAssetEntry({ project: '', module: '', scope: projects.length ? 'project' : 'global' }); openView('center'); } }, '资产中心')),
					h('div', { className: 'cts-status' },
						h('span', { className: `cts-dot${status === 'running' || genBusy ? ' on' : ''}${notice?.tone === 'error' ? ' err' : ''}` }),
						h('span', null, view === 'home' ? `${projects.length} 个项目` : view === 'center' ? '资产中心' : currentProject?.name || '项目')),
					h(ActivityPanel, { projects, projectId: view === 'home' ? '' : projectId, moduleId: view === 'home' ? '' : moduleId, onOpenDesign: (item) => {
						pushHistory();
					setProjectId(item.project);
					setModuleId(item.module);
						setDesignActivity(item);
					setSelected(null);
					setView('assets');
					setChatOpen(false);
					} })
				),
				projectId && view !== 'home' && view !== 'center' ? h('div', { className: 'cts-projectbar' },
					h('button', { className: 'cts-crumb', onClick: () => openProject(currentProject) }, `工作台 / ${currentProject?.name || ''}`),
					h('select', { className: 'cts-select', value: moduleId, disabled: busyScope, 'aria-label': '模块',
						onChange: async (event) => { const next = event.target.value; if (next) await enterModule(next); } },
						h('option', { value: '' }, '选择模块'),
						modules.map((item) => h('option', { key: item.id, value: item.id }, item.name || item.id))),
					h('div', { className: 'cts-modes' },
						h('button', { className: `cts-mode${view === 'ecsm' ? ' on' : ''}`, disabled: !moduleId || (!taggedAssets.some((asset) => (asset.tags || []).includes(moduleId) || (asset.tags || []).includes('')) && !materialRows.some((row) => row.selected && row.kind === 'pixso-mcp')), onClick: () => openView('ecsm') }, 'ECSM'),
						h('button', { className: `cts-mode${view === 'design' ? ' on' : ''}`, disabled: !moduleId || (!taggedAssets.some((asset) => (asset.tags || []).includes(moduleId) || (asset.tags || []).includes('')) && !materialRows.some((row) => row.selected && row.kind === 'pixso-mcp')), onClick: () => openView('design') }, '测试设计'),
						h('button', { className: `cts-mode${view === 'delivery' ? ' on' : ''}`, disabled: !moduleId || (!taggedAssets.some((asset) => (asset.tags || []).includes(moduleId) || (asset.tags || []).includes('')) && !materialRows.some((row) => row.selected && row.kind === 'pixso-mcp')), onClick: () => openView('delivery') }, '交付')),
					h('button', { className: 'cts-btn', disabled: !moduleId, onClick: () => { setAssetEntry({ project: projectId, module: moduleId, scope: 'module' }); openView('center'); } }, '资产'),
					h('button', { className: 'cts-btn', onClick: () => openSettings('project') }, '项目设置'),
					h('button', { className: 'cts-btn', 'aria-expanded': chatOpen, disabled: !moduleId || view === 'assets', onClick: () => { if (!chatOpen) followChat.current = true; setChatOpen(!chatOpen); } }, chatOpen ? '收起 Agent' : '打开 Agent'),
					h('div', { className: 'cts-status' },
						h('span', { className: `cts-dot${status === 'running' || genBusy ? ' on' : ''}${notice?.tone === 'error' ? ' err' : ''}` }),
						h('span', null, !moduleId ? '先选择模块' : view === 'module-assets' ? '先添加资产' : busyScope ? '处理中' : packages.current ? `交付 v${packages.current.version}` : ecsmModel?.current ? `模型 v${ecsmModel.current.version}` : '工作草稿'))) : null,
				newProjectOpen ? h('dialog', { ref: newProjectDialog, onClose: () => setNewProjectOpen(false), style: { width: 'min(520px, 92vw)' } },
					h('h3', null, '新建项目'),
					h('p', { className: 'cts-hint' }, `项目会创建在当前数据目录：${dataDir || '插件数据目录'}。创建后直接进入项目页，选择模块即可导入或上传需求资料。`),
					h('div', { className: 'cts-field' }, h('span', { className: 'cts-field-l' }, '项目名称'),
						h('input', { className: 'cts-input', autoFocus: true, value: newProjectName, placeholder: '例如：项目名称',
							onChange: (event) => setNewProjectName(event.target.value),
							onKeyDown: (event) => { if (event.key === 'Enter' && newProjectName.trim()) createProject(newProjectName.trim(), newModuleName.trim() || '默认模块'); } })),
					h('div', { className: 'cts-field' }, h('span', { className: 'cts-field-l' }, '首个模块名称'),
						h('input', { className: 'cts-input', value: newModuleName,
							onChange: (event) => setNewModuleName(event.target.value) })),
					h('p', { className: 'cts-hint' }, '创建后直接上传资料；构建证据或生成 ECSM 时，系统会按资料自动识别生成配置。需要例外时再到「项目设置 → 生成配置」手动调整。'),
					h('div', { className: 'cts-filter', style: { marginTop: 12 } },
						h('button', { className: 'cts-btn primary', disabled: !newProjectName.trim() || busyScope, onClick: () => createProject(newProjectName.trim(), newModuleName.trim() || '默认模块') }, '创建项目'),
						h('button', { className: 'cts-btn', onClick: () => setNewProjectOpen(false) }, '取消'))) : null,
				settingsOpen ? h('dialog', { ref: settingsDialog, onClose: () => setSettingsOpen(false), style: { width: 'min(860px, 94vw)', maxHeight: '85vh', overflow: 'auto' } },
					h('div', { className: 'cts-filter', style: { justifyContent: 'space-between' } },
						h('h3', { style: { margin: 0 } }, '项目设置'),
						h('button', { className: 'cts-btn', onClick: () => setSettingsOpen(false) }, '关闭')),
					!currentProject ? h('p', { className: 'cts-hint' }, '请先选择一个项目。') : h(React.Fragment, null,
						currentProject.readonly ? h('div', { className: 'cts-notice' }, '只读项目：可以查看，不能修改、删除或修改生成配置。') : null,
						h('div', { className: 'cts-modes', style: { margin: '10px 0' } },
							[['project', '项目'], ['modules', '模块'], ['quality', '生成配置']].map(([key, label]) => h('button', {
								key, className: `cts-mode${settingsTab === key ? ' on' : ''}`,
								onClick: () => setSettingsTab(key)
							}, label))),
						settingsTab === 'project' ? h(React.Fragment, null,
							h('div', { className: 'cts-field' }, h('span', { className: 'cts-field-l' }, '项目名称'),
								h('input', { className: 'cts-input', disabled: currentProject.readonly || settingsBusy, value: settingsName,
									onChange: (event) => setSettingsName(event.target.value) })),
							h('p', { className: 'cts-hint' }, `项目 ID：${currentProject.id}`),
							h('p', { className: 'cts-hint' }, `数据目录：${dataDir || '—'}（新建项目都在此目录下）`),
							h('div', { className: 'cts-filter', style: { marginTop: 10 } },
								h('button', { className: 'cts-btn', disabled: currentProject.readonly || settingsBusy || settingsName.trim() === currentProject.name, onClick: saveProjectName }, '保存项目名'),
								!currentProject.readonly ? h('button', { className: 'cts-btn', disabled: settingsBusy, onClick: deleteCurrentProject, style: { color: 'var(--dsw-alias-state-error-primary)' } }, '删除项目（不可恢复）') : null)
						) : null,
						settingsTab === 'modules' ? h(React.Fragment, null,
							h('p', { className: 'cts-hint' }, '一个项目可以拆多个模块；当前模块决定生成/查看的产物范围。'),
							h('div', { className: 'cts-list' }, modules.map((module) => h('div', { className: 'cts-filter', key: module.id, style: { justifyContent: 'space-between' } },
								h('span', null, `${module.name || module.id}${module.id === moduleId ? ' · 当前' : ''}`),
								h('span', { className: 'cts-hint' }, (module.keywords || []).join('、')),
								h('div', { className: 'cts-filter' },
									h('button', { className: 'cts-btn', disabled: currentProject.readonly || settingsBusy, onClick: () => renameModule(module) }, '重命名'),
									h('button', { className: 'cts-btn', disabled: currentProject.readonly || settingsBusy || modules.length <= 1, onClick: () => deleteModule(module.id) }, '删除'))))),
							h('div', { className: 'cts-filter', style: { marginTop: 10 } },
								h('input', { className: 'cts-input', disabled: currentProject.readonly || settingsBusy, placeholder: '新模块名称', value: newSettingsModule,
									onChange: (event) => setNewSettingsModule(event.target.value) }),
								h('button', { className: 'cts-btn primary', disabled: currentProject.readonly || settingsBusy || !newSettingsModule.trim(), onClick: async () => {
									await createModule(newSettingsModule.trim(), [newSettingsModule.trim()]);
									setNewSettingsModule('');
								} }, '新增模块'))
						) : null,
						settingsTab === 'quality' ? h(React.Fragment, null,
							!qualityDraft ? h(React.Fragment, null,
								h('p', { className: 'cts-hint' }, '先选一个生成配置模板，或按项目里已有的 PRD/DBC/设计稿自动识别；模板只决定能力、界面词表和来源占位，不会上传文件。'),
								h('div', { className: 'cts-filter' },
									Object.entries(QUALITY_TEMPLATES).map(([key, template]) => h('button', { key, className: 'cts-btn', disabled: currentProject.readonly,
										onClick: () => setQualityDraft(qualityTemplate(key)) }, `使用「${template.label}」模板`)),
									h('button', { className: 'cts-btn', disabled: currentProject.readonly || settingsBusy, onClick: detectQuality }, '从项目资料识别'))) : h(React.Fragment, null,
								h('p', { className: 'cts-hint' }, '这不是账号或项目分类，而是给生成器的说明书：项目是纯文档还是带 DBC/设计稿、需求文件在哪、界面叫什么。它会影响来源解析、信号校验和用例步骤里的页面名。来源路径相对项目目录。'),
								h('div', { className: 'cts-field' }, h('span', { className: 'cts-field-l' }, '能力'),
									h('div', { className: 'cts-filter' }, ['text', 'protocol', 'design', 'bench'].map((capability) => h('label', { key: capability },
										h('input', { type: 'checkbox', disabled: currentProject.readonly, checked: (qualityDraft.capabilities || []).includes(capability),
											onChange: () => toggleQualityCapability(capability) }), ` ${capability}`)))),
								h('div', { className: 'cts-field' }, h('span', { className: 'cts-field-l' }, '界面词表（每行一个页面/界面名）'),
									h('textarea', { className: 'cts-input', rows: 5, disabled: currentProject.readonly, value: (qualityDraft.surfaces || []).join('\n'),
										onChange: (event) => setQualityDraft({ ...qualityDraft, surfaces: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean) }) })),
								h('div', { className: 'cts-field' }, h('span', { className: 'cts-field-l' }, '默认界面'),
									h('input', { className: 'cts-input', disabled: currentProject.readonly, value: qualityDraft.default_surface || '',
										onChange: (event) => setQualityDraft({ ...qualityDraft, default_surface: event.target.value }) })),
								h('div', { className: 'cts-field' }, h('span', { className: 'cts-field-l' }, '测试点展开粒度'),
									h('select', { className: 'cts-input', disabled: currentProject.readonly, value: qualityDraft.coverage_mode === 'exhaustive' ? 'exhaustive' : 'standard',
										onChange: (event) => setQualityDraft({ ...qualityDraft, coverage_mode: event.target.value }) },
										h('option', { value: 'standard' }, '标准（等价类与边界）'),
										h('option', { value: 'exhaustive' }, '全量展开（逐枚举/逐档位/受限矩阵）'))),
								h('div', { className: 'cts-field' },
									h('label', null,
										h('input', { type: 'checkbox', disabled: currentProject.readonly,
											checked: qualityDraft.include_single_entries === true || qualityDraft.coverage_mode === 'exhaustive',
											onChange: (event) => setQualityDraft({ ...qualityDraft, include_single_entries: event.target.checked }) }),
										' 闭环规则同时覆盖单入口对象（全量展开时自动启用）')),
								['prd', 'dbc', 'design', 'standard'].map((role) => {
									const dirFilter = role === 'prd' ? 'prd' : role === 'dbc' ? 'signals' : role === 'design' ? 'design' : 'other';
									const options = (assets || []).filter((a) => !a.dir || a.dir === dirFilter || role === 'standard').map((a) => a.relative || a.path).filter(Boolean);
									const listId = `cts-src-list-${role}`;
									return h('div', { className: 'cts-field', key: role },
										h('span', { className: 'cts-field-l' }, role === 'prd' ? 'PRD 路径' : role === 'dbc' ? 'DBC 路径' : role === 'design' ? '设计稿路径' : '通用测试规范路径（可选）'),
										h('input', { className: 'cts-input', list: listId, disabled: currentProject.readonly,
											placeholder: role === 'prd' ? 'prd/需求.md（可下拉选择项目文件）' : role === 'dbc' ? 'signals/xxx.dbc（可下拉选择）' : role === 'design' ? 'design/xxx.pix（可下拉选择）' : 'other/通用测试规范.md',
											value: (qualityDraft.sources || {})[role] || '',
											onChange: (event) => updateQualitySource(role, event.target.value) }),
										h('datalist', { id: listId }, options.map((rel) => h('option', { key: rel, value: rel }))));
								}),
								h('div', { className: 'cts-filter', style: { marginTop: 10 } },
									h('button', { className: 'cts-btn primary', disabled: currentProject.readonly || settingsBusy || !(qualityDraft.surfaces || []).length, onClick: saveQuality }, '保存生成配置'),
									h('button', { className: 'cts-btn', disabled: currentProject.readonly || settingsBusy, onClick: detectQuality }, '从项目资料识别'),
									h('button', { className: 'cts-btn', disabled: settingsBusy, onClick: () => setQualityDraft(null) }, '重新选择模板')))
						) : null)) : null,
				centerOpen ? h('dialog', { ref: centerDialog, onClose: () => setCenterOpen(false), style: { width: 'min(720px, 92vw)', maxHeight: '82vh', overflow: 'auto' } },
					h('div', { className: 'cts-filter', style: { justifyContent: 'space-between' } },
						h('h3', { style: { margin: 0 } }, '设置与运行环境'),
						h('button', { className: 'cts-btn', onClick: () => setCenterOpen(false) }, '关闭')),
					!centerStatus ? h('p', { className: 'cts-hint' }, '正在读取…') : h(React.Fragment, null,
						h('div', { className: 'cts-workbench-section' },
							h('h3', null, '数据目录'),
							h('p', { className: 'cts-hint' }, centerStatus.dataDir || '—'),
							h('p', { className: 'cts-hint' }, `当前 ${centerStatus.projects || 0} 个项目；新建项目会建在此目录的 projects/<id>/ 下。`),
							h('button', { className: 'cts-btn', onClick: () => {
								try {
									const copy = navigator.clipboard?.writeText(centerStatus.dataDir || '');
									if (copy) copy.then(() => setError('数据目录路径已复制')).catch(() => setError('无法访问剪贴板，请手动复制'));
									else setError('当前环境不支持剪贴板，请手动复制');
								} catch { setError('复制失败，请手动复制'); }
							} }, '复制路径')),
						h('div', { className: 'cts-workbench-section' },
							h('h3', null, '模型'),
							h('p', { className: 'cts-hint' }, `${centerStatus.provider || '跟随 DSH 默认'} / ${centerStatus.model || '默认模型'}`),
							h('p', { className: 'cts-hint' }, '模型来自 DSH 全局配置；测试 Agent 不单独保存密钥。')),
						h('div', { className: 'cts-workbench-section' },
							h('h3', null, '资料根'),
							(centerStatus.sourceRoots || []).map((root) => h('div', { className: 'cts-item', key: root.dir },
								h('div', { className: 'cts-item-t' }, root.dir),
								h('div', { className: 'cts-item-m' }, root.readonly ? '只读' : '可写')))),
						h('div', { className: 'cts-workbench-section' },
							h('h3', null, 'Pixso 设计稿'),
							h('p', { className: 'cts-hint' }, centerStatus.pixso?.mcpUrl || '未配置 MCP 地址'),
							h('p', { className: 'cts-hint' }, `令牌：${centerStatus.pixso?.hasToken ? '已配置' : '未配置'} · OAuth：${centerStatus.pixso?.oauthStored ? '已保存授权' : '未授权'}`),
							h('p', { className: 'cts-hint' }, '设计稿的检测连接、OAuth 授权与缓存截图请在项目「资料 → 设计稿」页操作。')),
						h('div', { className: 'cts-filter' },
							h('button', { className: 'cts-btn', onClick: refreshCenter }, '刷新状态'),
							h('button', { className: 'cts-btn', onClick: () => setCenterOpen(false) }, '关闭')))) : null,
				impact ? h('dialog', { ref: impactDialog, onClose: () => setImpact(null), style: { maxWidth: 'min(680px, 90vw)', maxHeight: '75vh' } },
					h('h3', null, `${impact.id} · 影响范围`),
					h('p', null, `${impact.points.length} 个测试点 · ${impact.cases.length} 条用例`),
					impact.points.map((point) => h('div', { key: point.point_id }, h('button', { className: 'cts-btn', onClick: () => jump('points', point.point_id) }, `${point.point_id} ${point.requirement}`))),
					impact.cases.map((item) => h('div', { key: item.case_id }, h('button', { className: 'cts-btn', onClick: () => jump('cases', item.case_id) }, `${item.case_id} ${item.title}`))),
					h('button', { className: 'cts-btn', onClick: () => impactDialog.current?.close() }, '关闭')) : null,
				notice ? h('div', { className: 'cts-notice', 'data-tone': notice.tone, role: 'status' },
					h('span', null, notice.text),
					h('button', { className: 'cts-notice-close', 'aria-label': '关闭提示', onClick: () => setNotice(null) }, '×')) : null,
				genBusy ? h('div', { className: 'cts-progress-strip', role: 'status' },
					genProgress ? h('progress', { className: 'cts-progress', value: genProgress.step, max: genProgress.total }) : null,
					h('span', null, genProgress ? `${genProgress.step}/${genProgress.total} · ${genProgress.label}` : (phase || '正在执行生成任务…')),
					h('button', { className: 'cts-btn danger', style: { marginLeft: 'auto', padding: '3px 10px', fontSize: 11.5 }, onClick: cancelGenerate }, '取消任务')) : null,
				h(ConfirmDialog, { modal: confirmModal, onClose: closeConfirm }),
				impactRun ? h('dialog', { ref: impactRunDialog, className: 'cts-confirm-dialog', style: { width: 'min(640px, 94vw)' }, onClose: () => setImpactRun(null) },
					h('h3', null, '需求变更增量影响分析'),
					h('p', null, '选择一个已更新的资料文件，仅重跑受影响的测试点与用例；其余未受影响的已批准用例将原样保留。'),
					(impactRun.sources_summary || []).length ? h('div', { className: 'ac-pill-group', style: { marginBottom: 10 } },
						impactRun.sources_summary.map((src) => h('button', {
							key: src.source,
							className: `cts-pill${impactRun.path === src.source ? ' active' : ''}`,
							onClick: () => openIncrementalImpact(src.source)
						}, `${src.source.split('/').pop()}（${src.point_count} 点 / ${src.case_count} 例）`))) : null,
					h('div', { className: 'cts-summary-strip' },
						h('span', { className: 'cts-pill info' }, `受影响事实 ${(impactRun.affected_facts || []).length}`),
						h('span', { className: 'cts-pill warn' }, `受影响测试点 ${(impactRun.affected_points || []).length}`),
						h('span', { className: 'cts-pill warn' }, `受影响用例 ${(impactRun.affected_cases || []).length}`),
						h('span', { className: 'cts-pill ok' }, `未受影响已批准用例 ${impactRun.untouched_approved_cases || 0} 条将保留`)),
					(impactRun.affected_points || []).length > 0 ? h('div', { className: 'cts-confirm-preview' },
						impactRun.affected_points.slice(0, 30).map((p) => `${p.point_id} · ${p.requirement}`).join('\n')
						+ (impactRun.affected_points.length > 30 ? `\n… 另有 ${impactRun.affected_points.length - 30} 个测试点` : '')) : h('p', { className: 'cts-hint' }, '当前选择下暂无受影响的测试点，请先点击上方具体变更文件。'),
					h('div', { className: 'cts-filter', style: { justifyContent: 'flex-end', marginBottom: 0 } },
						h('button', { className: 'cts-btn', onClick: () => setImpactRun(null) }, '关闭'),
						(impactRun.affected_points || []).length > 0 ? h('button', {
							className: 'cts-btn primary',
							disabled: busyScope,
							onClick: () => {
								const ids = impactRun.affected_points.map((p) => p.point_id);
								const isFast = !artifacts.points?.source_ecsm_version;
								setImpactRun(null);
								openView('design');
								void generate('cases', false, undefined, ids, isFast ? 'facts' : undefined, true);
							}
						}, `仅重跑受影响的 ${impactRun.affected_points.length} 个测试点用例`) : null)) : null,
				view === 'home' ? h(Workbench, {
					projects, dataDir,
					onCreate: () => { setNewProjectName(''); setNewModuleName('默认模块'); setNewProjectOpen(true); },
					onOpen: openProject,
					onRefresh: async () => { try { await refreshProjects(projectId); setError('项目列表已刷新'); } catch (error) { setError(error.message); } }
				}) : view === 'center' ? h(AssetCenter, {
					projects, initialProjectId: assetEntry.project, initialModuleId: assetEntry.module, initialScope: assetEntry.scope, moduleContext: Boolean(assetEntry.module),
					onOpenProject: openProject,
					onBackToModule: () => enterModule(moduleId),
					onProjectChange: (id, module) => { setProjectId(id); setModuleId(module || ''); },
					onOpenTools: () => openView('assets'),
					onOpenSettings: () => openSettings('project'),
					onAssetsChanged: async () => { await loadAssets(); const state = await post('assets.tags.view', { project: projectId, module: moduleId || undefined }).catch(() => null); if (state) setTaggedAssets(state.assets || []); const pool = await post('assets.pool.list').catch(() => null); if (pool) setPoolAssets(pool.assets || []); }
				}) : view === 'project' ? h(ProjectHome, {
					project: currentProject, modules, moduleWorkbench,
					onSelectModule: selectModule,
					onAssets: () => { setAssetEntry({ project: projectId, module: '', scope: 'project' }); openView('center'); },
					onSettings: () => openSettings('project'),
					onWorkbench: () => openView('home')
				}) : view === 'module-assets' ? h(ModuleAssets, {
					key: scope,
					project: currentProject,
					module: modules.find((item) => item.id === moduleId),
					moduleId,
					assets: taggedAssets,
					pool: poolAssets,
					materials: materialRows,
					busy: busyScope,
					onUpload: moduleUpload,
					onTag: moduleTag,
					onImport: moduleImport,
				onBatch: moduleBatch,
				onAdopt: moduleAdopt,
					onNext: () => openView('ecsm'),
					onOpenCenter: () => { setAssetEntry({ project: projectId, module: moduleId, scope: 'module' }); openView('center'); },
					onRefreshAssets: async () => {
						await refreshModuleTags();
						await loadAssets();
						const [pool, materials, ev] = await Promise.all([
							post('assets.pool.list').catch(() => null),
							post('sources.resolve', { project: projectId, module: moduleId }).catch(() => null),
							post('evidence.index', { project: projectId }).catch(() => null)
						]);
						if (pool) setPoolAssets(pool.assets || []);
						if (materials) setMaterialRows(materials.rows || []);
						if (ev?.index) setEvidence(ev.index);
					},
					onError: setError
				}) : loadedScope !== scope ? h('div', { className: 'cts-empty', role: 'status' }, '正在读取模块…') : view === 'assets' ? h(AssetsView, {
					key: scope, projectId, assets, modules, moduleId,
					designActivity: designActivity?.project === projectId && designActivity?.module === moduleId ? designActivity : null,
					sourceScope: { onSaved: refreshAll, refresh: evidence?.builtAt, onFact: (id) => { openView('ecsm'); setTab('facts'); setSelected({ kind: 'facts', id }); } },
					onBuild: build, building,
					onUpload: uploadAsset,
					onProbeMcp: probeMcp,
					onRenderAll: renderAll,
					onImportLibrary: importLibrary,
					onDesignState: setDesignState,
					designBusy,
					designReady: Boolean(designState && designState.available),
					onAuthorizePixso: authorizePixso,
					onCopyAuthorizeUrl: copyAuthorizeUrl,
					authorizeUrl,
					authorizeNote,
					mcpNote,
					onRenderNode: renderNode,
					moduleEvidence, onPreviewEvidence: loadModuleEvidence,
					onOpenCenter: () => { setAssetEntry({ project: projectId, module: moduleId, scope: 'module' }); openView('center'); }
				}) : h(React.Fragment, null,
				view === 'ecsm' ? (() => {
					const contracts = ecsmModel?.model?.inputs?.contracts?.items || [];
					return h(EcsmGuide, {
						hasAssets: taggedAssets.some((asset) => (asset.tags || []).includes('') || (asset.tags || []).includes(moduleId)) || materialRows.some((row) => row.selected && row.kind === 'pixso-mcp'),
						evidenceCount: evidence?.stats?.items || 0,
						facts: (artifacts.facts?.items || []).length,
						features: (artifacts.features?.items || []).length,
						states: (artifacts.states?.items || []).length,
						contracts: contracts.length,
						approved: contracts.filter((item) => item.status === 'approved').length,
						frozen: Boolean(ecsmModel?.current),
						busy: busyScope, nextState: workbenchState,
						onAssets: () => { setAssetEntry({ project: projectId, module: moduleId, scope: moduleId ? 'module' : 'project' }); openView('center'); },
						onBuild: () => build(),
						onUpstream: runAll,
						onContracts: generateContracts,
						onConfirm: () => { openView('ecsm'); setTab('model'); setModelSection('contracts'); setContractTarget(''); },
						onFreeze: freezeEcsm,
						onDesign: () => openWorkflow(workbenchState?.next_action?.target?.tab || 'outline')
					});
				})() : null,
				view !== 'delivery' ? h(Workflow, {
					mode, tab, ecsm: ecsmModel, artifacts, hasAssets: !!assets?.length || !!designState?.available, locked: packages.current?.status === 'frozen',
					counts: {
						evidence: evidence?.stats?.items || 0,
						features: (artifacts.features?.items || []).length,
						states: (artifacts.states?.items || []).length,
						facts: (artifacts.facts?.items || []).length,
						points: (artifacts.points?.items || []).length,
						cases: (artifacts.cases?.items || []).length
					},
					onRun: { evidence: () => build(), generate, all: runAll, freeze: freezeEcsm },
					onOpen: openWorkflow, busy: busyScope, hideNext: view === 'ecsm'
				}) : null,
				view === 'delivery' ? h('div', { className: 'cts-pkg' },
					packages.current
						? h('span', null, `版本 v${packages.current.version} · ${packages.current.status === 'frozen' ? `已冻结（${packages.current.package_id}）` : '草稿'}`)
						: h('span', null, '版本：尚未冻结'),
					h('button', { className: 'cts-btn', disabled: busyScope || !ecsmModel || !artifacts.delivery || Boolean(deliveryBlocker) || packages.current?.status === 'frozen', onClick: () => packageAction('freeze') }, '冻结交付包'),
					h('button', { className: 'cts-btn', disabled: busyScope || !(packages.current && packages.current.status === 'frozen'), onClick: () => packageAction('fork') }, '派生新版本')) : null,
				h('div', { className: 'cts-body' },
					
					chatOpen ? h('aside', { className: 'cts-main cts-chat', 'aria-label': 'Agent 对话' },
						h('header', { className: 'cts-chat-head' },
							h('strong', null, 'Agent 对话'),
							h('button', { className: 'cts-btn', onClick: () => setChatOpen(false) }, '关闭对话')),
						h('div', { className: 'cts-scroll', ref: scrollRef, tabIndex: 0, 'aria-label': '对话记录',
							onScroll: (event) => {
								const node = event.currentTarget;
								followChat.current = node.scrollHeight - node.clientHeight - node.scrollTop < 48;
							} },
							messages.length === 0
								? h('div', { className: 'cts-guide' }, '可以问 Agent 当前模块的需求、信号或测试覆盖。')
								: messages.map((message) => h('div', { key: message.id, className: `cts-msg${message.role === 'user' ? ' user' : ''}` },
									h('div', { className: 'cts-role' }, message.role === 'user' ? '你' : 'Agent'),
									message.role === 'user'
										? h('div', { className: 'cts-bubble' }, message.text)
										: h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
											(message.tools || []).map((card) => h(ToolCard, { key: card.callId, card })),
											message.gate ? h(GateCard, { key: message.gate.gateId, gate: message.gate, onAnswer: answerGate }) : null,
											message.text ? h('div', { className: 'cts-bubble cts-bubble-md' }, h(Markdown, { text: message.text })) : null)
								))
						),
						h('div', { className: 'cts-composer' },
							h('textarea', {
								className: 'cts-input',
								value: draft,
								'aria-label': '给 Agent 发消息',
								placeholder: '询问当前模块的需求、信号或测试覆盖…',
								onChange: (event) => setDraft(event.target.value),
								onKeyDown: (event) => {
									if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
										event.preventDefault();
										send();
									}
								}
							}),
							h('div', { className: 'cts-row' },
								h('button', { className: 'cts-btn primary', onClick: send, disabled: status === 'running' || draft.trim() === '' }, status === 'running' ? '运行中…' : '发送'),
								status === 'running' ? h('button', { className: 'cts-btn', onClick: stop }, '停止') : null,
								h('span', { className: 'cts-hint' }, evidence?.stats.items ? 'Enter 发送 · Shift+Enter 换行' : '先构建证据，方便 Agent 查资料')
							)
						)
					) : null,
					view === 'delivery' ? h(Delivery, { key: scope, onOpen: openWorkflow, packages, ecsmModel, artifacts, blocker: deliveryBlocker, nextState: workbenchState, projectId, moduleId, exportCases, exportCandidate, busy: pkgBusy, report: (message) => { if (moduleRef.current === scope) setError(message); }, openCases: () => { openView('design'); setTab('cases'); }, projectQuality: currentProject?.quality || null, onQuickQualityChange: updateQuickQuality }) : h(RightPanel, {
						key: scope, projectId, moduleId, refreshAll, onOpen: openWorkflow, busy: busyScope, locked: packages.current?.status === 'frozen', onImages, onImpact: openImpact, onJump: jump,
						onOutlineStatus: (outlineStatus) => { if (moduleRef.current === scope) setArtifacts((current) => ({ ...current, outlineStatus })); },
						onRepair: async (patch) => { await post('ecsm.repair', { project: projectId, ...patch }); await refreshAll(); },
						onSaveContract: async (payload) => {
							const state = await post('contracts.save', { project: projectId, ...payload });
							await refreshAll();
							return state.item;
						},
						onApproveContracts: batchApproveContracts,
						onBatchReview: batchReview,
						artifacts,
						tab,
						setTab,
						generate,
						genBusy,
						phase,
						lintState,
						onExport: exportCases,
						onClear,
						selected,
						setSelected,
						coverageState,
						reviewState,
						bindings,
						bindingBusy,
						issuesState,
						questions,
						onAnswerQuestion: answerQuestion,
						onDismissQuestion: dismissQuestion,
						onDismissAll: dismissAll,
						agentsDoc,
						agentBusy,
						onRunAgent: runAgent,
						mode,
						onExportEcsm: exportEcsm,
						modelSection, setModelSection, contractTarget,
						onReloadEcsm: reloadEcsm,
						onLoadVersion: loadEcsmVersion,
						ecsmModel,
						onSuggestBindings: suggestBindings,
						onConfirmBinding: confirmBinding,
						onManualBinding: manualBinding,
						onSave,
						onRegenerate,
						onDelete,
						onApprove,
						itemBusy,
						projectQuality: currentProject?.quality || null,
						onQuickQualityChange: updateQuickQuality,
						onOpenIncrementalImpact: openIncrementalImpact
					})
				))
			);
		}

		class Boundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error };
			}
			render() {
				if (this.state.error) {
					return h('div', { style: { padding: 24, whiteSpace: 'pre-wrap' } }, `测试 Agent 页面渲染出错：${this.state.error.message}`);
				}
				return this.props.children;
			}
		}

		function Icon({ size }) {
			const edge = size || 18;
			return h('svg', { viewBox: '0 0 24 24', width: edge, height: edge, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true },
				h('rect', { x: 4, y: 4.5, width: 16, height: 15, rx: 2.4 }),
				h('path', { d: 'M8 10h5M8 13.5h3' }),
				h('path', { d: 'M13.5 15.5l1.6-2.6 1.6 4 1.6-3' })
			);
		}

		const PANEL_ID = 'cts-agent';

		function apply(ctx) {
			ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(Boundary, null, h(Page))));
			ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
				name: 'sidebar.panellist',
				id: PANEL_ID,
				order: 12,
				label: () => '测试 Agent'
			}, Icon));
		}

		return { inject: ['slots'], apply };
	}
});

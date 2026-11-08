/**
 * dsh-wb-import — client half.
 *
 * 在「设置 → 插件」里加一个 WorkBuddy 导入页：
 *   - 列出本机 WorkBuddy 会话（标题 / 大小 / 更新时间 / 工作区）
 *   - 勾选要导入的会话，填目标工作区目录
 *   - 点「导入」，显示逐个结果
 *   - 「导入台账」区：列出已导入的会话，可勾选回滚
 *
 * 所有数据来自 host 半区的 HTTP 路由（/dsh-wb-import/*），
 * 前端不直接碰文件系统。
 */

window.__ModuleLoader__.load({
  id: 'dsh-wb-import',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useMemo } = React;

    const BASE = '/dsh-wb-import';

    const zh = (() => {
      const tag = typeof document !== 'undefined' ? document.documentElement?.lang : '';
      if (typeof tag === 'string' && /^zh(-|$)/i.test(tag)) return true;
      const first = typeof navigator !== 'undefined'
        ? (Array.isArray(navigator.languages) ? navigator.languages[0] : navigator.language)
        : '';
      return typeof first === 'string' && /^zh(-|$)/i.test(first);
    })();

    const COPY = zh
      ? {
          title: 'WorkBuddy 导入',
          loading: '正在读取 WorkBuddy 会话…',
          empty: '没有找到 WorkBuddy 会话。',
          filter: '筛选标题…',
          refresh: '刷新列表',
          selected: '已选 {n} 个',
          workspace: '导入到哪个工作区目录',
          workspaceHint: '必须是绝对路径，例如 D:\\Users\\me\\DSH\\workspace',
          browse: '浏览…',
          compactLabel: '压缩导入（早期历史用 WorkBuddy 现成摘要替代，会话才能继续对话）',
          compactTurns: '轮',
          compactHint: '压缩会把早期内容换成摘要，原文自动导出到会话目录下的 full-text.md。摘要之后的最近若干轮保留原文。',
          compactNoSummary: '压缩未生效：源会话里没有可用的摘要',
          progress: '导入中 {done}/{total}…',
          browseHint2: '',
          browsing: '正在打开…',
          pickerUnavailable: '目录选择器不可用，请手动填写路径',
          pickerFailed: '目录选择失败：{why}',
          pickTitle: '选择工作区目录',
          pickUp: '上一级',
          pickHome: '主目录',
          pickSelect: '选择此目录',
          pickCancel: '取消',
          pickLoading: '正在读取…',
          pickEmpty: '（此目录下没有子目录）',
          pickTruncated: '目录太多，只显示了一部分',
          pickHidden: '显示隐藏目录',
          newFolder: '新建目录',
          newFolderPrompt: '新目录名称',
          newFolderEmpty: '目录名不能为空',
          newFolderSlash: '目录名不能包含斜杠（/ 或 \\）',
          newFolderCreating: '正在创建…',
          newFolderFailed: '新建目录失败：{why}',
          newFolderExists: '同名目录已存在',
          newFolderConfirm: '创建',
          import: '导入选中的会话',
          importing: '正在导入…',
          needSelection: '先勾选至少一个会话',
          needWorkspace: '先填写目标工作区目录',
          done: '导入完成：{ok} / {total}',
          ledgerTitle: '导入台账（可回滚）',
          ledgerEmpty: '还没有导入记录。',
          rollback: '回滚选中项',
          rollbackConfirm: '确认删除这些导入的会话目录？此操作不可撤销。',
          rolledBack: '已回滚 {n} 个',
          colTitle: '标题',
          colSize: '大小',
          colUpdated: '更新时间',
          colWorkspace: '工作区',
          failed: '失败：{why}',
          size: '条',
        }
      : {
          title: 'WorkBuddy 导入',
          loading: '正在读取 WorkBuddy 会话…',
          empty: '没有找到 WorkBuddy 会话。',
          filter: '筛选标题…',
          refresh: '刷新列表',
          selected: '已选 {n} 个',
          workspace: '导入到哪个工作区目录',
          workspaceHint: '必须是绝对路径，例如 D:\\Users\\me\\DSH\\workspace',
          browse: '浏览…',
          browsing: '正在打开…',
          pickerUnavailable: '目录选择器不可用，请手动填写路径',
          pickerFailed: '目录选择失败：{why}',
          pickTitle: '选择工作区目录',
          pickUp: '上一级',
          pickHome: '主目录',
          pickSelect: '选择此目录',
          pickCancel: '取消',
          pickLoading: '正在读取…',
          pickEmpty: '（此目录下没有子目录）',
          pickTruncated: '目录太多，只显示了一部分',
          pickHidden: '显示隐藏目录',
          newFolder: '新建目录',
          newFolderPrompt: '新目录名称',
          newFolderEmpty: '目录名不能为空',
          newFolderSlash: '目录名不能包含斜杠（/ 或 \\）',
          newFolderCreating: '正在创建…',
          newFolderFailed: '新建目录失败：{why}',
          newFolderExists: '同名目录已存在',
          newFolderConfirm: '创建',
          import: '导入选中的会话',
          importing: '正在导入…',
          needSelection: '请先勾选至少一个会话',
          needWorkspace: '请填写目标工作区目录',
          done: '导入完成：{ok} / {total}',
          ledgerTitle: '导入台账（可回滚）',
          ledgerEmpty: '还没有导入记录。',
          rollback: '回滚选中',
          rollbackConfirm: '要删除这些导入的会话目录吗？此操作无法撤销。',
          rolledBack: '已回滚 {n} 个',
          colTitle: '标题',
          colSize: '大小',
          colUpdated: '更新时间',
          colWorkspace: '工作区',
          failed: '失败：{why}',
          size: '条',
        };

    const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? ''));

    async function getJson(url) {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      const text = await r.text();
      if (!text) {
        throw new Error(`empty response from ${url} (HTTP ${r.status})`);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`non-JSON response from ${url} (HTTP ${r.status}): ${text.slice(0, 120)}`);
      }
    }
    async function postJson(url, body) {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const text = await r.text();
      if (!text) throw new Error(`empty response from ${url} (HTTP ${r.status})`);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`non-JSON response from ${url} (HTTP ${r.status}): ${text.slice(0, 120)}`);
      }
    }

    // ---- 样式（内联，避免污染全局）----
    const S = {
      wrap: { padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '900px' },
      h1: { margin: 0, fontSize: '15px', fontWeight: 600 },
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      input: {
        padding: '6px 9px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent', color: 'inherit', fontSize: '13px', minWidth: '220px',
      },
      button: {
        padding: '6px 12px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.35)',
        background: 'rgba(127,127,127,0.12)', color: 'inherit', fontSize: '13px', cursor: 'pointer',
      },
      buttonPrimary: {
        padding: '6px 14px', borderRadius: '6px', border: '1px solid rgba(90,150,255,0.6)',
        background: 'rgba(90,150,255,0.18)', color: 'inherit', fontSize: '13px', cursor: 'pointer',
        fontWeight: 600,
      },
      buttonDanger: {
        padding: '6px 12px', borderRadius: '6px', border: '1px solid rgba(220,90,90,0.55)',
        background: 'rgba(220,90,90,0.14)', color: 'inherit', fontSize: '13px', cursor: 'pointer',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
      th: {
        textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid rgba(127,127,127,0.25)',
        fontWeight: 600, fontSize: '12px', opacity: 0.75, whiteSpace: 'nowrap',
      },
      td: { padding: '5px 8px', borderBottom: '1px solid rgba(127,127,127,0.12)', verticalAlign: 'top' },
      tdTitle: { padding: '5px 8px', borderBottom: '1px solid rgba(127,127,127,0.12)', maxWidth: '380px' },
      scroll: { maxHeight: '340px', overflowY: 'auto', border: '1px solid rgba(127,127,127,0.2)', borderRadius: '8px' },
      dialogMask: {
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      },
      dialog: {
        width: '560px', maxWidth: '92vw', maxHeight: '70vh', display: 'flex', flexDirection: 'column',
        background: 'var(--dsh-surface, #fff)', color: 'inherit', borderRadius: '10px',
        border: '1px solid rgba(127,127,127,0.3)', boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
        overflow: 'hidden',
      },
      dialogHead: {
        padding: '12px 16px', borderBottom: '1px solid rgba(127,127,127,0.2)',
        display: 'flex', alignItems: 'center', gap: '8px',
      },
      crumb: {
        padding: '2px 6px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
        border: 'none', background: 'transparent', color: 'inherit',
      },
      dirList: { flex: 1, overflowY: 'auto', padding: '4px 0' },
      dirRow: {
        padding: '6px 16px', cursor: 'pointer', fontSize: '13px', display: 'flex',
        alignItems: 'center', gap: '6px',
      },
      dialogFoot: {
        padding: '10px 16px', borderTop: '1px solid rgba(127,127,127,0.2)',
        display: 'flex', alignItems: 'center', gap: '8px',
      },
      hint: { fontSize: '12px', opacity: 0.65 },
      ok: { color: 'rgb(80,190,110)' },
      bad: { color: 'rgb(220,100,100)' },
      mono: { fontFamily: 'ui-monospace, monospace', fontSize: '11px', opacity: 0.7 },
      note: { fontSize: '12px', padding: '6px 10px', borderRadius: '6px', background: 'rgba(127,127,127,0.1)' },
      rowClickable: { cursor: 'pointer', userSelect: 'none' },
      rowPickedBg: 'rgba(64,128,255,0.12)',
    };

    /**
     * 应用内目录浏览器。
     *
     * 为什么需要它：DSH 的 directoryPicker 服务按 `capability().kind` 分成两种后端——
     *   native：弹系统对话框，有 pick()
     *   browse：只提供 list/createDirectory 原语（远程也能用）
     * 本机配置的是 browse，所以 `uiWorkspace.pickDirectory()`（走 native pick）
     * 会报 "needs the native capability"。正确做法是用 listDirectory 逐级浏览。
     */
    function DirectoryBrowser(props) {
      const { startPath, onPick, onCancel } = props;
      const [cur, setCur] = useState(null);
      const [loading, setLoading] = useState(true);
      const [err, setErr] = useState(null);
      const [showHidden, setShowHidden] = useState(false);
      const [creating, setCreating] = useState(false);
      const [showNewName, setShowNewName] = useState(false);
      const [newName, setNewName] = useState('');

      const listDirectory = props.listDirectory;
      const createDirectory = props.createDirectory;

      const load = useCallback(async (target) => {
        setLoading(true);
        setErr(null);
        try {
          const res = await listDirectory(target);
          setCur(res);
        } catch (e) {
          setErr(String(e?.message ?? e));
        } finally {
          setLoading(false);
        }
      }, [listDirectory]);

      /**
       * 在当前目录下新建子目录。
       * 用界面内的输入框（newName）而不是 window.prompt ——
       * Electron 宿主里 prompt 可能被禁用或不显示，点了没反应。
       */
      const newFolder = async (nameArg) => {
        if (typeof createDirectory !== 'function') { setErr(COPY.pickerUnavailable); return; }
        const parent = cur?.path;
        if (typeof parent !== 'string' || !parent) return;
        const trimmed = typeof nameArg === 'string' ? nameArg.trim() : '';
        if (!trimmed) { setErr(COPY.newFolderEmpty); return; }
        if (/[\\/]/.test(trimmed)) { setErr(COPY.newFolderSlash); return; }

        setCreating(true);
        setErr(null);
        try {
          const created = await createDirectory(parent, trimmed);
          setNewName('');
          setShowNewName(false);
          await load(created);
        } catch (e) {
          const msg = String(e?.message ?? e);
          setErr(/exists|EEXIST/i.test(msg)
            ? COPY.newFolderExists
            : fill(COPY.newFolderFailed, { why: msg }));
        } finally {
          setCreating(false);
        }
      };

      useEffect(() => { load(startPath || undefined); }, [load, startPath]);

      const children = [];
      children.push(h('div', { key: 'mask', style: S.dialogMask, onClick: onCancel },
        h('div', {
          key: 'dlg',
          style: S.dialog,
          onClick: (e) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); },
        },
        // 标题栏
        h('div', { key: 'head', style: S.dialogHead },
          h('div', { style: { fontWeight: 600, fontSize: '13px', flex: 1 } }, COPY.pickTitle),
          h('button', {
            style: S.button,
            onClick: () => { setShowNewName((v) => !v); setErr(null); },
            disabled: loading || creating || typeof createDirectory !== 'function',
            title: COPY.newFolder,
          }, COPY.newFolder),
          h('button', {
            style: S.button,
            onClick: () => load(cur?.path),
            disabled: loading,
          }, COPY.refresh),
        ),

        // 面包屑
        h('div', {
          key: 'crumbs',
          style: { padding: '8px 16px', display: 'flex', flexWrap: 'wrap', gap: '2px', alignItems: 'center' },
        },
        (cur?.crumbs || []).map((c, i) => h('button', {
          key: 'c' + i,
          style: S.crumb,
          onClick: () => load(c.path),
          title: c.path,
        }, (c.name ?? c.label ?? '') + (i < (cur.crumbs.length - 1) ? ' /' : '')))),

        // 新建目录输入行（点「新建目录」时出现）
        showNewName ? h('div', {
          key: 'newname',
          style: {
            padding: '8px 16px', display: 'flex', gap: '8px', alignItems: 'center',
            borderBottom: '1px solid rgba(127,127,127,0.15)', background: 'rgba(127,127,127,0.06)',
          },
        },
        h('input', {
          style: { ...S.input, flex: 1, minWidth: '160px' },
          placeholder: COPY.newFolderPrompt,
          value: newName,
          autoFocus: true,
          onChange: (e) => setNewName(e.target.value),
          onKeyDown: (e) => {
            if (!e) return;
            if (e.key === 'Enter') { e.preventDefault?.(); newFolder(newName); }
            if (e.key === 'Escape') { e.preventDefault?.(); setShowNewName(false); setNewName(''); }
          },
        }),
        h('button', {
          style: S.buttonPrimary,
          onClick: () => newFolder(newName),
          disabled: creating,
        }, creating ? COPY.newFolderCreating : COPY.newFolderConfirm),
        h('button', {
          style: S.button,
          onClick: () => { setShowNewName(false); setNewName(''); setErr(null); },
          disabled: creating,
        }, COPY.pickCancel)) : null,

        // 错误提示条（独立于列表，新建失败时列表仍然可见）
        err ? h('div', {
          key: 'err',
          style: { ...S.bad, padding: '8px 16px', fontSize: '12px', borderBottom: '1px solid rgba(220,100,100,0.25)' },
        }, err) : null,

        // 目录列表
        h('div', { key: 'list', style: S.dirList },
          loading ? h('div', { style: { ...S.hint, padding: '12px 16px' } }, COPY.pickLoading)
            : (cur?.entries || []).filter((e) => showHidden || !e.hidden).length === 0
              ? h('div', { style: { ...S.hint, padding: '12px 16px' } }, COPY.pickEmpty)
              : (cur?.entries || [])
                .filter((e) => showHidden || !e.hidden)
                .map((e, i) => h('div', {
                  key: 'd' + i,
                  style: S.dirRow,
                  onClick: () => load(e.path),
                }, h('span', null, '📁'), h('span', { style: { flex: 1 } }, e.name)))),
        cur?.truncated ? h('div', { style: { ...S.hint, padding: '0 16px 6px' } }, COPY.pickTruncated) : null,

        // 底部操作
        h('div', { key: 'foot', style: S.dialogFoot },
          h('button', {
            style: S.button,
            onClick: () => load(cur?.home),
            disabled: loading,
          }, COPY.pickHome),
          h('label', { style: { ...S.hint, display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: showHidden,
              onChange: (e) => setShowHidden(!!e.target.checked),
            }),
            COPY.pickHidden,
          ),
          h('div', { style: { flex: 1 } }),
          h('button', { style: S.button, onClick: onCancel }, COPY.pickCancel),
          h('button', {
            style: S.buttonPrimary,
            onClick: () => onPick(cur?.path),
            disabled: !cur?.path,
          }, COPY.pickSelect),
        ),
        ),
      ));

      return children[0];
    }

    function WorkBuddyImportPanel(props) {
      const pickDirectory = props?.pickDirectory;
      const listDirectory = props?.listDirectory;
      const createDirectory = props?.createDirectory;
      const [sessions, setSessions] = useState([]);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [filter, setFilter] = useState('');
      const [picked, setPicked] = useState(() => new Set());
      const [workspace, setWorkspace] = useState('');
      const [browsing, setBrowsing] = useState(false);
      const [busy, setBusy] = useState(false);
      const [results, setResults] = useState(null);
      // 压缩导入开关
      const [compact, setCompact] = useState(false);
      const [recentTurns, setRecentTurns] = useState(40);
      // 异步导入进度
      const [progress, setProgress] = useState(null);
      const [ledger, setLedger] = useState([]);
      const [ledgerPicked, setLedgerPicked] = useState(() => new Set());

      const loadSessions = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
          const data = await getJson(`${BASE}/sessions`);
          if (!data?.ok) throw new Error(data?.error || 'load failed');
          setSessions(Array.isArray(data.sessions) ? data.sessions : []);
        } catch (e) {
          // 失败时先探 health，把 host 侧的真实状态一并显示出来
          let hint = '';
          try {
            const h = await getJson(`${BASE}/health`);
            hint = h?.ok
              ? ` [host ok; root=${h.workbuddyRoot} exists=${h.rootExists}]`
              : ` [host unhealthy: ${h?.error ?? 'unknown'}]`;
          } catch (he) {
            hint = ` [host unreachable: ${he?.message ?? he}]`;
          }
          setError(String(e?.message ?? e) + hint);
        } finally {
          setLoading(false);
        }
      }, []);

      const loadLedger = useCallback(async () => {
        try {
          const data = await getJson(`${BASE}/ledger`);
          if (data?.ok) setLedger(Array.isArray(data.entries) ? data.entries : []);
        } catch { /* ledger 读失败不阻塞主流程 */ }
      }, []);

      useEffect(() => { loadSessions(); loadLedger(); }, [loadSessions, loadLedger]);

      const shown = useMemo(() => {
        const kw = filter.trim().toLowerCase();
        if (!kw) return sessions;
        return sessions.filter((s) => String(s.title || '').toLowerCase().includes(kw)
          || String(s.project || '').toLowerCase().includes(kw));
      }, [sessions, filter]);

      const toggle = (id) => {
        setPicked((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        });
      };
      const toggleAll = () => {
        setPicked((prev) => {
          if (prev.size === shown.length) return new Set();
          return new Set(shown.map((s) => s.id));
        });
      };

      const runImport = async () => {
        if (picked.size === 0) { setError(COPY.needSelection); return; }
        if (!workspace.trim()) { setError(COPY.needWorkspace); return; }
        setBusy(true);
        setError(null);
        setResults(null);
        setProgress(null);
        try {
          // 异步导入：立即拿到 jobId，然后轮询进度。
          // 压缩导入要读源文件 + 生成摘要 + 导出原文，可能几十秒；
          // 同步等待会让界面卡死，也可能被网关超时打断。
          const started = await postJson(`${BASE}/import`, {
            sessionIds: [...picked],
            workspaceDir: workspace.trim(),
            compact: compact === true,
            recentTurns: Number(recentTurns) || 40,
          });
          if (!started?.ok) throw new Error(started?.error || 'import failed');
          const jobId = started.jobId;

          const deadline = Date.now() + 10 * 60 * 1000;
          let final = null;
          while (Date.now() < deadline) {
            const st = await getJson(`${BASE}/import/status?jobId=${encodeURIComponent(jobId)}`);
            if (!st?.ok) throw new Error(st?.error || 'status failed');
            setProgress({ done: st.done, total: st.total, state: st.state });
            if (st.state === 'done' || st.state === 'failed') { final = st; break; }
            await new Promise((r) => setTimeout(r, 700));
          }
          if (!final) throw new Error('导入超时（10 分钟）');
          if (final.state === 'failed') throw new Error(final.error || 'import failed');

          setResults({ ok: true, imported: final.results.filter((r) => r.ok).length, total: final.total, results: final.results });
          setPicked(new Set());
          await loadLedger();
        } catch (e) {
          setError(String(e?.message ?? e));
        } finally {
          setProgress(null);
          setBusy(false);
        }
      };

      const runRollback = async () => {
        if (ledgerPicked.size === 0) return;
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !window.confirm(COPY.rollbackConfirm)) return;
        setBusy(true);
        setError(null);
        try {
          const data = await postJson(`${BASE}/rollback`, { ids: [...ledgerPicked], confirm: true });
          if (!data?.ok) throw new Error(data?.error || 'rollback failed');
          setLedgerPicked(new Set());
          await loadLedger();
          await loadSessions();
          setResults({ rolledBack: data.deleted, skipped: data.skipped || [] });
        } catch (e) {
          setError(String(e?.message ?? e));
        } finally {
          setBusy(false);
        }
      };

      const children = [];

      // 标题行
      children.push(h('div', { key: 'head', style: S.row },
        h('div', { style: S.h1 }, COPY.title),
        h('div', { style: { flex: 1 } }),
        h('div', { style: S.hint }, `${shown.length} ${COPY.size}`),
      ));

      if (error) {
        children.push(h('div', { key: 'err', style: { ...S.note, ...S.bad } }, String(error)));
      }

      // 筛选 + 刷新
      children.push(h('div', { key: 'tools', style: S.row },
        h('input', {
          style: S.input,
          placeholder: COPY.filter,
          value: filter,
          onChange: (e) => setFilter(e.target.value),
        }),
        h('button', { style: S.button, onClick: loadSessions, disabled: loading || busy }, COPY.refresh),
        h('div', { style: { flex: 1 } }),
        h('div', { style: S.hint }, fill(COPY.selected, { n: picked.size })),
      ));

      // 会话列表
      if (loading) {
        children.push(h('div', { key: 'loading', style: S.hint }, COPY.loading));
      } else if (shown.length === 0) {
        children.push(h('div', { key: 'empty', style: S.hint }, COPY.empty));
      } else {
        const rows = [
          h('tr', { key: 'hdr' },
            h('th', { style: { ...S.th, width: '30px' } },
              h('input', {
                type: 'checkbox',
                checked: picked.size > 0 && picked.size === shown.length,
                onChange: toggleAll,
                title: 'select all',
              })),
            h('th', { style: S.th }, COPY.colTitle),
            h('th', { style: S.th }, COPY.colSize),
            h('th', { style: S.th }, COPY.colUpdated),
            h('th', { style: S.th }, COPY.colWorkspace),
          ),
        ];
        for (const s of shown) {
          // 整行可点击：点标题/大小/时间/工作区都能选中，不只前面那个小复选框
          rows.push(h('tr', {
            key: s.id,
            style: { ...S.rowClickable, background: picked.has(s.id) ? S.rowPickedBg : undefined },
            onClick: () => toggle(s.id),
          },
            h('td', { style: S.td },
              h('input', {
                type: 'checkbox',
                checked: picked.has(s.id),
                // checkbox 自己处理，阻止冒泡到 tr，避免点一次切两次
                onClick: (e) => e.stopPropagation(),
                onChange: () => toggle(s.id),
              })),
            h('td', { style: S.tdTitle },
              h('div', { style: { whiteSpace: 'normal', wordBreak: 'break-word' } }, s.title || '(无标题)'),
              h('div', { style: S.mono }, s.id),
            ),
            h('td', { style: S.td }, s.sizeText),
            h('td', { style: S.td, whiteSpace: 'nowrap' }, s.updated),
            h('td', { style: S.td, ...S.mono }, s.project),
          ));
        }
        children.push(h('div', { key: 'list', style: S.scroll },
          h('table', { style: S.table }, h('thead', null, rows[0]), h('tbody', null, rows.slice(1)))));
      }

      // 目标工作区 + 导入按钮
      children.push(h('div', { key: 'target', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('div', { style: S.hint }, COPY.workspace),
        h('div', { style: S.row },
          h('input', {
            style: { ...S.input, minWidth: '420px', flex: 1 },
            placeholder: 'D:\\Users\\me\\DSH\\workspace',
            value: workspace,
            onChange: (e) => setWorkspace(e.target.value),
          }),
          h('button', {
            style: S.button,
            onClick: async () => {
              // 优先走应用内浏览器（browse 后端）；没有 listDirectory 时
              // 退回 native pick（如果后端是 native 就能用）。
              if (typeof listDirectory === 'function') {
                setError(null);
                setBrowsing(true);
                return;
              }
              if (typeof pickDirectory !== 'function') { setError(COPY.pickerUnavailable); return; }
              try {
                const dir = await pickDirectory();
                if (typeof dir === 'string' && dir.trim()) setWorkspace(dir.trim());
              } catch (e) {
                setError(fill(COPY.pickerFailed, { why: String(e?.message ?? e) }));
              }
            },
            disabled: busy,
            title: COPY.browse,
          }, COPY.browse),
        ),
        h('div', { style: S.hint }, COPY.workspaceHint),

        // 压缩导入开关
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' } },
          h('input', {
            type: 'checkbox',
            id: 'wb-compact',
            checked: compact === true,
            onChange: (e) => setCompact(e.target.checked),
            disabled: busy,
          }),
          h('label', { htmlFor: 'wb-compact', style: { ...S.hint, cursor: 'pointer' } }, COPY.compactLabel),
          compact ? h('input', {
            type: 'number',
            min: 1,
            value: recentTurns,
            onChange: (e) => setRecentTurns(e.target.value),
            disabled: busy,
            style: { ...S.input, width: '70px' },
          }) : null,
          compact ? h('span', { style: S.hint }, COPY.compactTurns) : null,
        ),
        compact ? h('div', { style: S.hint }, COPY.compactHint) : null,

        // 导入按钮放在最下方：所有选项都在它上面，先定选项再按动作
        h('div', { style: { marginTop: '8px' } },
          h('button', {
            style: { ...S.buttonPrimary, width: '100%' },
            onClick: runImport,
            disabled: busy || picked.size === 0,
          }, busy ? COPY.importing : COPY.import),
        ),
      ));

      // 导入进度（异步任务进行中）
      if (progress) {
        children.push(h('div', { key: 'progress', style: { ...S.hint, marginTop: '6px' } },
          fill(COPY.progress, { done: progress.done ?? 0, total: progress.total ?? 0 })));
      }

      // 导入结果
      if (results && results.results) {
        const okCount = results.results.filter((r) => r.ok).length;
        const lines = [
          h('div', { key: 'sum', style: { fontWeight: 600 } },
            fill(COPY.done, { ok: okCount, total: results.total })),
        ];
        if (results.ledgerError) {
          lines.push(h('div', { key: 'ledgererr', style: { ...S.bad } },
            `⚠ 回滚台账写入失败（本次导入无法回滚）: ${results.ledgerError}`));
        }
        for (const r of results.results) {
          if (r.ok) {
            lines.push(h('div', { key: r.id, style: S.ok },
              `✓ ${r.title || r.id} → ${r.events} events`));
            if (r.compaction?.applied) {
              lines.push(h('div', { key: r.id + ':c', style: S.hint },
                `📦 压缩：早期 ${r.compaction.droppedRecords} 条 → 摘要（${r.compaction.summaryChars} 字符），保留最近 ${r.compaction.recentTurns} 轮`));
            } else if (r.compaction && !r.compaction.applied) {
              lines.push(h('div', { key: r.id + ':c', style: { ...S.hint, ...S.bad } },
                `⚠ ${COPY.compactNoSummary}（${r.compaction.reason}）`));
            }
            if (r.exportPath) {
              lines.push(h('div', { key: r.id + ':e', style: S.hint }, `📄 原文: ${r.exportPath}`));
            }
            if (r.closeWarning) {
              lines.push(h('div', { key: r.id + ':w', style: { ...S.hint, ...S.bad } },
                `⚠ close failed: ${r.closeWarning}`));
            }
          } else {
            lines.push(h('div', { key: r.id, style: S.bad },
              `✗ ${r.id}: ${fill(COPY.failed, { why: r.error })}`));
          }
        }
        children.push(h('div', { key: 'res', style: { ...S.note, display: 'flex', flexDirection: 'column', gap: '3px' } }, lines));
      } else if (results && typeof results.rolledBack === 'number') {
        children.push(h('div', { key: 'rb', style: S.note },
          fill(COPY.rolledBack, { n: results.rolledBack })));
      }

      // 台账
      children.push(h('div', { key: 'ledgerhead', style: { ...S.row, marginTop: '6px' } },
        h('div', { style: { fontWeight: 600, fontSize: '13px' } }, COPY.ledgerTitle),
        h('div', { style: { flex: 1 } }),
        h('button', {
          style: S.buttonDanger,
          onClick: runRollback,
          disabled: busy || ledgerPicked.size === 0,
        }, COPY.rollback),
      ));

      if (ledger.length === 0) {
        children.push(h('div', { key: 'ledgerempty', style: S.hint }, COPY.ledgerEmpty));
      } else {
        const rows = [
          h('tr', { key: 'hdr' },
            h('th', { style: { ...S.th, width: '30px' } }),
            h('th', { style: S.th }, COPY.colTitle),
            h('th', { style: S.th }, COPY.colWorkspace),
          ),
        ];
        for (const e of ledger) {
          rows.push(h('tr', { key: e.dshId },
            h('td', { style: S.td },
              h('input', {
                type: 'checkbox',
                checked: ledgerPicked.has(e.dshId),
                onChange: () => setLedgerPicked((prev) => {
                  const next = new Set(prev);
                  if (next.has(e.dshId)) next.delete(e.dshId); else next.add(e.dshId);
                  return next;
                }),
              })),
            h('td', { style: S.tdTitle },
              h('div', { style: S.mono }, e.dshId),
              e.partial ? h('div', { style: { ...S.hint, ...S.bad } }, 'PARTIAL') : null,
            ),
            h('td', { style: { ...S.td, ...S.mono } }, e.cwd),
          ));
        }
        children.push(h('div', { key: 'ledger', style: { ...S.scroll, maxHeight: '180px' } },
          h('table', { style: S.table }, h('thead', null, rows[0]), h('tbody', null, rows.slice(1)))));
      }

      // 目录浏览器对话框
      if (browsing && typeof listDirectory === 'function') {
        children.push(h(DirectoryBrowser, {
          key: 'browser',
          listDirectory,
          createDirectory,
          startPath: workspace.trim() || undefined,
          onCancel: () => setBrowsing(false),
          onPick: (dir) => {
            if (typeof dir === 'string' && dir.trim()) setWorkspace(dir.trim());
            setBrowsing(false);
          },
        }));
      }

      return h('div', { style: S.wrap }, children);
    }

    let appliedCtx = null;

    return {
      // uiWorkspace 只用于目录选择器。它是必需注入（cordis 的服务注入是按
      // inject 解析的），但面板在服务缺失时会优雅降级为手动填路径。
      inject: ['slots', 'uiWorkspace'],
      apply(ctx) {
        if (ctx === appliedCtx) return;
        appliedCtx = ctx;

        // 目录选择有两条路：
        //   listDirectory —— browse 后端（本机用的就是这个），逐级浏览
        //   pickDirectory —— native 后端，弹系统对话框
        // 面板优先用 listDirectory；没有才退回 pickDirectory。
        const listDirectory = async (target) => {
          let svc;
          try { svc = ctx.uiWorkspace; } catch { svc = undefined; }
          if (!svc || typeof svc.listDirectory !== 'function') {
            throw new Error('directory browser unavailable');
          }
          return await svc.listDirectory(target);
        };

        // 新建目录：browse 后端的 createDirectory 原语
        const createDirectory = async (parent, name) => {
          let svc;
          try { svc = ctx.uiWorkspace; } catch { svc = undefined; }
          if (!svc || typeof svc.createDirectory !== 'function') {
            throw new Error('directory creation unavailable');
          }
          return await svc.createDirectory(parent, name);
        };

        const pickDirectory = async () => {
          let svc;
          try { svc = ctx.uiWorkspace; } catch { svc = undefined; }
          if (!svc || typeof svc.pickDirectory !== 'function') {
            throw new Error('directory picker unavailable');
          }
          return await svc.pickDirectory();
        };

        const Panel = () => WorkBuddyImportPanel({ pickDirectory, listDirectory, createDirectory });

        // 路线 1（主）：注册成「内置插件」页里的一个 tab。
        // label 必须是函数 —— 宿主用 resolveSlotLabel(entry.options.label) 取值。
        try {
          ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
            name: 'settings.plugins.tab',
            id: 'wb-import',
            order: 50,
            label: () => COPY.title,
          }, Panel));
        } catch (err) {
          // 该 slot 不存在时不要让整个 client 半区崩掉
          if (typeof console !== 'undefined') console.warn('[dsh-wb-import] settings.plugins.tab unavailable:', err);
        }

        // 路线 2（兜底）：注册成设置左侧导航里的独立入口，
        // 这样即便「内置插件」页的 tab 机制不生效，也能直接看到本页。
        try {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'wb-import',
            order: 60,
            label: () => COPY.title,
          }, Panel));
        } catch (err) {
          if (typeof console !== 'undefined') console.warn('[dsh-wb-import] settings.section unavailable:', err);
        }
      },
    };
  },
});

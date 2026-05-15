export function getAnupWorkbenchHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tanren Agent Workbench</title>
  <style>
    :root { color-scheme: light dark; --bg:#f7f7f4; --fg:#171717; --muted:#64645f; --line:#d8d8d0; --panel:#ffffff; --accent:#146b5d; --warn:#a15c00; --bad:#a12b2b; }
    @media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#ededeb; --muted:#aaa69d; --line:#33332e; --panel:#1a1a17; --accent:#4cc3a8; --warn:#f0a23a; --bad:#ff7676; } }
    * { box-sizing: border-box; }
    body { margin:0; font:14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--fg); }
    header { position:sticky; top:0; z-index:2; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 20px; border-bottom:1px solid var(--line); background:color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter: blur(10px); }
    h1 { margin:0; font-size:18px; letter-spacing:0; }
    main { display:grid; grid-template-columns: 280px minmax(0, 1fr); min-height:calc(100vh - 58px); }
    aside { border-right:1px solid var(--line); padding:16px; overflow:auto; }
    section { padding:20px; overflow:auto; }
    button, select { border:1px solid var(--line); border-radius:6px; padding:7px 10px; background:var(--panel); color:var(--fg); font:inherit; }
    button { cursor:pointer; }
    .toolbar { display:flex; gap:8px; align-items:center; }
    .run-meta { color:var(--muted); font-size:12px; }
    .nav-item { display:block; width:100%; text-align:left; margin:0 0 8px; }
    .nav-item[aria-current="true"] { border-color:var(--accent); color:var(--accent); }
    .grid { display:grid; gap:12px; }
    .card { border:1px solid var(--line); border-radius:8px; padding:14px; background:var(--panel); }
    .card h2 { margin:0 0 8px; font-size:15px; }
    .type { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    .muted { color:var(--muted); }
    .risk-high, .risk-critical { color:var(--bad); }
    .risk-medium { color:var(--warn); }
    ul { margin:8px 0 0; padding-left:20px; }
    pre { margin:8px 0 0; white-space:pre-wrap; overflow:auto; }
    img, video { max-width:min(100%, 720px); border:1px solid var(--line); border-radius:6px; display:block; margin-top:10px; }
    audio { width:min(100%, 720px); margin-top:10px; }
    .actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
    @media (max-width: 760px) { main { grid-template-columns:1fr; } aside { border-right:0; border-bottom:1px solid var(--line); } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Tanren Agent Workbench</h1>
      <div id="meta" class="run-meta">Loading ANUP overview...</div>
    </div>
    <div class="toolbar">
      <select id="source"><option value="/anup/overview">Overview</option></select>
      <button id="refresh">Refresh</button>
    </div>
  </header>
  <main>
    <aside>
      <div class="run-meta">Blocks</div>
      <div id="nav"></div>
    </aside>
    <section><div id="blocks" class="grid"></div></section>
  </main>
  <script>
    const state = { envelope: null };
    const $ = id => document.getElementById(id);
    $('refresh').addEventListener('click', load);
    load();

    async function load() {
      const res = await fetch($('source').value);
      if (!res.ok) throw new Error(await res.text());
      state.envelope = await res.json();
      render();
    }

    function render() {
      const run = state.envelope;
      $('meta').textContent = run.protocol + ' ' + run.version + ' | ' + run.agent_id + ' | ' + run.run_id + ' | ' + run.timestamp;
      $('nav').innerHTML = run.blocks.map((block, i) =>
        '<button class="nav-item" onclick="document.getElementById(\\'block-' + i + '\\').scrollIntoView({behavior:\\'smooth\\', block:\\'start\\'})">' +
        escapeHtml(block.type) + '<br><span class="muted">' + escapeHtml(block.title || block.id) + '</span></button>'
      ).join('');
      $('blocks').innerHTML = run.blocks.map((block, i) => renderBlock(block, i, run.run_id)).join('');
    }

    function renderBlock(block, index, runId) {
      const head = '<div class="type">' + escapeHtml(block.type) + '</div><h2>' + escapeHtml(block.title || block.id) + '</h2>';
      let body = '';
      if (block.type === 'task_contract') body = '<p>' + escapeHtml(block.goal) + '</p>' + list('Success', block.success_criteria) + list('Constraints', block.constraints);
      else if (block.type === 'agent_state') body = '<p><b>' + escapeHtml(block.phase) + '</b> / ' + escapeHtml(block.status) + '</p><p>' + escapeHtml(block.current_step) + '</p>' + list('Done', block.completed_steps) + list('Next', block.next_steps);
      else if (block.type === 'context_summary') body = '<p class="muted">' + escapeHtml(block.source) + '</p>' + listItems(block.items || []);
      else if (block.type === 'constraint_panel') body = listItems((block.constraints || []).map(c => ({ summary: c.name + ': ' + c.description })));
      else if (block.type === 'decision_card') body = '<p>' + escapeHtml(block.summary) + '</p>' + listItems((block.options || []).map(o => ({ summary: (o.recommended ? '[recommended] ' : '') + o.label + ' | risk=' + o.risk + ' impact=' + o.impact }))) + list('Rationale', block.rationale);
      else if (block.type === 'approval_request') body = renderApproval(block, runId);
      else if (block.type === 'tool_trace') body = listItems((block.events || []).map(e => ({ summary: e.time + ' ' + e.status + ' ' + e.tool + ' - ' + e.input_summary })));
      else if (block.type === 'artifact') body = '<p>' + escapeHtml(block.summary || '') + '</p><p><a href="' + escapeAttr(block.content_ref) + '">' + escapeHtml(block.content_ref) + '</a></p>';
      else if (block.type === 'media_ref') body = renderMedia(block);
      else body = '<pre>' + escapeHtml(JSON.stringify(block, null, 2)) + '</pre>';
      return '<article id="block-' + index + '" class="card">' + head + body + '</article>';
    }

    function renderApproval(block, runId) {
      return '<p class="risk-' + escapeAttr(block.risk_level) + '">Risk: ' + escapeHtml(block.risk_level) + '</p>' +
        '<p><b>' + escapeHtml(block.action.kind) + '</b> ' + escapeHtml(block.action.target) + '</p>' +
        '<p>' + escapeHtml(block.action.description) + '</p>' +
        '<div class="actions">' + (block.available_actions || []).map(a => '<button onclick="sendAction(\\'' + escapeAttr(runId) + '\\',\\'' + escapeAttr(block.id) + '\\',\\'' + escapeAttr(a.id) + '\\')">' + escapeHtml(a.label) + '</button>').join('') + '</div>';
    }

    async function sendAction(runId, blockId, actionId) {
      if (runId === 'overview' || runId.startsWith('task:')) { alert('Projected runs are read-only. Persist a run under /anup/runs before action submission.'); return; }
      await fetch('/anup/runs/' + encodeURIComponent(runId) + '/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source_block_id: blockId, action_id: actionId })
      });
      await load();
    }

    function renderMedia(block) {
      const uri = escapeAttr(block.uri);
      let preview = '<p><a href="' + uri + '">' + escapeHtml(block.uri) + '</a></p>';
      if (block.kind === 'image') preview += '<img src="' + uri + '" alt="' + escapeAttr(block.label || block.title) + '">';
      if (block.kind === 'audio') preview += '<audio controls src="' + uri + '"></audio>';
      if (block.kind === 'video') preview += '<video controls src="' + uri + '"></video>';
      return '<p class="muted">' + escapeHtml(block.media_type) + '</p>' + preview;
    }

    function list(title, values) {
      if (!values || !values.length) return '';
      return '<p class="muted">' + escapeHtml(title) + '</p><ul>' + values.map(v => '<li>' + escapeHtml(v) + '</li>').join('') + '</ul>';
    }

    function listItems(items) {
      if (!items.length) return '';
      return '<ul>' + items.map(item => '<li>' + escapeHtml(item.summary || item.id || JSON.stringify(item)) + (item.content_ref ? ' <a href="' + escapeAttr(item.content_ref) + '">open</a>' : '') + '</li>').join('') + '</ul>';
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
    }
    function escapeAttr(value) { return escapeHtml(value).replace(/\\x60/g, '&#96;'); }
  </script>
</body>
</html>`
}

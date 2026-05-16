export function getAnupWorkbenchHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workbench</title>
  <style>
    :root { color-scheme: light dark; --bg:#f7f7f4; --fg:#171717; --muted:#64645f; --line:#d9d9d2; --panel:#fff; --panel2:#f0f2ed; --accent:#146b5d; --warn:#a15c00; --bad:#a12b2b; --good:#287a3e; }
    @media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#ededeb; --muted:#aaa69d; --line:#33332e; --panel:#1a1a17; --panel2:#20201c; --accent:#4cc3a8; --warn:#f0a23a; --bad:#ff7676; --good:#7bd88f; } }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { position:sticky; top:0; z-index:2; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:13px 18px; border-bottom:1px solid var(--line); background:color-mix(in srgb, var(--bg) 94%, transparent); backdrop-filter:blur(10px); }
    h1 { margin:0; font-size:18px; letter-spacing:0; }
    h2 { margin:0 0 10px; font-size:14px; letter-spacing:0; }
    h3 { margin:0 0 6px; font-size:13px; letter-spacing:0; }
    main { display:grid; grid-template-columns:minmax(340px, 430px) minmax(0, 1fr); min-height:calc(100vh - 58px); }
    aside { display:flex; flex-direction:column; gap:12px; padding:14px; border-right:1px solid var(--line); min-height:calc(100vh - 58px); }
    section { padding:16px; overflow:auto; }
    button, select, textarea { border:1px solid var(--line); border-radius:6px; background:var(--panel); color:var(--fg); font:inherit; }
    button, select { padding:7px 10px; }
    button { cursor:pointer; }
    textarea { width:100%; min-height:92px; padding:10px; resize:vertical; }
    input { width:100%; border:1px solid var(--line); border-radius:6px; background:var(--panel); color:var(--fg); font:inherit; padding:8px 9px; }
    button.primary { border-color:var(--accent); color:var(--accent); }
    button.danger { border-color:var(--bad); color:var(--bad); }
    .muted { color:var(--muted); }
    .meta { color:var(--muted); font-size:12px; }
    .toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
    .panel { border:1px solid var(--line); border-radius:8px; background:var(--panel); padding:12px; }
    .panel.soft { background:var(--panel2); }
    .chat { flex:1; display:flex; flex-direction:column; gap:10px; min-height:420px; }
    .messages { flex:1; min-height:220px; overflow:auto; border:1px solid var(--line); border-radius:8px; background:var(--panel); padding:10px; }
    .message { padding:8px 0; border-bottom:1px solid var(--line); }
    .message:last-child { border-bottom:0; }
    .role { color:var(--muted); font-size:12px; text-transform:uppercase; }
    .content { white-space:pre-wrap; overflow-wrap:anywhere; }
    .runs { max-height:220px; overflow:auto; display:grid; gap:6px; }
    .run { width:100%; text-align:left; }
    .run[aria-current="true"] { border-color:var(--accent); color:var(--accent); }
    .workspace { display:grid; gap:12px; }
    .top-grid { display:grid; grid-template-columns:minmax(0, 1.25fr) minmax(280px, .75fr); gap:12px; }
    .cards { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:12px; }
    .card { border:1px solid var(--line); border-radius:8px; background:var(--panel); padding:13px; min-width:0; }
    .card.urgent { border-color:var(--warn); }
    .card.bad { border-color:var(--bad); }
    .summary { white-space:pre-wrap; overflow-wrap:anywhere; }
    .pill { display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:999px; padding:2px 8px; margin:0 4px 4px 0; color:var(--muted); font-size:12px; }
    .pill.ok { color:var(--good); border-color:color-mix(in srgb, var(--good) 48%, var(--line)); }
    .pill.no { color:var(--muted); }
    .pill.warn { color:var(--warn); border-color:color-mix(in srgb, var(--warn) 48%, var(--line)); }
    .status { display:inline-flex; align-items:center; gap:6px; font-size:12px; border:1px solid var(--line); border-radius:999px; padding:2px 8px; margin-bottom:8px; }
    .status.pending { color:var(--warn); border-color:color-mix(in srgb, var(--warn) 48%, var(--line)); }
    .status.approve { color:var(--good); border-color:color-mix(in srgb, var(--good) 48%, var(--line)); }
    .status.reject { color:var(--bad); border-color:color-mix(in srgb, var(--bad) 48%, var(--line)); }
    .status.modify { color:var(--accent); border-color:color-mix(in srgb, var(--accent) 48%, var(--line)); }
    .risk-high, .risk-critical { color:var(--bad); }
    .risk-medium { color:var(--warn); }
    .timeline { display:grid; gap:8px; }
    .event { border-left:3px solid var(--line); padding-left:10px; }
    .event.failed { border-left-color:var(--bad); }
    .event.success { border-left-color:var(--good); }
    .artifact-list, .decision-list { display:grid; gap:10px; }
    details { border:1px solid var(--line); border-radius:8px; background:var(--panel); padding:10px 12px; }
    summary { cursor:pointer; color:var(--muted); }
    pre { white-space:pre-wrap; overflow:auto; margin:10px 0 0; }
    ul { margin:8px 0 0; padding-left:18px; }
    img, video { max-width:min(100%, 760px); border:1px solid var(--line); border-radius:6px; display:block; margin-top:10px; }
    audio { width:min(100%, 760px); margin-top:10px; }
    .debug-blocks { opacity:.86; }
    @media (max-width: 900px) { main, .top-grid, .cards { grid-template-columns:1fr; } aside { border-right:0; border-bottom:1px solid var(--line); } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Agent Workbench</h1>
      <div id="meta" class="meta">Loading...</div>
    </div>
    <div class="toolbar">
      <select id="source"><option value="/anup/overview">Overview</option></select>
      <button id="refresh">Refresh</button>
    </div>
  </header>
  <main>
    <aside>
      <div class="chat">
        <div class="panel soft">
          <h2>Talk To Akari</h2>
          <div class="meta">Send with button or Ctrl/Cmd + Enter. After a response, this page opens the matching run.</div>
        </div>
        <div id="messages" class="messages"></div>
        <div>
          <textarea id="chatInput" placeholder="Ask Akari what to do, what it knows, or what decision it needs from you..."></textarea>
          <div class="toolbar" style="margin-top:8px">
            <input id="attachUri" placeholder="Optional attachment URL, file path, or artifact ref">
            <input id="attachMediaType" placeholder="media type, e.g. image/png">
          </div>
          <div id="attachmentPreview" class="meta" style="margin-top:6px"></div>
          <div class="toolbar" style="margin-top:8px">
            <button id="send" class="primary">Send</button>
            <button id="demo">Seed Demo</button>
            <button id="clearChat">Clear</button>
            <span id="chatStatus" class="meta"></span>
          </div>
        </div>
      </div>
      <div class="panel">
        <h2>Run History</h2>
        <div id="runs" class="runs"><span class="meta">Loading runs...</span></div>
      </div>
    </aside>
    <section>
      <div class="workspace">
        <div class="top-grid">
          <div id="taskPanel" class="card"></div>
          <div id="statePanel" class="card"></div>
        </div>
        <div id="capabilityPanel" class="card"></div>
        <div class="cards">
          <div id="approvalPanel" class="card"></div>
          <div id="decisionPanel" class="card"></div>
        </div>
        <div class="cards">
          <div id="timelinePanel" class="card"></div>
          <div id="artifactPanel" class="card"></div>
        </div>
        <details class="debug-blocks">
          <summary>Debug: Raw ANUP Blocks</summary>
          <div id="rawBlocks"></div>
        </details>
      </div>
    </section>
  </main>
  <script>
    const state = { envelope: null, actions: [], selectedSource: '/anup/overview', runs: [], health: null };
    const $ = id => document.getElementById(id);

    $('refresh').addEventListener('click', () => refreshAll(false));
    $('source').addEventListener('change', () => loadSource($('source').value));
    $('send').addEventListener('click', sendChat);
    $('demo').addEventListener('click', seedDemo);
    $('clearChat').addEventListener('click', () => { $('messages').innerHTML = ''; });
    $('attachUri').addEventListener('input', renderAttachmentPreview);
    $('attachMediaType').addEventListener('input', renderAttachmentPreview);
    $('chatInput').addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) sendChat();
    });

    refreshAll(false);

    async function refreshAll(selectLatest) {
      await loadHealth();
      await loadRuns(selectLatest);
      await loadSource(state.selectedSource);
    }

    async function loadHealth() {
      try {
        const res = await fetch('/health');
        state.health = res.ok ? await res.json() : null;
      } catch {
        state.health = null;
      }
    }

    async function loadRuns(selectLatest) {
      const res = await fetch('/anup/runs?limit=25');
      if (!res.ok) return;
      const body = await res.json();
      state.runs = body.runs || [];
      const select = $('source');
      const current = select.value || state.selectedSource;
      select.innerHTML = '<option value="/anup/overview">Overview</option>' + state.runs.map(run =>
        '<option value="/anup/runs/' + encodeURIComponent(run.run_id) + '">' + escapeHtml(labelRun(run)) + '</option>'
      ).join('');
      state.selectedSource = selectLatest && state.runs[0]
        ? '/anup/runs/' + encodeURIComponent(state.runs[0].run_id)
        : current;
      select.value = state.selectedSource;
      renderRuns();
    }

    async function loadSource(source) {
      state.selectedSource = source;
      $('source').value = source;
      const res = await fetch(source);
      if (!res.ok) throw new Error(await res.text());
      const body = await res.json();
      state.envelope = body.run || body;
      state.actions = body.actions || [];
      render();
    }

    function renderRuns() {
      $('runs').innerHTML = state.runs.length ? state.runs.map(run => {
        const source = '/anup/runs/' + encodeURIComponent(run.run_id);
        const current = source === state.selectedSource ? 'true' : 'false';
        return '<button class="run" aria-current="' + current + '" onclick="loadSource(\\'' + source + '\\')">' +
          escapeHtml(labelRun(run)) + '<br><span class="meta">' + escapeHtml(new Date(run.timestamp).toLocaleString()) + ' · ' + run.blocks.length + ' blocks</span></button>';
      }).join('') : '<span class="meta">No persisted runs yet.</span>';
    }

    function render() {
      const run = state.envelope;
      if (!run) return;
      $('meta').textContent = run.agent_id + ' · ' + run.run_id + ' · ' + new Date(run.timestamp).toLocaleString();
      renderRuns();
      renderTask(run);
      renderState(run);
      renderCapabilities(run);
      renderApprovals(run);
      renderDecisions(run);
      renderTimeline(run);
      renderArtifacts(run);
      renderRaw(run);
    }

    async function sendChat() {
      const input = $('chatInput');
      const text = input.value.trim();
      const attachment = readAttachment();
      if (!text && !attachment) return;
      input.value = '';
      $('attachUri').value = '';
      $('attachMediaType').value = '';
      renderAttachmentPreview();
      const messageText = attachment
        ? text + '\\n\\n[ATTACHMENT]\\nuri: ' + attachment.uri + '\\nmediaType: ' + attachment.mediaType
        : text;
      appendMessage('you', messageText);
      const assistant = appendMessage('akari', '');
      $('chatStatus').textContent = 'streaming...';
      try {
        const res = await fetch('/chat/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            from: 'web',
            text,
            attachments: attachment ? [attachment] : []
          })
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\\n\\n');
          buffer = parts.pop() || '';
          for (const part of parts) {
            const event = parseSse(part);
            if (event.event === 'result') assistant.querySelector('.content').textContent = event.data.response || '';
            if (event.event === 'error') assistant.querySelector('.content').textContent = '[error] ' + (event.data.error || 'unknown');
          }
        }
        $('chatStatus').textContent = 'done';
        await refreshAll(true);
      } catch (err) {
        assistant.querySelector('.content').textContent = '[error] ' + err.message;
        $('chatStatus').textContent = 'error';
      }
    }

    async function seedDemo() {
      const res = await fetch('/demo/anup', { method: 'POST' });
      const run = await res.json();
      await loadRuns(false);
      await loadSource('/anup/runs/' + encodeURIComponent(run.run_id));
    }

    function renderTask(run) {
      const task = block(run, 'task_contract');
      $('taskPanel').innerHTML = '<h2>Current Task</h2>' + (task
        ? '<div class="summary">' + escapeHtml(task.goal) + '</div>' +
          chips(task.inputs, 'Input') +
          list('Success Criteria', task.success_criteria) +
          list('Constraints', task.constraints)
        : '<div class="muted">No explicit task contract. Start a chat or seed a demo run.</div>');
    }

    function renderState(run) {
      const item = block(run, 'agent_state');
      $('statePanel').innerHTML = '<h2>Current State</h2>' + (item
        ? '<div><span class="pill">' + escapeHtml(item.phase) + '</span><span class="pill">' + escapeHtml(item.status) + '</span></div>' +
          '<div class="summary">' + escapeHtml(item.current_step) + '</div>' +
          list('Done', item.completed_steps) + list('Next', item.next_steps)
        : '<div class="muted">No state block available.</div>');
    }

    function renderCapabilities(run) {
      const llm = state.health?.agent?.llm || state.health?.capabilities?.llm || {};
      const routing = state.health?.capabilities?.routing?.modelProviders || [];
      const input = llm.capabilities?.input || {};
      const output = llm.capabilities?.output || {};
      const streaming = llm.capabilities?.streaming || {};
      const nativeMedia = Boolean(input.image || input.audio || input.pdf || output.image || output.audio || output.file);
      const attachmentMode = nativeMedia
        ? 'Provider advertises native media capability; attachments can be routed without changing the UI contract.'
        : 'Current provider is text/tool-first; attachments are preserved as structured refs and summarized into the text loop.';
      $('capabilityPanel').innerHTML =
        '<h2>Provider & Media Capability</h2>' +
        '<div class="summary">' + escapeHtml(llm.provider || state.health?.agent?.provider || run.agent_id || 'Unknown provider') + '</div>' +
        '<div style="margin-top:10px">' +
          capabilityPill('text in', input.text) +
          capabilityPill('image in', input.image) +
          capabilityPill('audio in', input.audio) +
          capabilityPill('pdf in', input.pdf) +
          capabilityPill('file in', input.file) +
          capabilityPill('text stream', streaming.text) +
          capabilityPill('tool calls', llm.capabilities?.tools?.native) +
          capabilityPill('image out', output.image) +
          capabilityPill('audio out', output.audio) +
        '</div>' +
        '<div class="meta" style="margin-top:8px">' + escapeHtml(attachmentMode) + '</div>' +
        (routing.length ? '<div class="meta" style="margin-top:8px">Routing pool: ' + escapeHtml(routing.map(provider => provider.name).join(', ')) + '</div>' : '');
    }

    function renderApprovals(run) {
      const approvals = blocks(run, 'approval_request');
      $('approvalPanel').className = 'card' + (approvals.length ? ' urgent' : '');
      $('approvalPanel').innerHTML = '<h2>Needs Your Decision</h2>' + (approvals.length
        ? approvals.map(item => renderApproval(item, run.run_id)).join('')
        : '<div class="muted">No pending decision in this run.</div>');
    }

    function renderDecisions(run) {
      const decisions = blocks(run, 'decision_card');
      $('decisionPanel').innerHTML = '<h2>Decision Summary</h2>' + (decisions.length
        ? '<div class="decision-list">' + decisions.map(renderDecision).join('') + '</div>'
        : '<div class="muted">No decision card in this run.</div>');
    }

    function renderTimeline(run) {
      const traces = blocks(run, 'tool_trace').flatMap(trace => trace.events || []);
      $('timelinePanel').innerHTML = '<h2>Action Timeline</h2>' + (traces.length
        ? '<div class="timeline">' + traces.map(event => '<div class="event ' + escapeAttr(event.status || '') + '"><div><b>' + escapeHtml(event.tool) + '</b> <span class="meta">' + escapeHtml(event.status || '') + '</span></div><div class="muted">' + escapeHtml(event.input_summary || '') + '</div><div class="meta">' + escapeHtml(event.time || '') + '</div></div>').join('') + '</div>'
        : '<div class="muted">No tool trace yet.</div>');
    }

    function renderArtifacts(run) {
      const artifacts = blocks(run, 'artifact');
      const media = blocks(run, 'media_ref');
      $('artifactPanel').innerHTML = '<h2>Artifacts & Media</h2>' + (artifacts.length || media.length
        ? '<div class="artifact-list">' + artifacts.map(renderArtifact).join('') + media.map(renderMedia).join('') + '</div>'
        : '<div class="muted">No artifacts or media refs in this run.</div>');
    }

    function renderRaw(run) {
      $('rawBlocks').innerHTML = run.blocks.map((item, index) =>
        '<details><summary>' + escapeHtml(item.type + ' · ' + (item.title || item.id)) + '</summary><pre>' + escapeHtml(JSON.stringify(item, null, 2)) + '</pre></details>'
      ).join('');
    }

    function renderApproval(item, runId) {
      const response = latestAction(item.id);
      const status = response?.action_id || 'pending';
      return '<div class="panel">' +
        '<h3>' + escapeHtml(item.title || item.id) + '</h3>' +
        '<div class="status ' + escapeAttr(status) + '">' + escapeHtml(statusLabel(status)) + '</div>' +
        '<div class="risk-' + escapeAttr(item.risk_level) + '">Risk: ' + escapeHtml(item.risk_level) + '</div>' +
        '<div><b>' + escapeHtml(item.action?.kind || '') + '</b> ' + escapeHtml(item.action?.target || '') + '</div>' +
        '<p class="muted">' + escapeHtml(item.action?.description || '') + '</p>' +
        '<p class="meta">' + escapeHtml(approvalReason(item)) + '</p>' +
        '<div class="toolbar">' + (item.available_actions || []).map(action =>
          '<button onclick="sendAction(\\'' + escapeAttr(runId) + '\\',\\'' + escapeAttr(item.id) + '\\',\\'' + escapeAttr(action.id) + '\\')">' + escapeHtml(action.label) + '</button>'
        ).join('') + '</div></div>';
    }

    function renderDecision(item) {
      return '<div class="panel">' +
        '<h3>' + escapeHtml(item.title || item.id) + '</h3>' +
        '<div class="summary">' + escapeHtml(item.summary || '') + '</div>' +
        '<ul>' + (item.options || []).map(option => '<li>' + (option.recommended ? '<b>Recommended:</b> ' : '') + escapeHtml(option.label || option.id) + ' <span class="meta">risk=' + escapeHtml(option.risk || '-') + ' impact=' + escapeHtml(option.impact || '-') + '</span></li>').join('') + '</ul>' +
        list('Rationale', item.rationale) + '</div>';
    }

    function renderArtifact(item) {
      return '<div class="panel"><h3>' + escapeHtml(item.title || item.id) + '</h3><div class="summary">' + escapeHtml(item.summary || '') + '</div><a href="' + escapeAttr(item.content_ref || '#') + '">' + escapeHtml(item.content_ref || '') + '</a></div>';
    }

    function renderMedia(item) {
      const uri = escapeAttr(item.uri || '');
      let preview = '<a href="' + uri + '">' + escapeHtml(item.uri || '') + '</a>';
      if (item.kind === 'image') preview += '<img src="' + uri + '" alt="' + escapeAttr(item.label || item.title || 'image') + '">';
      if (item.kind === 'audio') preview += '<audio controls src="' + uri + '"></audio>';
      if (item.kind === 'video') preview += '<video controls src="' + uri + '"></video>';
      return '<div class="panel"><h3>' + escapeHtml(item.title || item.id) + '</h3><div class="meta">' + escapeHtml(item.media_type || '') + '</div>' + preview + '</div>';
    }

    async function sendAction(runId, blockId, actionId) {
      if (runId === 'overview' || runId.startsWith('task:')) { alert('Projected runs are read-only.'); return; }
      await fetch('/anup/runs/' + encodeURIComponent(runId) + '/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source_block_id: blockId, action_id: actionId })
      });
      await loadSource(state.selectedSource);
    }

    function appendMessage(role, content) {
      const item = document.createElement('div');
      item.className = 'message';
      item.innerHTML = '<div class="role"></div><div class="content"></div>';
      item.querySelector('.role').textContent = role;
      item.querySelector('.content').textContent = content;
      $('messages').appendChild(item);
      $('messages').scrollTop = $('messages').scrollHeight;
      return item;
    }

    function parseSse(text) {
      const eventLine = text.split('\\n').find(line => line.startsWith('event:'));
      const dataLine = text.split('\\n').find(line => line.startsWith('data:'));
      let data = {};
      try { data = JSON.parse((dataLine || 'data:{}').slice(5).trim()); } catch {}
      return { event: (eventLine || 'event:message').slice(6).trim(), data };
    }

    function readAttachment() {
      const uri = $('attachUri').value.trim();
      const mediaType = $('attachMediaType').value.trim() || guessMediaType(uri);
      if (!uri) return null;
      return { uri, mediaType };
    }

    function renderAttachmentPreview() {
      const attachment = readAttachment();
      if (!attachment) {
        $('attachmentPreview').textContent = '';
        return;
      }
      const supported = mediaSupportedByProvider(attachment.mediaType);
      $('attachmentPreview').innerHTML =
        '<span class="pill ' + (supported ? 'ok' : 'warn') + '">' + escapeHtml(attachment.mediaType) + '</span>' +
        '<span>' + escapeHtml(supported ? 'native-capable provider path available' : 'will be preserved as ANUP media_ref and text summary') + '</span>';
    }

    function mediaSupportedByProvider(mediaType) {
      const input = (state.health?.agent?.llm || state.health?.capabilities?.llm || {}).capabilities?.input || {};
      if (mediaType.startsWith('image/')) return Boolean(input.image);
      if (mediaType.startsWith('audio/')) return Boolean(input.audio);
      if (mediaType === 'application/pdf') return Boolean(input.pdf);
      return Boolean(input.file);
    }

    function guessMediaType(uri) {
      if (/\\.png($|\\?)/i.test(uri)) return 'image/png';
      if (/\\.jpe?g($|\\?)/i.test(uri)) return 'image/jpeg';
      if (/\\.webp($|\\?)/i.test(uri)) return 'image/webp';
      if (/\\.mp3($|\\?)/i.test(uri)) return 'audio/mpeg';
      if (/\\.wav($|\\?)/i.test(uri)) return 'audio/wav';
      if (/\\.mp4($|\\?)/i.test(uri)) return 'video/mp4';
      if (/\\.pdf($|\\?)/i.test(uri)) return 'application/pdf';
      return 'application/octet-stream';
    }

    function block(run, type) { return (run.blocks || []).find(item => item.type === type); }
    function blocks(run, type) { return (run.blocks || []).filter(item => item.type === type); }

    function labelRun(run) {
      const task = block(run, 'task_contract');
      const artifact = block(run, 'artifact');
      return (task?.title || artifact?.title || run.run_id).slice(0, 64);
    }

    function list(title, values) {
      if (!values || !values.length) return '';
      return '<div class="meta" style="margin-top:10px">' + escapeHtml(title) + '</div><ul>' + values.map(value => '<li>' + escapeHtml(value) + '</li>').join('') + '</ul>';
    }

    function chips(values, prefix) {
      if (!values || !values.length) return '';
      return '<div style="margin-top:10px">' + values.map(value => '<span class="pill">' + escapeHtml(prefix + ': ' + value) + '</span>').join('') + '</div>';
    }

    function capabilityPill(label, enabled) {
      return '<span class="pill ' + (enabled ? 'ok' : 'no') + '">' + escapeHtml(label + ': ' + (enabled ? 'yes' : 'no')) + '</span>';
    }

    function latestAction(blockId) {
      return [...state.actions]
        .filter(action => action.source_block_id === blockId)
        .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))[0] || null;
    }

    function statusLabel(status) {
      if (status === 'approve') return 'Approved';
      if (status === 'reject') return 'Rejected';
      if (status === 'modify') return 'Modify requested';
      return 'Pending approval';
    }

    function approvalReason(item) {
      if (item.risk_level === 'critical' || item.risk_level === 'high') return 'This is gated because it can change files, run commands, deploy, or call an external provider with side effects.';
      if (item.action?.kind === 'send_message') return 'This is gated because it sends information outside the local workspace.';
      return 'This request is shown because the agent needs a human decision before continuing.';
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
    }
    function escapeAttr(value) { return escapeHtml(value).replace(/\\x60/g, '&#96;'); }
  </script>
</body>
</html>`;
}

#!/bin/bash
# tanren-live — 即時顯示 Tanren agent 的 tick 狀態
#
# 讀取 live-status.json + ticks.jsonl，在終端機渲染即時 TUI。
# 不需要 HTTP server — 純檔案監控。
#
# 用法：
#   bash scripts/tanren-live.sh
#   bash scripts/tanren-live.sh examples/with-learning
#   bash scripts/tanren-live.sh examples/with-learning --interval 2

AGENT_DIR="${1:-examples/with-learning}"
[[ "$1" != --* ]] && shift 2>/dev/null || true
INTERVAL=1

while [ $# -gt 0 ]; do
  case "$1" in
    --interval) INTERVAL="$2"; shift ;;
    *) echo "Usage: tanren-live [agent-dir] [--interval SECS]" >&2; exit 1 ;;
  esac
  shift
done

exec python3 -u - "$AGENT_DIR" "$INTERVAL" <<'PYEOF'
import sys, json, time, os, shutil, textwrap
from datetime import datetime

agent_dir = sys.argv[1]
interval_s = float(sys.argv[2])

# Resolve paths
mem_dir = os.path.join(agent_dir, 'memory')
state_dir = os.path.join(mem_dir, 'state')
journal_dir = os.path.join(mem_dir, 'journal')
msg_dir = os.path.join(agent_dir, 'messages')

status_path = os.path.join(state_dir, 'live-status.json')
ticks_path = os.path.join(journal_dir, 'ticks.jsonl')
checkpoint_path = os.path.join(state_dir, '.checkpoint.json')

# ANSI colors
R  = '\033[0m';  B  = '\033[1m';  D  = '\033[2m'
UP = '\033[A';   EL = '\033[2K'
G  = '\033[38;5;82m'   # green — active
GR = '\033[38;5;240m'  # grey — idle
OR = '\033[38;5;215m'  # orange — actions
CY = '\033[38;5;45m'   # cyan
BL = '\033[38;5;75m'   # blue — numbers
WH = '\033[38;5;252m'  # white — text
DM = '\033[38;5;238m'  # dim
YL = '\033[38;5;214m'  # yellow — warn
PK = '\033[38;5;141m'  # purple — thought
MG = '\033[38;5;205m'  # magenta — thinking

SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
spin_i = 0

PHASE_INFO = {
    'perceive': ('👁  PERCEIVE', G),
    'think':    ('🧠 THINKING',  MG),
    'act':      ('⚡ ACTING',    OR),
    'idle':     ('○  idle',      GR),
    'stopped':  ('⏹  stopped',   GR),
}


def read_json(path):
    try:
        with open(path, 'r') as f:
            return json.load(f)
    except Exception:
        return None


def read_last_jsonl(path):
    """Read the last line of a JSONL file efficiently."""
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2)
            pos = f.tell()
            if pos == 0:
                return None
            buf = b''
            while pos > 0:
                pos -= 1
                f.seek(pos)
                ch = f.read(1)
                if ch == b'\n' and buf:
                    break
                buf = ch + buf
            if not buf:
                f.seek(0)
                buf = f.readline()
            line = buf.decode('utf-8').strip()
            return json.loads(line) if line else None
    except Exception:
        return None


def file_size(path):
    try:
        return os.path.getsize(path)
    except Exception:
        return 0


def trunc(s, n):
    s = str(s).replace('\n', ' ').strip()
    return s[:n] + '…' if len(s) > n else s


def wrap_text(s, width, max_lines=3):
    s = str(s).strip()
    if not s:
        return ['']
    result = []
    for para in s.split('\n'):
        para = para.strip()
        if para:
            result.extend(textwrap.wrap(para, max(width, 20)) or [para])
    if not result:
        return ['']
    if max_lines and len(result) > max_lines:
        result = result[:max_lines]
        if not result[-1].endswith('…'):
            result[-1] += ' …'
    return result


def fmt_duration(ms):
    s = int(ms / 1000)
    m, s = divmod(s, 60)
    return f"{m}m{s:02d}s" if m else f"{s}s"


def render():
    global spin_i
    cols, _ = shutil.get_terminal_size((100, 30))
    W = cols - 4
    sp = SPIN[spin_i % len(SPIN)]; spin_i += 1
    lines = []

    # Read data sources
    status = read_json(status_path)
    last_tick_data = read_last_jsonl(ticks_path)
    checkpoint = read_json(checkpoint_path)

    # Message status
    inbox_size = file_size(os.path.join(msg_dir, 'from-kuro.md'))
    outbox_size = file_size(os.path.join(msg_dir, 'to-kuro.md'))

    sep = f"{DM}{'─' * W}{R}"
    thin_sep = f"{DM}{'┄' * W}{R}"

    # Determine phase
    phase = 'idle'
    tick_num = '?'
    tick_start = 0

    if status:
        phase = status.get('phase', 'idle')
        tick_num = status.get('tickNumber', '?')
        tick_start = status.get('tickStart', 0)
    elif checkpoint:
        # Fallback: checkpoint.json exists = tick in progress
        phase = 'think'
        tick_start = checkpoint.get('tickStarted', 0)

    label, color = PHASE_INFO.get(phase, ('?', GR))
    is_active = phase in ('perceive', 'think', 'act')

    # ── Header ──
    if is_active:
        elapsed = fmt_duration((time.time() * 1000) - tick_start) if tick_start else '?'
        lines.append(f"{color}{B}{sp} {label}{R}  {DM}tick={R}{BL}#{tick_num}{R}  {DM}elapsed={R}{BL}{elapsed}{R}")
    else:
        lines.append(f"{GR}○  idle{R}  {DM}tick={R}{BL}#{tick_num}{R}")

    lines.append(sep)

    # ── Active tick details ──
    if is_active and status:
        if phase == 'perceive':
            lines.append(f"  {DM}Gathering perception data...{R}")
        elif phase == 'think':
            pb = status.get('perceptionBytes', 0)
            lines.append(f"  {DM}perception :{R} {BL}{pb:,}{R} {DM}bytes loaded{R}")
            lines.append(f"  {DM}status     :{R} {PK}waiting for LLM response...{R}")
        elif phase == 'act':
            act_types = status.get('actionTypes', [])
            act_count = status.get('actionCount', 0)
            lines.append(f"  {DM}actions    :{R} {OR}{act_count}{R} {DM}parsed{R}")
            if act_types:
                lines.append(f"  {DM}types      :{R} {OR}{', '.join(act_types)}{R}")
            lines.append(f"  {DM}status     :{R} {G}executing...{R}")
        lines.append(thin_sep)

    # ── Last completed tick ──
    lt = None
    if status and status.get('lastTick'):
        lt = status['lastTick']
    elif last_tick_data:
        obs = last_tick_data.get('observation', {})
        lt = {
            'start': last_tick_data.get('t', 0),
            'duration': obs.get('duration', 0),
            'actions': [a.get('type', '?') for a in last_tick_data.get('actions', [])],
            'quality': obs.get('quality', 0),
            'executed': obs.get('actionsExecuted', 0),
            'failed': obs.get('actionsFailed', 0),
        }

    if lt:
        dur = fmt_duration(lt.get('duration', 0))
        acts = lt.get('actions', [])
        qual = lt.get('quality', 0)
        ex = lt.get('executed', 0)
        fail = lt.get('failed', 0)

        act_str = ', '.join(acts) if acts else '(none)'
        fail_str = f"  {YL}({fail} failed){R}" if fail else ''

        lines.append(f"  {DM}Last tick   :{R} {BL}{dur}{R}  {DM}quality={R}{BL}{qual}/5{R}  {DM}actions={R}{OR}{ex}{R}{fail_str}")
        lines.append(f"  {DM}types       :{R} {WH}{trunc(act_str, W - 16)}{R}")

        # Thought preview from ticks.jsonl
        if last_tick_data and not is_active:
            thought = last_tick_data.get('thought', '')
            if thought:
                preview = ''
                for tl in thought.split('\n'):
                    tl = tl.strip()
                    if tl and not tl.startswith('<action:') and not tl.startswith('---') and not tl.startswith('<!--'):
                        preview = tl
                        break
                if preview:
                    tw = wrap_text(preview, W - 16, 2)
                    lines.append(f"  {DM}thought     :{R} {PK}{tw[0]}{R}")
                    for extra in tw[1:]:
                        lines.append(f"  {DM}             {R} {PK}{extra}{R}")
    else:
        lines.append(f"  {DM}(no completed ticks yet){R}")

    lines.append(thin_sep)

    # ── Messages ──
    inbox_str = f"{G}📩 {inbox_size:,}B{R}" if inbox_size > 0 else f"{GR}📩 empty{R}"
    outbox_str = f"{CY}📤 {outbox_size:,}B{R}" if outbox_size > 0 else f"{GR}📤 empty{R}"
    lines.append(f"  {DM}Messages    :{R} {inbox_str}  {outbox_str}")

    lines.append(sep)

    return lines


# ── Main loop ──
agent_name = os.path.basename(os.path.normpath(agent_dir))
print(f"\n{B}tanren-live{R}  {DM}{agent_dir}  Ctrl-C to exit{R}")
print()

init_lines = render()
for _ in init_lines:
    print()
prev_rows = len(init_lines)

try:
    while True:
        lines = render()
        new_rows = len(lines)

        sys.stdout.write(UP * prev_rows)
        for line in lines:
            sys.stdout.write(EL + line + '\n')
        for _ in range(max(0, prev_rows - new_rows)):
            sys.stdout.write(EL + '\n')
        sys.stdout.flush()

        prev_rows = max(new_rows, prev_rows)
        time.sleep(interval_s)
except KeyboardInterrupt:
    print(f"\n{D}stopped{R}")
PYEOF

const API = 'http://localhost:8000';

// ── State ──────────────────────────────────────────────────────────────────
let state = { currentProject: null, projects: [], dirty: false };
let selectedIds  = new Set();
let audioBuffer  = null;
let audioCtx     = null;
let dragState    = null; // { mode:'marker'|'pan', canvas, seg, card, field?, lastClientX, startClientX?, startWinStart? }
let dragRafId    = null;
let pendingWaves = new Set();

// ── DOM refs ───────────────────────────────────────────────────────────────
const uploadZone        = document.getElementById('upload-zone');
const processingOverlay = document.getElementById('processing-overlay');
const processingMsg     = document.getElementById('processing-msg');
const editor            = document.getElementById('editor');
const dropArea          = document.getElementById('drop-area');
const fileInput         = document.getElementById('file-input');
const projectList       = document.getElementById('project-list');
const segmentList       = document.getElementById('segment-list');
const segCountLabel     = document.getElementById('seg-count-label');
const audioPlayer       = document.getElementById('audio-player');
const playerFilename    = document.getElementById('player-filename');
const playerLang        = document.getElementById('player-lang');
const btnExport         = document.getElementById('btn-export');
const btnSave           = document.getElementById('btn-save');
const btnNew            = document.getElementById('btn-new');
const toast             = document.getElementById('toast');

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = '') {
  toast.textContent = msg;
  toast.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = ''; }, 3000);
}

// ── Screen switching ───────────────────────────────────────────────────────
function showScreen(name) {
  uploadZone.classList.toggle('hidden', name !== 'upload');
  processingOverlay.classList.toggle('hidden', name !== 'processing');
  editor.classList.toggle('hidden', name !== 'editor');
  btnExport.style.display = name === 'editor' ? '' : 'none';
  btnSave.style.display   = name === 'editor' ? '' : 'none';
}

// ── Project sidebar ────────────────────────────────────────────────────────
async function loadProjectList() {
  try {
    const res = await fetch(`${API}/projects`);
    state.projects = await res.json();
    renderProjectList();
  } catch {}
}

function renderProjectList() {
  projectList.innerHTML = '';
  if (state.projects.length === 0) {
    projectList.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:12px;">No projects yet</div>';
    return;
  }
  for (const p of state.projects) {
    const div = document.createElement('div');
    div.className = 'project-item' + (state.currentProject?.id === p.id ? ' active' : '');
    div.innerHTML = `
      <div class="proj-name">${escHtml(p.audio_file)}</div>
      <div class="proj-meta">${p.segment_count} segments · ${fmtDur(p.duration)} · ${p.language || '?'}</div>
    `;
    div.addEventListener('click', () => openProject(p.id));
    projectList.appendChild(div);
  }
}

// ── Open project ───────────────────────────────────────────────────────────
async function openProject(id) {
  showScreen('processing');
  processingMsg.textContent = 'Loading project…';
  try {
    const res = await fetch(`${API}/project/${id}`);
    if (!res.ok) throw new Error();
    setCurrentProject(await res.json());
  } catch {
    showToast('Failed to load project', 'error');
    showScreen('upload');
  }
}

function setCurrentProject(project) {
  state.currentProject = project;
  state.dirty = false;
  audioBuffer = null;
  pendingWaves.clear();

  playerFilename.textContent = project.audio_file;
  playerLang.textContent = project.language || 'unknown';
  audioPlayer.src = `${API}/audio/${project.id}`;
  audioPlayer.load();

  renderSegments(project.segments);
  showScreen('editor');
  loadProjectList();
  loadAudioBuffer(project.id);
}

// ── Segment rendering ──────────────────────────────────────────────────────
function renderSegments(segments) {
  selectedIds = new Set(segments.map(s => s.id));
  renderSegmentHeader(segments);
  segmentList.innerHTML = '';

  for (const seg of segments) {
    const card = document.createElement('div');
    card.className = 'segment-card';
    card.dataset.id = seg.id;

    card.innerHTML = `
      <input type="checkbox" class="seg-checkbox" checked title="Include in export" />
      <div class="seg-num">${seg.id}</div>
      <div class="seg-body">
        <textarea class="seg-text" rows="2">${escHtml(seg.text)}</textarea>
        <div class="wave-container">
          <canvas class="seg-waveform" data-seg-id="${seg.id}"></canvas>
          <button class="wave-reset-btn" title="Re-centre view">⊙</button>
        </div>
        <div class="seg-ts-row">
          <span class="ts-val" data-field="start">${fmtTime(seg.start)}</span>
          <span class="ts-arrow">→</span>
          <span class="ts-val" data-field="end">${fmtTime(seg.end)}</span>
          <span class="ts-dur">${fmtDur(seg.end - seg.start)}</span>
        </div>
      </div>
      <div class="seg-actions">
        <button class="btn-icon btn-play" title="Play segment">▶</button>
      </div>
    `;

    card.querySelector('.seg-checkbox').addEventListener('change', (e) => {
      if (e.target.checked) selectedIds.add(seg.id);
      else selectedIds.delete(seg.id);
      updateExportButton();
    });

    card.querySelector('.seg-text').addEventListener('input', (e) => {
      seg.text = e.target.value;
      markDirty();
    });

    card.querySelectorAll('.ts-val').forEach(span => {
      span.addEventListener('click', () => makeTimestampEditable(span, seg, span.dataset.field, card));
    });

    card.querySelector('.btn-play').addEventListener('click', (e) => {
      playSegment(seg, card, e.currentTarget);
    });

    const canvas = card.querySelector('.seg-waveform');
    addWaveformInteraction(canvas, seg, card);
    waveObserver.observe(canvas);

    card.querySelector('.wave-reset-btn').addEventListener('click', () => {
      drawWaveform(canvas, seg, true); // reset window to ±1.5s around segment
    });

    segmentList.appendChild(card);
  }

  updateExportButton();
}

function renderSegmentHeader(segments) {
  segCountLabel.innerHTML = `
    <span>${segments.length} Segments</span>
    <button class="sel-link" id="btn-select-all">All</button>
    <button class="sel-link" id="btn-select-none">None</button>
  `;
  document.getElementById('btn-select-all').addEventListener('click', () => {
    selectedIds = new Set(state.currentProject.segments.map(s => s.id));
    document.querySelectorAll('.seg-checkbox').forEach(cb => cb.checked = true);
    updateExportButton();
  });
  document.getElementById('btn-select-none').addEventListener('click', () => {
    selectedIds.clear();
    document.querySelectorAll('.seg-checkbox').forEach(cb => cb.checked = false);
    updateExportButton();
  });
}

// ── Waveform: load audio buffer ────────────────────────────────────────────
async function loadAudioBuffer(projectId) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const res = await fetch(`${API}/audio/${projectId}`);
    audioBuffer = await audioCtx.decodeAudioData(await res.arrayBuffer());
    pendingWaves.forEach(c => drawWaveformForCanvas(c));
  } catch (e) {
    console.warn('Waveform decode failed:', e);
  }
}

// ── Waveform: IntersectionObserver (lazy render) ───────────────────────────
const waveObserver = new IntersectionObserver((entries) => {
  entries.forEach(({ target: canvas, isIntersecting }) => {
    if (isIntersecting) {
      pendingWaves.add(canvas);
      if (audioBuffer) drawWaveformForCanvas(canvas);
    } else {
      pendingWaves.delete(canvas);
    }
  });
}, { threshold: 0 });

function drawWaveformForCanvas(canvas, resetWindow = true) {
  const seg = state.currentProject?.segments.find(s => s.id === +canvas.dataset.segId);
  if (seg) drawWaveform(canvas, seg, resetWindow);
}

// ── Waveform: draw ─────────────────────────────────────────────────────────
const WAVE_PADDING = 1.5; // initial context (seconds) on each side

function drawWaveform(canvas, seg, resetWindow = true) {
  if (!audioBuffer) return;
  const W = canvas.offsetWidth;
  if (W === 0) return;
  const H = canvas.offsetHeight;
  const maxDur = audioBuffer.duration;

  if (resetWindow || canvas._winStart === undefined) {
    canvas._winStart = Math.max(0, seg.start - WAVE_PADDING);
    canvas._winEnd   = Math.min(maxDur, seg.end + WAVE_PADDING);
  }

  const winStart = canvas._winStart;
  const winEnd   = canvas._winEnd;
  const winDur   = winEnd - winStart;

  const dpr = window.devicePixelRatio || 1;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const channelData = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;

  const segStartX = ((seg.start - winStart) / winDur) * W;
  const segEndX   = ((seg.end   - winStart) / winDur) * W;

  // Background
  ctx.fillStyle = '#13151f';
  ctx.fillRect(0, 0, W, H);

  // Segment region tint
  ctx.fillStyle = 'rgba(91,127,255,0.11)';
  ctx.fillRect(segStartX, 0, segEndX - segStartX, H);

  // Waveform bars
  for (let x = 0; x < W; x++) {
    const t0 = winStart + (x / W) * winDur;
    const t1 = winStart + ((x + 1) / W) * winDur;
    const i0 = Math.max(0, Math.floor(t0 * sr));
    const i1 = Math.min(Math.floor(t1 * sr), channelData.length - 1);
    let lo = 0, hi = 0;
    for (let i = i0; i <= i1; i++) {
      const v = channelData[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const inSeg = x >= segStartX && x <= segEndX;
    ctx.fillStyle = inSeg ? 'rgba(91,127,255,0.92)' : 'rgba(70,76,110,0.55)';
    const yTop = (H / 2) * (1 - hi);
    const yBot = (H / 2) * (1 - lo);
    ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
  }

  // Centre line
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();

  drawMarker(ctx, segStartX, H, '#4caf88', 'start');
  drawMarker(ctx, segEndX,   H, '#e07060', 'end');

  // Time labels at edges (helpful when panned/zoomed)
  ctx.fillStyle = 'rgba(120,128,160,0.7)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';  ctx.fillText(fmtTime(winStart), 4, H - 4);
  ctx.textAlign = 'right'; ctx.fillText(fmtTime(winEnd),   W - 4, H - 4);
}

function drawMarker(ctx, x, H, color, side) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();

  const TIP = 10, BASE = 8;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (side === 'start') {
    ctx.moveTo(x, 0); ctx.lineTo(x + BASE, 0); ctx.lineTo(x, TIP);
  } else {
    ctx.moveTo(x, 0); ctx.lineTo(x - BASE, 0); ctx.lineTo(x, TIP);
  }
  ctx.fill();
}

// ── Waveform: interaction ──────────────────────────────────────────────────
const HIT_PX   = 10;
const EDGE_PX  = 40;   // auto-pan trigger zone (pixels from edge)
const PAN_SPD  = 0.04; // seconds to pan per RAF frame (~2.4s/s at 60fps)

function nearestHandle(canvas, seg, x) {
  if (canvas._winStart === undefined) return null;
  const W = canvas.offsetWidth;
  const d = canvas._winEnd - canvas._winStart;
  const sx = ((seg.start - canvas._winStart) / d) * W;
  const ex = ((seg.end   - canvas._winStart) / d) * W;
  const ds = Math.abs(x - sx), de = Math.abs(x - ex);
  if (ds <= HIT_PX && ds <= de) return 'start';
  if (de <= HIT_PX)             return 'end';
  return null;
}

function addWaveformInteraction(canvas, seg, card) {
  // Mouse down — start marker drag or background pan
  canvas.addEventListener('mousedown', (e) => {
    if (!audioBuffer || canvas._winStart === undefined) return;
    e.preventDefault();
    const x = e.clientX - canvas.getBoundingClientRect().left;
    const field = nearestHandle(canvas, seg, x);

    if (field) {
      dragState = { mode: 'marker', canvas, seg, card, field, lastClientX: e.clientX };
      canvas.style.cursor = 'ew-resize';
    } else {
      dragState = { mode: 'pan', canvas, seg, card, lastClientX: e.clientX,
                    startClientX: e.clientX, startWinStart: canvas._winStart };
      canvas.style.cursor = 'grabbing';
    }

    if (!dragRafId) dragRafId = requestAnimationFrame(dragTick);
  });

  // Hover cursor
  canvas.addEventListener('mousemove', (e) => {
    if (dragState) return;
    if (canvas._winStart === undefined) return;
    const x = e.clientX - canvas.getBoundingClientRect().left;
    canvas.style.cursor = nearestHandle(canvas, seg, x) ? 'ew-resize' : 'grab';
  });

  canvas.addEventListener('mouseleave', () => {
    if (!dragState) canvas.style.cursor = '';
  });

  // Wheel scroll (pan) + Ctrl+Wheel zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!audioBuffer || canvas._winStart === undefined) return;

    const maxDur = audioBuffer.duration;
    const winDur = canvas._winEnd - canvas._winStart;

    if (e.ctrlKey) {
      // Zoom: expand or contract the window, centred on mouse position
      const mouseT = canvas._winStart + (e.clientX - canvas.getBoundingClientRect().left)
                     / canvas.offsetWidth * winDur;
      const factor  = e.deltaY > 0 ? 1.25 : 0.8;
      const newDur  = clamp(winDur * factor, 0.5, Math.min(maxDur, 120));
      const ratio   = (mouseT - canvas._winStart) / winDur;
      canvas._winStart = clamp(mouseT - ratio * newDur, 0, maxDur - newDur);
      canvas._winEnd   = canvas._winStart + newDur;
    } else {
      // Scroll left/right
      const shift = winDur * 0.25 * (e.deltaY > 0 ? 1 : -1);
      canvas._winStart = clamp(canvas._winStart + shift, 0, maxDur - winDur);
      canvas._winEnd   = canvas._winStart + winDur;
    }

    drawWaveform(canvas, seg, false);
  }, { passive: false });
}

// ── Waveform: RAF drag loop ────────────────────────────────────────────────
function dragTick() {
  if (!dragState) { dragRafId = null; return; }

  const { canvas, seg, card, mode } = dragState;
  const W      = canvas.offsetWidth;
  const maxDur = audioBuffer?.duration ?? Infinity;
  const winDur = canvas._winEnd - canvas._winStart;
  const rect   = canvas.getBoundingClientRect();
  const mouseX = dragState.lastClientX - rect.left;

  if (mode === 'pan') {
    const dx = dragState.lastClientX - dragState.startClientX;
    const dt = (dx / W) * winDur;
    const newStart = clamp(dragState.startWinStart - dt, 0, maxDur - winDur);
    canvas._winStart = newStart;
    canvas._winEnd   = newStart + winDur;
    drawWaveform(canvas, seg, false);
  } else {
    // Marker drag with auto-pan at edges
    if (mouseX > W - EDGE_PX && canvas._winEnd < maxDur) {
      const d = Math.min(PAN_SPD, maxDur - canvas._winEnd);
      canvas._winStart += d;
      canvas._winEnd   += d;
    } else if (mouseX < EDGE_PX && canvas._winStart > 0) {
      const d = Math.min(PAN_SPD, canvas._winStart);
      canvas._winStart -= d;
      canvas._winEnd   -= d;
    }

    const xClamped = clamp(mouseX, 0, W);
    const t = canvas._winStart + (xClamped / W) * (canvas._winEnd - canvas._winStart);

    if (dragState.field === 'start') {
      seg.start = round1(clamp(t, canvas._winStart, seg.end - 0.1));
    } else {
      seg.end = round1(clamp(t, seg.start + 0.1, Math.min(canvas._winEnd, maxDur)));
    }

    drawWaveform(canvas, seg, false);
    updateTimestampDisplay(card, seg);
    markDirty();
  }

  dragRafId = requestAnimationFrame(dragTick);
}

// Global mouse tracking for drag
window.addEventListener('mousemove', (e) => {
  if (dragState) dragState.lastClientX = e.clientX;
});

window.addEventListener('mouseup', () => {
  if (dragState) {
    dragState.canvas.style.cursor = 'grab';
    dragState = null;
    // RAF self-cancels on next tick
  }
});

// ── Timestamp display ──────────────────────────────────────────────────────
function updateTimestampDisplay(card, seg) {
  const s = card.querySelector('.ts-val[data-field="start"]');
  const e = card.querySelector('.ts-val[data-field="end"]');
  const d = card.querySelector('.ts-dur');
  if (s && !s.querySelector('input')) s.textContent = fmtTime(seg.start);
  if (e && !e.querySelector('input')) e.textContent = fmtTime(seg.end);
  if (d) d.textContent = fmtDur(seg.end - seg.start);
}

function makeTimestampEditable(span, seg, field, card) {
  if (span.querySelector('input')) return;
  const input = document.createElement('input');
  input.type = 'number'; input.step = '0.01'; input.min = '0';
  input.value = (field === 'start' ? seg.start : seg.end).toFixed(2);
  input.className = 'ts-input';
  span.textContent = '';
  span.appendChild(input);
  input.focus(); input.select();

  function commit() {
    const val = parseFloat(input.value);
    if (!isNaN(val)) {
      const maxDur = audioBuffer?.duration ?? Infinity;
      if (field === 'start') seg.start = clamp(round1(val), 0, seg.end - 0.1);
      else                   seg.end   = clamp(round1(val), seg.start + 0.1, maxDur);
      markDirty();
    }
    updateTimestampDisplay(card, seg);
    const canvas = card.querySelector('.seg-waveform');
    if (canvas) drawWaveform(canvas, seg, true); // re-centre window on new range
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.blur(); }
  });
}

function updateExportButton() {
  const total = state.currentProject?.segments.length ?? 0;
  const sel   = selectedIds.size;
  btnExport.disabled    = sel === 0;
  btnExport.textContent = (sel === total || sel === 0) ? 'Export ZIP' : `Export ZIP (${sel}/${total})`;
}

// ── Playback ───────────────────────────────────────────────────────────────
let activeCard = null, activeBtn = null, segEndTimer = null;

function playSegment(seg, card, btn) {
  if (activeCard) {
    activeCard.classList.remove('playing');
    if (activeBtn) { activeBtn.textContent = '▶'; activeBtn.classList.remove('active'); }
  }
  clearTimeout(segEndTimer);

  if (activeCard === card) {
    audioPlayer.pause();
    activeCard = null; activeBtn = null;
    return;
  }

  activeCard = card; activeBtn = btn;
  card.classList.add('playing');
  btn.textContent = '■'; btn.classList.add('active');
  audioPlayer.currentTime = seg.start;
  audioPlayer.play();

  segEndTimer = setTimeout(() => {
    audioPlayer.pause();
    card.classList.remove('playing');
    btn.textContent = '▶'; btn.classList.remove('active');
    activeCard = null; activeBtn = null;
  }, (seg.end - seg.start) * 1000 + 200);
}

audioPlayer.addEventListener('pause', () => {
  clearTimeout(segEndTimer);
  if (activeCard) {
    activeCard.classList.remove('playing');
    if (activeBtn) { activeBtn.textContent = '▶'; activeBtn.classList.remove('active'); }
    activeCard = null; activeBtn = null;
  }
});

// ── Save ───────────────────────────────────────────────────────────────────
function markDirty() {
  state.dirty = true;
  btnSave.textContent = 'Save *';
}

async function saveProject() {
  if (!state.currentProject || !state.dirty) return;
  try {
    const res = await fetch(`${API}/project/${state.currentProject.id}/segments`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segments: state.currentProject.segments }),
    });
    if (!res.ok) throw new Error();
    state.currentProject = await res.json();
    state.dirty = false;
    btnSave.textContent = 'Save';
    showToast('Saved', 'success');
  } catch { showToast('Save failed', 'error'); }
}

btnSave.addEventListener('click', saveProject);

// ── Export ─────────────────────────────────────────────────────────────────
btnExport.addEventListener('click', async () => {
  if (!state.currentProject || selectedIds.size === 0) return;
  btnExport.disabled = true;
  btnExport.textContent = 'Exporting…';
  try {
    const ids = [...selectedIds];
    const res = await fetch(`${API}/export/${state.currentProject.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segment_ids: ids }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || 'Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${state.currentProject.audio_file}_export.zip`;
    a.click(); URL.revokeObjectURL(url);
    showToast(`Exported ${ids.length} clip${ids.length !== 1 ? 's' : ''}`, 'success');
  } catch (e) {
    showToast(e.message || 'Export failed', 'error');
  } finally {
    btnExport.disabled = false;
    updateExportButton();
  }
});

// ── Upload ─────────────────────────────────────────────────────────────────
btnNew.addEventListener('click', () => { state.currentProject = null; showScreen('upload'); });
dropArea.addEventListener('click', () => fileInput.click());
dropArea.addEventListener('dragover',  e => { e.preventDefault(); dropArea.classList.add('drag-over'); });
dropArea.addEventListener('dragleave', () => dropArea.classList.remove('drag-over'));
dropArea.addEventListener('drop', e => {
  e.preventDefault(); dropArea.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) uploadFile(fileInput.files[0]); });

async function uploadFile(file) {
  showScreen('processing');
  processingMsg.textContent = `Uploading "${file.name}"…`;

  const lang      = document.getElementById('lang-select')?.value || '';
  const langLabel = document.getElementById('lang-select')?.selectedOptions[0]?.text || '';
  const form = new FormData();
  form.append('file', file);
  if (lang) form.append('language', lang);

  try {
    const res = await fetch(`${API}/upload`, { method: 'POST', body: form });
    if (!res.ok) throw new Error((await res.json()).detail || 'Upload failed');
    const { job_id } = await res.json();
    await pollJob(job_id, file.name, langLabel);
  } catch (e) {
    showToast(e.message || 'Upload failed', 'error');
    showScreen('upload');
  }
}

async function pollJob(jobId, filename, langLabel) {
  const langSuffix = langLabel ? ` · ${langLabel}` : '';

  while (true) {
    await new Promise(r => setTimeout(r, 1500));

    let job;
    try {
      const res = await fetch(`${API}/job/${jobId}`);
      if (!res.ok) throw new Error('Lost connection to server');
      job = await res.json();
    } catch (e) {
      showToast(e.message, 'error');
      showScreen('upload');
      return;
    }

    if (job.status === 'done') {
      const project = await fetch(`${API}/project/${job.project_id}`).then(r => r.json());
      setCurrentProject(project);
      showToast(`Transcribed ${project.segments.length} segments`, 'success');
      return;
    }

    if (job.status === 'error') {
      showToast(job.error || 'Transcription failed', 'error');
      showScreen('upload');
      return;
    }

    // pending or transcribing — show live progress
    const n = job.segments_found || 0;
    if (job.status === 'pending') {
      processingMsg.textContent = `Loading model${langSuffix}… (first run downloads ~3 GB)`;
    } else if (n === 0) {
      processingMsg.textContent = `Transcribing "${filename}"${langSuffix}…`;
    } else {
      processingMsg.textContent = `Transcribing "${filename}"${langSuffix} — ${n} segment${n !== 1 ? 's' : ''} so far`;
    }
  }
}

// ── Keyboard ───────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveProject(); }
});

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(2).padStart(5, '0')}`;
}
function fmtDur(s) {
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function round1(n) { return Math.round(n * 10) / 10; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// ── Init ───────────────────────────────────────────────────────────────────
showScreen('upload');
loadProjectList();

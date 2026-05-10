const API = 'http://localhost:8000';

// ── State ──────────────────────────────────────────────────────────────────
let state = {
  currentProject: null,
  projects: [],
  dirty: false,
};

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
  } catch {
    // server might not be up yet
  }
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

// ── Open existing project ──────────────────────────────────────────────────
async function openProject(id) {
  showScreen('processing');
  processingMsg.textContent = 'Loading project…';
  try {
    const res = await fetch(`${API}/project/${id}`);
    if (!res.ok) throw new Error('Not found');
    const project = await res.json();
    setCurrentProject(project);
  } catch (e) {
    showToast('Failed to load project', 'error');
    showScreen('upload');
  }
}

function setCurrentProject(project) {
  state.currentProject = project;
  state.dirty = false;

  playerFilename.textContent = project.audio_file;
  playerLang.textContent = project.language || 'unknown';

  audioPlayer.src = `${API}/audio/${project.id}`;
  audioPlayer.load();

  renderSegments(project.segments);
  showScreen('editor');
  loadProjectList();
}

// ── Segment rendering ──────────────────────────────────────────────────────
function renderSegments(segments) {
  segCountLabel.textContent = `${segments.length} Segments`;
  segmentList.innerHTML = '';

  for (const seg of segments) {
    const card = document.createElement('div');
    card.className = 'segment-card';
    card.dataset.id = seg.id;

    card.innerHTML = `
      <div class="seg-num">${seg.id}</div>
      <div class="seg-body">
        <textarea class="seg-text" rows="2">${escHtml(seg.text)}</textarea>
        <div class="seg-timestamps">${fmtTime(seg.start)} → ${fmtTime(seg.end)} &nbsp;(${fmtDur(seg.end - seg.start)})</div>
      </div>
      <div class="seg-actions">
        <button class="btn-icon btn-play" title="Play segment">▶</button>
      </div>
    `;

    const textarea = card.querySelector('.seg-text');
    textarea.addEventListener('input', () => markDirty());
    textarea.addEventListener('change', () => {
      seg.text = textarea.value;
    });

    const playBtn = card.querySelector('.btn-play');
    playBtn.addEventListener('click', () => playSegment(seg, card, playBtn));

    segmentList.appendChild(card);
  }
}

// ── Playback ───────────────────────────────────────────────────────────────
let activeCard = null;
let activeBtn  = null;
let segEndTimer = null;

function playSegment(seg, card, btn) {
  if (activeCard) {
    activeCard.classList.remove('playing');
    if (activeBtn) { activeBtn.textContent = '▶'; activeBtn.classList.remove('active'); }
  }
  clearTimeout(segEndTimer);

  if (activeCard === card) {
    audioPlayer.pause();
    activeCard = null;
    activeBtn  = null;
    return;
  }

  activeCard = card;
  activeBtn  = btn;
  card.classList.add('playing');
  btn.textContent = '■';
  btn.classList.add('active');

  audioPlayer.currentTime = seg.start;
  audioPlayer.play();

  const duration = (seg.end - seg.start) * 1000;
  segEndTimer = setTimeout(() => {
    audioPlayer.pause();
    card.classList.remove('playing');
    btn.textContent = '▶';
    btn.classList.remove('active');
    activeCard = null;
    activeBtn  = null;
  }, duration + 200);
}

audioPlayer.addEventListener('pause', () => {
  clearTimeout(segEndTimer);
  if (activeCard) {
    activeCard.classList.remove('playing');
    if (activeBtn) { activeBtn.textContent = '▶'; activeBtn.classList.remove('active'); }
    activeCard = null;
    activeBtn  = null;
  }
});

// ── Save ───────────────────────────────────────────────────────────────────
function markDirty() {
  state.dirty = true;
  btnSave.textContent = 'Save *';
}

async function saveProject() {
  if (!state.currentProject || !state.dirty) return;

  // Collect current segment texts from textareas
  const cards = segmentList.querySelectorAll('.segment-card');
  const segments = state.currentProject.segments.map((seg, i) => {
    const ta = cards[i]?.querySelector('.seg-text');
    return { ...seg, text: ta ? ta.value : seg.text };
  });

  try {
    const res = await fetch(`${API}/project/${state.currentProject.id}/segments`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segments }),
    });
    if (!res.ok) throw new Error();
    const updated = await res.json();
    state.currentProject = updated;
    state.dirty = false;
    btnSave.textContent = 'Save';
    showToast('Saved', 'success');
  } catch {
    showToast('Save failed', 'error');
  }
}

btnSave.addEventListener('click', saveProject);

// ── Export ─────────────────────────────────────────────────────────────────
btnExport.addEventListener('click', async () => {
  if (!state.currentProject) return;
  btnExport.disabled = true;
  btnExport.textContent = 'Exporting…';
  try {
    const res = await fetch(`${API}/export/${state.currentProject.id}`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).detail || 'Export failed');
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${state.currentProject.audio_file}_export.zip`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Export downloaded', 'success');
  } catch (e) {
    showToast(e.message || 'Export failed', 'error');
  } finally {
    btnExport.disabled = false;
    btnExport.textContent = 'Export ZIP';
  }
});

// ── Upload ─────────────────────────────────────────────────────────────────
btnNew.addEventListener('click', () => {
  state.currentProject = null;
  showScreen('upload');
});

dropArea.addEventListener('click', () => fileInput.click());

dropArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropArea.classList.add('drag-over');
});

dropArea.addEventListener('dragleave', () => dropArea.classList.remove('drag-over'));

dropArea.addEventListener('drop', (e) => {
  e.preventDefault();
  dropArea.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) uploadFile(fileInput.files[0]);
});

async function uploadFile(file) {
  showScreen('processing');
  processingMsg.textContent = `Transcribing "${file.name}"…`;

  const form = new FormData();
  form.append('file', file);

  try {
    const res = await fetch(`${API}/upload`, { method: 'POST', body: form });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Upload failed');
    }
    const project = await res.json();
    setCurrentProject(project);
    showToast(`Transcribed ${project.segments.length} segments`, 'success');
  } catch (e) {
    showToast(e.message || 'Upload failed', 'error');
    showScreen('upload');
  }
}

// ── Keyboard shortcuts ─────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveProject();
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────
function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${m}:${sec}`;
}

function fmtDur(s) {
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ───────────────────────────────────────────────────────────────────
showScreen('upload');
loadProjectList();

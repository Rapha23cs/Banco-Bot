// ==========================================================================
// EcoSync Bot • SGA 360° • Lógica do Frontend (Renderer Seguro)
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  const state = {
    currentUser: null,
    appInfo: null,
    availableUpdate: null,
    updateDownloaded: false,
    updateCheckedOnLogin: false,
    activeDirection: 'push',
    isSyncRunning: false,
    statusData: null,
    insightsData: null,
    diffData: null,
    backupsData: null,
    activeBackupPreview: null,
    auditLogs: [],
    schedulerConfig: null,
    overviewFilter: 'all',
    diffFilter: 'all',
    insightsSource: 'local',
    selectedTables: new Set(),
    latencyHistory: [],
    autoRefreshTimer: null,
    countdownTimer: null,
    pagination: {
      overview: { page: 1, pageSize: 8 },
      diff: { page: 1, pageSize: 10 },
      insights: { page: 1, pageSize: 10 },
      backupsProd: { page: 1, pageSize: 5 },
      backupsLocal: { page: 1, pageSize: 5 },
      audit: { page: 1, pageSize: 8 }
    }
  };

  // ------------------------------------------------------------------------
  // Utilitários Seguros (Toast & DOM Helpers - Sem innerHTML dinâmico)
  // ------------------------------------------------------------------------
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const textEl = document.createElement('div');
    textEl.textContent = message;
    textEl.style.flex = '1';

    toast.appendChild(textEl);
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(16px)';
      toast.style.transition = 'all 0.2s ease';
      setTimeout(() => toast.remove(), 220);
    }, 3800);
  }

  function createBadge(text, variant) {
    const span = document.createElement('span');
    span.className = `badge badge-${variant}`;
    span.textContent = text;
    return span;
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function formatTime(isoStr) {
    try {
      return new Date(isoStr).toLocaleString('pt-BR');
    } catch {
      return isoStr || '--';
    }
  }

  function clearElement(el) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // ------------------------------------------------------------------------
  // Componente Genérico de Paginação
  // ------------------------------------------------------------------------
  function renderPagination({ totalItems, page, pageSize, containerEl, onPageChange, onPageSizeChange }) {
    if (!containerEl) return;
    clearElement(containerEl);

    if (totalItems === 0) {
      const emptyInfo = document.createElement('div');
      emptyInfo.className = 'pagination-info';
      emptyInfo.textContent = '0 registros encontrados';
      containerEl.appendChild(emptyInfo);
      return;
    }

    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const startIdx = (safePage - 1) * pageSize + 1;
    const endIdx = Math.min(totalItems, safePage * pageSize);

    const info = document.createElement('div');
    info.className = 'pagination-info';

    const spanText = document.createElement('span');
    spanText.className = 'tabular';
    spanText.textContent = `Exibindo ${startIdx}–${endIdx} de ${totalItems} • Página ${safePage}/${totalPages}`;

    const sizeSelect = document.createElement('select');
    sizeSelect.className = 'page-size-select';
    sizeSelect.title = 'Itens por página';
    [5, 8, 10, 20, 50].forEach((sz) => {
      const opt = document.createElement('option');
      opt.value = String(sz);
      opt.textContent = `${sz}/pág`;
      if (sz === pageSize) opt.selected = true;
      sizeSelect.appendChild(opt);
    });
    sizeSelect.addEventListener('change', () => {
      onPageSizeChange(parseInt(sizeSelect.value, 10));
    });

    info.append(spanText, sizeSelect);

    const controls = document.createElement('div');
    controls.className = 'pagination-controls';

    const btnPrev = document.createElement('button');
    btnPrev.className = 'page-btn';
    btnPrev.textContent = '‹ Anterior';
    btnPrev.disabled = safePage <= 1;
    btnPrev.addEventListener('click', () => onPageChange(safePage - 1));
    controls.appendChild(btnPrev);

    const maxButtons = 5;
    let firstPage = Math.max(1, safePage - Math.floor(maxButtons / 2));
    let lastPage = Math.min(totalPages, firstPage + maxButtons - 1);
    if (lastPage - firstPage + 1 < maxButtons) {
      firstPage = Math.max(1, lastPage - maxButtons + 1);
    }

    for (let p = firstPage; p <= lastPage; p++) {
      const pBtn = document.createElement('button');
      pBtn.className = `page-btn${p === safePage ? ' active' : ''}`;
      pBtn.textContent = String(p);
      pBtn.addEventListener('click', () => onPageChange(p));
      controls.appendChild(pBtn);
    }

    const btnNext = document.createElement('button');
    btnNext.className = 'page-btn';
    btnNext.textContent = 'Próxima ›';
    btnNext.disabled = safePage >= totalPages;
    btnNext.addEventListener('click', () => onPageChange(safePage + 1));
    controls.appendChild(btnNext);

    containerEl.append(info, controls);
  }

  function paginateSlice(items, pagState) {
    const totalPages = Math.max(1, Math.ceil(items.length / pagState.pageSize));
    if (pagState.page > totalPages) pagState.page = totalPages;
    if (pagState.page < 1) pagState.page = 1;
    const start = (pagState.page - 1) * pagState.pageSize;
    return items.slice(start, start + pagState.pageSize);
  }

  // ------------------------------------------------------------------------
  // 1. Controles de Janela & Estado do EcoSync Bot
  // ------------------------------------------------------------------------
  const btnMin = document.getElementById('btn-minimize');
  const btnMax = document.getElementById('btn-maximize');
  const btnClose = document.getElementById('btn-close');

  if (window.api) {
    btnMin?.addEventListener('click', () => window.api.minimize());
    btnMax?.addEventListener('click', () => window.api.maximize());
    btnClose?.addEventListener('click', () => window.api.close());
  }

  function updateBotMood() {
    const moodEl = document.getElementById('bot-mood-badge');
    if (!moodEl) return;

    if (state.isSyncRunning) {
      moodEl.className = 'bot-mood-badge busy';
      moodEl.textContent = 'Sincronizando...';
      return;
    }

    if (!state.statusData) {
      moodEl.className = 'bot-mood-badge';
      moodEl.textContent = 'Iniciando...';
      return;
    }

    const localOnline = state.statusData.local?.online;
    const prodOnline = state.statusData.prod?.online;
    if (!localOnline || !prodOnline) {
      moodEl.className = 'bot-mood-badge offline';
      moodEl.textContent = 'Offline';
      return;
    }

    const localMap = new Map((state.statusData.local.tables || []).map((t) => [t.name, t.rows]));
    const prodMap = new Map((state.statusData.prod.tables || []).map((t) => [t.name, t.rows]));
    const allNames = new Set([...localMap.keys(), ...prodMap.keys()]);
    let diffCount = 0;
    allNames.forEach((n) => {
      if (localMap.get(n) !== prodMap.get(n)) diffCount++;
    });

    const hasLocks =
      (state.insightsData?.local?.waiting_locks || 0) > 0 ||
      (state.insightsData?.prod?.waiting_locks || 0) > 0;

    if (diffCount > 0 || hasLocks) {
      moodEl.className = 'bot-mood-badge warn';
      moodEl.textContent = 'Atenção';
      return;
    }

    moodEl.className = 'bot-mood-badge';
    moodEl.textContent = state.schedulerConfig?.enabled ? 'Piloto Ativo' : 'Vigilante';
  }

  // ------------------------------------------------------------------------
  // 2. Navegação entre Abas
  // ------------------------------------------------------------------------
  const navItems = document.querySelectorAll('.nav-item[data-tab]');
  const tabPanes = document.querySelectorAll('.tab-pane');

  function switchTab(tabId) {
    navItems.forEach((item) => {
      item.classList.toggle('active', item.getAttribute('data-tab') === tabId);
    });
    tabPanes.forEach((pane) => {
      pane.classList.toggle('active', pane.id === tabId);
    });

    if (tabId === 'tab-diff' && !state.diffData) {
      loadDiff(state.activeDirection);
    } else if (tabId === 'tab-insights') {
      loadInsights(false);
    } else if (tabId === 'tab-scheduler') {
      loadScheduler();
    } else if (tabId === 'tab-backups') {
      loadBackups();
      loadAuditLogs();
    } else if (tabId === 'tab-settings') {
      loadSettings();
    }
  }

  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      switchTab(item.getAttribute('data-tab'));
    });
  });

  // ------------------------------------------------------------------------
  // 3. Diagnóstico, Gráficos Nativos & Dashboard em Tempo Real
  // ------------------------------------------------------------------------
  async function loadStatus(silent = false) {
    if (!window.api) return;

    const btnRefresh = document.getElementById('btn-refresh-status');
    if (btnRefresh && !silent) {
      btnRefresh.disabled = true;
      btnRefresh.textContent = 'Verificando...';
    }

    try {
      const res = await window.api.getStatus();
      if (!res || !res.success) {
        if (!silent) showToast('Falha ao obter status dos bancos.', 'error');
        return;
      }

      state.statusData = res;
      const nowStr = new Date().toLocaleTimeString('pt-BR');
      setText('label-last-checked', `Atualizado: ${nowStr}`);

      state.latencyHistory.push({
        local: res.local.online ? res.local.latency_ms : null,
        prod: res.prod.online ? res.prod.latency_ms : null
      });
      if (state.latencyHistory.length > 20) state.latencyHistory.shift();

      updateConnectionPill('pill-local', 'pill-local-latency', res.local);
      updateConnectionPill('pill-prod', 'pill-prod-latency', res.prod);
      updateTopologyAndMetrics(res);
      renderLatencySparkline();
      renderTopTablesChart();
      renderOverviewTable();
      renderSyncTableChips();
      loadBackupsSummary();
      updateBotMood();

      // Atualiza Smart Advisor sem bloquear a renderização principal
      loadInsights(true);
    } catch (err) {
      if (!silent) showToast('Erro ao consultar bancos: ' + err.message, 'error');
    } finally {
      if (btnRefresh && !silent) {
        btnRefresh.disabled = false;
        btnRefresh.textContent = 'Atualizar Status';
      }
    }
  }

  function updateConnectionPill(pillId, latencyId, dbStats) {
    const pill = document.getElementById(pillId);
    const lat = document.getElementById(latencyId);
    if (!pill || !lat) return;

    if (dbStats.online) {
      pill.className = 'status-pill online';
      lat.textContent = `${dbStats.latency_ms}ms`;
    } else {
      pill.className = 'status-pill offline';
      lat.textContent = 'Offline';
    }
  }

  function updateTopologyAndMetrics(res) {
    const localOnline = res.local.online;
    const prodOnline = res.prod.online;

    const topoLocalBadge = document.getElementById('topo-local-badge');
    const topoProdBadge = document.getElementById('topo-prod-badge');

    if (topoLocalBadge) {
      topoLocalBadge.className = `badge ${localOnline ? 'badge-green' : 'badge-red'}`;
      topoLocalBadge.textContent = localOnline ? `Online • ${res.local.latency_ms}ms` : 'Offline';
    }
    if (topoProdBadge) {
      topoProdBadge.className = `badge ${prodOnline ? 'badge-green' : 'badge-red'}`;
      topoProdBadge.textContent = prodOnline ? `Online • ${res.prod.latency_ms}ms` : 'Offline';
    }
    setText('topo-local-url', res.local.url_masked || 'Não configurado');
    setText('topo-prod-url', res.prod.url_masked || 'Não configurado');
    setText('topo-local-ver', localOnline ? (res.local.version || 'PostgreSQL') : (res.local.error || 'Sem conexão'));
    setText('topo-prod-ver', prodOnline ? (res.prod.version || 'PostgreSQL') : (res.prod.error || 'Sem conexão'));

    setText('dash-local-rows', localOnline ? res.local.total_rows.toLocaleString('pt-BR') : '--');
    setText('dash-local-tables', `${res.local.tables_count} tabelas`);
    setText('dash-local-ping', localOnline ? `${res.local.latency_ms}ms` : 'Offline');
    setText('dash-local-size', localOnline && res.local.db_size_mb != null ? `${res.local.db_size_mb} MB` : '-- MB');

    setText('dash-prod-rows', prodOnline ? res.prod.total_rows.toLocaleString('pt-BR') : '--');
    setText('dash-prod-tables', `${res.prod.tables_count} tabelas`);
    setText('dash-prod-ping', prodOnline ? `${res.prod.latency_ms}ms` : 'Offline');
    setText('dash-prod-size', prodOnline && res.prod.db_size_mb != null ? `${res.prod.db_size_mb} MB` : '-- MB');

    const badgeLocal = document.getElementById('badge-local-status');
    const badgeProd = document.getElementById('badge-prod-status');
    if (badgeLocal) {
      badgeLocal.className = `badge ${localOnline ? 'badge-green' : 'badge-red'}`;
      badgeLocal.textContent = localOnline ? 'Online' : 'Offline';
    }
    if (badgeProd) {
      badgeProd.className = `badge ${prodOnline ? 'badge-green' : 'badge-red'}`;
      badgeProd.textContent = prodOnline ? 'Online' : 'Offline';
    }

    const localMap = new Map((res.local.tables || []).map((t) => [t.name, t.rows]));
    const prodMap = new Map((res.prod.tables || []).map((t) => [t.name, t.rows]));
    const allNames = new Set([...localMap.keys(), ...prodMap.keys()]);

    let divergentCount = 0;
    allNames.forEach((name) => {
      if (localMap.get(name) !== prodMap.get(name)) divergentCount++;
    });

    const topoCard = document.getElementById('topology-card');
    const bridgeBadge = document.getElementById('bridge-badge');
    const bridgeBeam = document.getElementById('bridge-beam');
    const bridgeText = document.getElementById('bridge-status-text');
    const badgeIntegrity = document.getElementById('badge-integrity-status');
    const dashDivergent = document.getElementById('dash-divergent-count');
    const dashIntegritySub = document.getElementById('dash-integrity-sub');
    const navDiffBadge = document.getElementById('nav-diff-badge');

    const bothOnline = localOnline && prodOnline;

    if (!bothOnline) {
      topoCard?.classList.remove('state-warn');
      topoCard?.classList.add('state-error');
      if (bridgeBadge) {
        bridgeBadge.className = 'badge badge-red';
        bridgeBadge.textContent = 'Rota Interrompida';
      }
      bridgeBeam?.classList.add('offline');
      if (bridgeText) bridgeText.textContent = 'Verifique rede, VPN ou serviço PostgreSQL';
      if (badgeIntegrity) {
        badgeIntegrity.className = 'badge badge-red';
        badgeIntegrity.textContent = 'Indisponível';
      }
      if (dashDivergent) dashDivergent.textContent = '--';
      if (dashIntegritySub) dashIntegritySub.textContent = 'Aguardando reconexão';
    } else if (divergentCount > 0) {
      topoCard?.classList.remove('state-error');
      topoCard?.classList.add('state-warn');
      if (bridgeBadge) {
        bridgeBadge.className = 'badge badge-amber';
        bridgeBadge.textContent = `${divergentCount} tabela(s) diferente(s)`;
      }
      bridgeBeam?.classList.remove('offline');
      if (bridgeText) bridgeText.textContent = 'Diferença detectada na contagem';
      if (badgeIntegrity) {
        badgeIntegrity.className = 'badge badge-amber';
        badgeIntegrity.textContent = 'Pendente';
      }
      if (dashDivergent) dashDivergent.textContent = String(divergentCount);
      if (dashIntegritySub) dashIntegritySub.textContent = `${allNames.size - divergentCount}/${allNames.size} tabelas alinhadas`;
      if (navDiffBadge) {
        navDiffBadge.textContent = String(divergentCount);
        navDiffBadge.classList.add('visible');
      }
    } else {
      topoCard?.classList.remove('state-error', 'state-warn');
      if (bridgeBadge) {
        bridgeBadge.className = 'badge badge-green';
        bridgeBadge.textContent = 'Sincronizado (100%)';
      }
      bridgeBeam?.classList.remove('offline');
      if (bridgeText) bridgeText.textContent = 'Conexão transacional pronta';
      if (badgeIntegrity) {
        badgeIntegrity.className = 'badge badge-green';
        badgeIntegrity.textContent = '100% OK';
      }
      if (dashDivergent) dashDivergent.textContent = '0';
      if (dashIntegritySub) dashIntegritySub.textContent = `${allNames.size}/${allNames.size} tabelas idênticas`;
      navDiffBadge?.classList.remove('visible');
    }

    const btnQuickPush = document.getElementById('btn-quick-push');
    const btnSyncExec = document.getElementById('btn-sync-execute');
    const btnSyncDry = document.getElementById('btn-sync-dryrun');
    const btnHeroDry = document.getElementById('hero-btn-dryrun');
    if (!state.isSyncRunning) {
      if (btnQuickPush) btnQuickPush.disabled = !bothOnline;
      if (btnSyncExec) btnSyncExec.disabled = !bothOnline;
      if (btnSyncDry) btnSyncDry.disabled = !bothOnline;
      if (btnHeroDry) btnHeroDry.disabled = !bothOnline;
    }
  }

  function renderLatencySparkline() {
    const svg = document.getElementById('sparkline-svg');
    if (!svg) return;
    clearElement(svg);

    const pts = state.latencyHistory;
    if (pts.length === 0) return;

    const latest = pts[pts.length - 1];
    setText('sparkline-local-latest', latest.local != null ? `${latest.local}ms` : 'Offline');
    setText('sparkline-prod-latest', latest.prod != null ? `${latest.prod}ms` : 'Offline');

    const w = 320;
    const h = 90;
    const padY = 10;
    const vals = [];
    pts.forEach((p) => {
      if (p.local != null) vals.push(p.local);
      if (p.prod != null) vals.push(p.prod);
    });
    const maxVal = Math.max(10, ...vals);

    const ns = 'http://www.w3.org/2000/svg';
    // Linha de referência horizontal
    const gridLine = document.createElementNS(ns, 'line');
    gridLine.setAttribute('x1', '0');
    gridLine.setAttribute('y1', String(h / 2));
    gridLine.setAttribute('x2', String(w));
    gridLine.setAttribute('y2', String(h / 2));
    gridLine.setAttribute('stroke', 'rgba(255,255,255,0.06)');
    gridLine.setAttribute('stroke-dasharray', '4 4');
    svg.appendChild(gridLine);

    const buildLine = (key, color) => {
      const coords = [];
      pts.forEach((p, idx) => {
        if (p[key] == null) return;
        const x = pts.length === 1 ? w / 2 : (idx / (pts.length - 1)) * (w - 16) + 8;
        const norm = p[key] / maxVal;
        const y = h - padY - norm * (h - padY * 2);
        coords.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      });
      if (coords.length === 1) {
        const [cx, cy] = coords[0].split(',');
        const c = document.createElementNS(ns, 'circle');
        c.setAttribute('cx', cx);
        c.setAttribute('cy', cy);
        c.setAttribute('r', '3.5');
        c.setAttribute('fill', color);
        svg.appendChild(c);
      } else if (coords.length > 1) {
        const poly = document.createElementNS(ns, 'polyline');
        poly.setAttribute('fill', 'none');
        poly.setAttribute('stroke', color);
        poly.setAttribute('stroke-width', '2.2');
        poly.setAttribute('stroke-linecap', 'round');
        poly.setAttribute('stroke-linejoin', 'round');
        poly.setAttribute('points', coords.join(' '));
        svg.appendChild(poly);
      }
    };

    buildLine('local', '#60a5fa');
    buildLine('prod', '#34d399');
  }

  function renderTopTablesChart() {
    const container = document.getElementById('top-tables-chart');
    if (!container || !state.statusData) return;
    clearElement(container);

    const tables = state.statusData.local?.online
      ? state.statusData.local.tables
      : state.statusData.prod?.tables || [];

    const top = [...tables]
      .sort((a, b) => (b.rows || 0) - (a.rows || 0))
      .slice(0, 6);

    if (top.length === 0) {
      const empty = document.createElement('div');
      empty.style.fontSize = '12px';
      empty.style.color = 'var(--text-dim)';
      empty.textContent = 'Sem dados de tabelas disponíveis.';
      container.appendChild(empty);
      return;
    }

    const maxRows = Math.max(1, top[0].rows || 1);
    top.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'bar-row';

      const head = document.createElement('div');
      head.className = 'bar-row-head';

      const nameEl = document.createElement('span');
      nameEl.style.fontFamily = 'var(--font-mono)';
      nameEl.textContent = t.name;

      const countEl = document.createElement('span');
      countEl.className = 'tabular';
      countEl.style.color = 'var(--text-muted)';
      countEl.textContent = `${(t.rows || 0).toLocaleString('pt-BR')} reg.`;

      head.append(nameEl, countEl);

      const track = document.createElement('div');
      track.className = 'bar-track';

      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      fill.style.width = `${Math.max(4, Math.round(((t.rows || 0) / maxRows) * 100))}%`;
      track.appendChild(fill);

      row.append(head, track);
      container.appendChild(row);
    });
  }

  function renderOverviewTable() {
    const tbody = document.getElementById('tbody-overview');
    const pagEl = document.getElementById('pagination-overview');
    if (!tbody || !state.statusData) return;

    const localTables = state.statusData.local.tables || [];
    const prodTables = state.statusData.prod.tables || [];
    const localMap = new Map(localTables.map((t) => [t.name, t.rows]));
    const prodMap = new Map(prodTables.map((t) => [t.name, t.rows]));
    const allNames = Array.from(new Set([...localMap.keys(), ...prodMap.keys()])).sort();

    const searchTerm = (document.getElementById('input-search-tables')?.value || '').toLowerCase().trim();

    const filtered = allNames.filter((name) => {
      const lRows = localMap.has(name) ? localMap.get(name) : null;
      const pRows = prodMap.has(name) ? prodMap.get(name) : null;
      const isMatch = lRows !== null && pRows !== null && lRows === pRows;
      if (state.overviewFilter === 'match' && !isMatch) return false;
      if (state.overviewFilter === 'diff' && isMatch) return false;
      if (searchTerm && !name.toLowerCase().includes(searchTerm)) return false;
      return true;
    });

    const pageItems = paginateSlice(filtered, state.pagination.overview);
    clearElement(tbody);

    if (filtered.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.style.textAlign = 'center';
      td.style.padding = '20px';
      td.style.color = 'var(--text-dim)';
      td.textContent = 'Nenhuma tabela encontrada para o filtro atual.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      pageItems.forEach((name) => {
        const lRows = localMap.has(name) ? localMap.get(name) : null;
        const pRows = prodMap.has(name) ? prodMap.get(name) : null;
        const isMatch = lRows !== null && pRows !== null && lRows === pRows;

        const tr = document.createElement('tr');
        tr.className = 'clickable-row';
        tr.title = `Clique para inspecionar colunas e índices de ${name}`;
        tr.addEventListener('click', () => openSchemaModal(name));

        const tdName = document.createElement('td');
        tdName.style.fontWeight = '600';
        tdName.style.color = '#f8fafc';
        tdName.textContent = name;

        const tdLocal = document.createElement('td');
        tdLocal.style.textAlign = 'right';
        tdLocal.style.fontFamily = 'var(--font-mono)';
        tdLocal.className = 'tabular';
        tdLocal.textContent = lRows !== null ? lRows.toLocaleString('pt-BR') : 'Ausente';

        const tdProd = document.createElement('td');
        tdProd.style.textAlign = 'right';
        tdProd.style.fontFamily = 'var(--font-mono)';
        tdProd.className = 'tabular';
        tdProd.textContent = pRows !== null ? pRows.toLocaleString('pt-BR') : 'Ausente';

        const tdDelta = document.createElement('td');
        tdDelta.style.textAlign = 'right';
        tdDelta.style.fontFamily = 'var(--font-mono)';
        tdDelta.className = 'tabular';
        if (lRows !== null && pRows !== null) {
          const delta = lRows - pRows;
          tdDelta.textContent = delta === 0 ? '0' : (delta > 0 ? `+${delta}` : String(delta));
          tdDelta.style.color = delta === 0 ? 'var(--text-dim)' : 'var(--accent-amber)';
        } else {
          tdDelta.textContent = 'Schema';
          tdDelta.style.color = 'var(--accent-amber)';
        }

        const tdStatus = document.createElement('td');
        tdStatus.style.textAlign = 'center';
        tdStatus.appendChild(createBadge(isMatch ? '✓ Idêntico' : '≠ Divergente', isMatch ? 'green' : 'amber'));

        tr.append(tdName, tdLocal, tdProd, tdDelta, tdStatus);
        tbody.appendChild(tr);
      });
    }

    renderPagination({
      totalItems: filtered.length,
      page: state.pagination.overview.page,
      pageSize: state.pagination.overview.pageSize,
      containerEl: pagEl,
      onPageChange: (p) => {
        state.pagination.overview.page = p;
        renderOverviewTable();
      },
      onPageSizeChange: (sz) => {
        state.pagination.overview.pageSize = sz;
        state.pagination.overview.page = 1;
        renderOverviewTable();
      }
    });
  }

  document.getElementById('input-search-tables')?.addEventListener('input', () => {
    state.pagination.overview.page = 1;
    renderOverviewTable();
  });

  document.querySelectorAll('#overview-filters .filter-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#overview-filters .filter-pill').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.overviewFilter = btn.getAttribute('data-filter');
      state.pagination.overview.page = 1;
      renderOverviewTable();
    });
  });

  document.getElementById('btn-refresh-status')?.addEventListener('click', () => loadStatus(false));

  const toggleAutoRefresh = document.getElementById('toggle-auto-refresh');
  function setupAutoRefresh() {
    if (state.autoRefreshTimer) {
      clearInterval(state.autoRefreshTimer);
      state.autoRefreshTimer = null;
    }
    if (toggleAutoRefresh?.checked && state.currentUser) {
      state.autoRefreshTimer = setInterval(() => {
        if (!state.isSyncRunning && state.currentUser) loadStatus(true);
      }, 30000);
    }
  }
  toggleAutoRefresh?.addEventListener('change', setupAutoRefresh);

  // ------------------------------------------------------------------------
  // 4. EcoSync Smart Advisor & Raio-X do Banco PostgreSQL
  // ------------------------------------------------------------------------
  async function loadInsights(silent = true) {
    if (!window.api) return;

    const btnIns = document.getElementById('btn-refresh-insights');
    if (btnIns && !silent) {
      btnIns.disabled = true;
      btnIns.textContent = 'Coletando...';
    }

    try {
      const res = await window.api.getInsights();
      if (!res || !res.success) {
        if (!silent) showToast('Erro ao coletar telemetria PostgreSQL.', 'error');
        return;
      }

      state.insightsData = res;
      renderAdvisorCards(res.recommendations || []);
      renderInsightsKpis(res);
      renderInsightsTable();
      updateBotMood();
    } catch (err) {
      if (!silent) showToast('Erro de telemetria: ' + err.message, 'error');
    } finally {
      if (btnIns && !silent) {
        btnIns.disabled = false;
        btnIns.textContent = 'Atualizar Telemetria';
      }
    }
  }

  async function handleAdvisorAction(action) {
    if (action === 'push' || action === 'sync_push') {
      switchTab('tab-sync');
      setDirection('push');
      if (action === 'push') openConfirmModal('push');
    } else if (action === 'pull' || action === 'sync_pull') {
      switchTab('tab-sync');
      setDirection('pull');
      if (action === 'pull') openConfirmModal('pull');
    } else if (action === 'diff') {
      switchTab('tab-diff');
      loadDiff(state.activeDirection);
    } else if (action === 'backups') {
      switchTab('tab-backups');
    } else if (action === 'insights') {
      switchTab('tab-insights');
    } else if (action === 'settings') {
      switchTab('tab-settings');
    } else if (action === 'maintenance') {
      await triggerMaintenance();
    }
  }

  async function triggerMaintenance() {
    if (!window.api) return;
    if (state.currentUser?.perfil !== 'ADMIN') {
      showToast('Executar ANALYZE requer perfil ADMIN.', 'warning');
      return;
    }
    const btn = document.getElementById('btn-run-analyze');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Executando ANALYZE...';
    }
    try {
      const res = await window.api.runMaintenance('both');
      if (res?.success) {
        showToast('Manutenção PostgreSQL (ANALYZE) concluída com sucesso!', 'success');
        loadInsights(false);
        loadAuditLogs();
      } else {
        showToast(res?.error || 'Falha ao executar ANALYZE.', 'error');
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Executar ANALYZE';
      }
    }
  }

  document.getElementById('btn-run-analyze')?.addEventListener('click', triggerMaintenance);

  function renderAdvisorCards(recs) {
    const container = document.getElementById('advisor-list');
    if (!container) return;
    clearElement(container);

    if (recs.length === 0) {
      const card = document.createElement('div');
      card.className = 'advisor-card ok';
      const title = document.createElement('div');
      title.className = 'advisor-title';
      title.textContent = 'Ambiente operando dentro dos parâmetros';
      const desc = document.createElement('div');
      desc.className = 'advisor-desc';
      desc.textContent = 'Nenhuma anomalia ou ação pendente detectada neste momento.';
      card.append(title, desc);
      container.appendChild(card);
      return;
    }

    recs.forEach((rec) => {
      const card = document.createElement('div');
      card.className = `advisor-card ${rec.level || ''}`;

      const body = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'advisor-title';
      title.textContent = rec.title || 'Recomendação';

      const desc = document.createElement('div');
      desc.className = 'advisor-desc';
      desc.textContent = rec.desc || '';

      body.append(title, desc);
      card.appendChild(body);

      if (rec.action && rec.action_label) {
        const footer = document.createElement('div');
        const btn = document.createElement('button');
        btn.className = 'btn btn-secondary btn-sm';
        btn.textContent = rec.action_label;
        btn.addEventListener('click', () => handleAdvisorAction(rec.action));
        footer.appendChild(btn);
        card.appendChild(footer);
      }

      container.appendChild(card);
    });
  }

  function renderInsightsKpis(res) {
    const l = res.local || {};
    const p = res.prod || {};

    setText('ins-local-size', l.online ? `${l.db_size_mb} MB` : 'Offline');
    setText('ins-prod-size', p.online ? `${p.db_size_mb} MB` : 'Offline');

    setText('ins-local-cache', l.online ? `${l.cache_hit_ratio}%` : '--%');
    setText('ins-prod-cache', p.online ? `${p.cache_hit_ratio}%` : '--%');

    setText('ins-local-conns', l.online ? `${l.active_connections} / ${l.max_connections}` : '--');
    setText('ins-prod-conns', p.online ? `${p.active_connections} / ${p.max_connections}` : '--');

    setText('ins-local-locks', l.online ? String(l.waiting_locks ?? 0) : '--');
    setText('ins-prod-locks', p.online ? String(p.waiting_locks ?? 0) : '--');
  }

  function renderInsightsTable() {
    const tbody = document.getElementById('tbody-insights');
    const pagEl = document.getElementById('pagination-insights');
    if (!tbody || !state.insightsData) return;

    const srcData = state.insightsSource === 'prod' ? state.insightsData.prod : state.insightsData.local;
    const tables = srcData?.tables || [];
    const search = (document.getElementById('input-search-insights')?.value || '').toLowerCase().trim();

    const filtered = tables.filter((t) => !search || t.name.toLowerCase().includes(search));
    const pageItems = paginateSlice(filtered, state.pagination.insights);
    clearElement(tbody);

    if (filtered.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.style.textAlign = 'center';
      td.style.padding = '20px';
      td.style.color = 'var(--text-dim)';
      td.textContent = srcData?.online === false
        ? `Banco ${state.insightsSource.toUpperCase()} offline ou inacessível.`
        : 'Nenhuma tabela encontrada.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      pageItems.forEach((t) => {
        const tr = document.createElement('tr');
        tr.className = 'clickable-row';
        tr.title = `Clique para abrir o Schema Inspector de ${t.name}`;
        tr.addEventListener('click', () => openSchemaModal(t.name));

        const tdName = document.createElement('td');
        tdName.style.fontWeight = '600';
        tdName.style.color = '#f8fafc';
        tdName.textContent = t.name;

        const tdTotal = document.createElement('td');
        tdTotal.style.textAlign = 'right';
        tdTotal.style.fontFamily = 'var(--font-mono)';
        tdTotal.className = 'tabular';
        tdTotal.textContent = `${t.total_kb} KB`;

        const tdSplit = document.createElement('td');
        tdSplit.style.textAlign = 'right';
        tdSplit.style.fontFamily = 'var(--font-mono)';
        tdSplit.className = 'tabular';
        tdSplit.textContent = `${t.table_kb} / ${t.index_kb} KB`;

        const tdTuples = document.createElement('td');
        tdTuples.style.textAlign = 'right';
        tdTuples.style.fontFamily = 'var(--font-mono)';
        tdTuples.className = 'tabular';
        tdTuples.textContent = `${t.live_tuples} / ${t.dead_tuples}`;
        if (t.dead_tuples > 500) tdTuples.style.color = 'var(--accent-amber)';

        const tdScans = document.createElement('td');
        tdScans.style.textAlign = 'right';
        tdScans.style.fontFamily = 'var(--font-mono)';
        tdScans.className = 'tabular';
        tdScans.textContent = `${t.seq_scan} / ${t.idx_scan}`;

        const tdVac = document.createElement('td');
        tdVac.style.textAlign = 'center';
        tdVac.style.fontSize = '11.5px';
        tdVac.style.color = 'var(--text-muted)';
        tdVac.textContent = t.last_autovacuum ? formatTime(t.last_autovacuum) : 'Nunca';

        tr.append(tdName, tdTotal, tdSplit, tdTuples, tdScans, tdVac);
        tbody.appendChild(tr);
      });
    }

    renderPagination({
      totalItems: filtered.length,
      page: state.pagination.insights.page,
      pageSize: state.pagination.insights.pageSize,
      containerEl: pagEl,
      onPageChange: (p) => {
        state.pagination.insights.page = p;
        renderInsightsTable();
      },
      onPageSizeChange: (sz) => {
        state.pagination.insights.pageSize = sz;
        state.pagination.insights.page = 1;
        renderInsightsTable();
      }
    });
  }

  document.getElementById('btn-refresh-advisor')?.addEventListener('click', () => loadInsights(false));
  document.getElementById('btn-refresh-insights')?.addEventListener('click', () => loadInsights(false));
  document.getElementById('input-search-insights')?.addEventListener('input', () => {
    state.pagination.insights.page = 1;
    renderInsightsTable();
  });
  document.querySelectorAll('#insights-source-filters .filter-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#insights-source-filters .filter-pill').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.insightsSource = btn.getAttribute('data-source') || 'local';
      state.pagination.insights.page = 1;
      renderInsightsTable();
    });
  });

  // ------------------------------------------------------------------------
  // Schema Inspector Modal
  // ------------------------------------------------------------------------
  const schemaModal = document.getElementById('schema-modal');
  const schemaModalBody = document.getElementById('schema-modal-body');

  async function openSchemaModal(tableName) {
    if (!window.api || !tableName) return;
    setText('schema-modal-title', `Schema: ${tableName}`);
    setText('schema-modal-subtitle', 'Colunas, chaves primárias, chaves estrangeiras e índices');
    clearElement(schemaModalBody);

    const loading = document.createElement('div');
    loading.style.color = 'var(--text-muted)';
    loading.textContent = 'Consultando catálogo PostgreSQL...';
    schemaModalBody?.appendChild(loading);
    schemaModal?.classList.add('active');

    const res = await window.api.getTableSchema(tableName);
    clearElement(schemaModalBody);

    if (!res || !res.success) {
      const errDiv = document.createElement('div');
      errDiv.style.color = 'var(--accent-red)';
      errDiv.textContent = `Erro ao consultar schema: ${res?.error || 'Falha desconhecida'}`;
      schemaModalBody?.appendChild(errDiv);
      return;
    }

    const colTitle = document.createElement('div');
    colTitle.className = 'schema-section-title';
    colTitle.textContent = `Colunas (${(res.columns || []).length})`;
    schemaModalBody?.appendChild(colTitle);

    const colTable = document.createElement('table');
    colTable.className = 'custom-table';
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    ['Coluna', 'Tipo', 'PK', 'Null', 'Padrão'].forEach((lbl) => {
      const th = document.createElement('th');
      th.textContent = lbl;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    colTable.appendChild(thead);

    const tbody = document.createElement('tbody');
    (res.columns || []).forEach((col) => {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.style.fontFamily = 'var(--font-mono)';
      tdName.style.color = '#f8fafc';
      tdName.textContent = col.name;

      const tdType = document.createElement('td');
      tdType.style.fontFamily = 'var(--font-mono)';
      tdType.style.color = '#60a5fa';
      tdType.textContent = col.type;

      const tdPk = document.createElement('td');
      tdPk.textContent = col.is_pk ? 'PK' : '-';

      const tdNull = document.createElement('td');
      tdNull.textContent = col.nullable ? 'SIM' : 'NÃO';

      const tdDef = document.createElement('td');
      tdDef.style.fontFamily = 'var(--font-mono)';
      tdDef.style.fontSize = '11px';
      tdDef.textContent = col.default || '-';

      tr.append(tdName, tdType, tdPk, tdNull, tdDef);
      tbody.appendChild(tr);
    });
    colTable.appendChild(tbody);
    schemaModalBody?.appendChild(colTable);

    const fkTitle = document.createElement('div');
    fkTitle.className = 'schema-section-title';
    fkTitle.textContent = `Chaves Estrangeiras (${(res.foreign_keys || []).length})`;
    schemaModalBody?.appendChild(fkTitle);

    const fkList = document.createElement('div');
    fkList.className = 'schema-list';
    if (!res.foreign_keys || res.foreign_keys.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'schema-pill-item';
      empty.textContent = 'Nenhuma chave estrangeira.';
      fkList.appendChild(empty);
    } else {
      res.foreign_keys.forEach((fk) => {
        const item = document.createElement('div');
        item.className = 'schema-pill-item';
        item.textContent = `${fk.column}  ->  ${fk.ref_table}(${fk.ref_column})`;
        fkList.appendChild(item);
      });
    }
    schemaModalBody?.appendChild(fkList);

    const idxTitle = document.createElement('div');
    idxTitle.className = 'schema-section-title';
    idxTitle.textContent = `Índices (${(res.indexes || []).length})`;
    schemaModalBody?.appendChild(idxTitle);

    const idxList = document.createElement('div');
    idxList.className = 'schema-list';
    if (!res.indexes || res.indexes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'schema-pill-item';
      empty.textContent = 'Nenhum índice registrado.';
      idxList.appendChild(empty);
    } else {
      res.indexes.forEach((ix) => {
        const item = document.createElement('div');
        item.className = 'schema-pill-item';
        item.textContent = `${ix.name}: ${ix.definition}`;
        idxList.appendChild(item);
      });
    }
    schemaModalBody?.appendChild(idxList);
  }

  document.getElementById('btn-schema-modal-close')?.addEventListener('click', () => {
    schemaModal?.classList.remove('active');
  });

  // ------------------------------------------------------------------------
  // 5. Seleção de Direção, Escopo Granular & Stepper / Terminal
  // ------------------------------------------------------------------------
  const cardPush = document.getElementById('card-dir-push');
  const cardPull = document.getElementById('card-dir-pull');
  const labelActiveAction = document.getElementById('label-active-action');

  function setDirection(dir) {
    state.activeDirection = dir === 'pull' ? 'pull' : 'push';
    cardPush?.classList.toggle('selected', state.activeDirection === 'push');
    cardPull?.classList.toggle('selected', state.activeDirection === 'pull');
    if (labelActiveAction) {
      labelActiveAction.textContent = state.activeDirection === 'push'
        ? 'PUSH (Local ➜ Produção)'
        : 'PULL (Produção ➜ Local)';
    }
  }

  cardPush?.addEventListener('click', () => setDirection('push'));
  cardPull?.addEventListener('click', () => setDirection('pull'));

  function getSelectedTablesFilter() {
    if (state.selectedTables.size === 0) return null;
    return Array.from(state.selectedTables);
  }

  function renderSyncTableChips() {
    const wrap = document.getElementById('sync-tables-chips');
    if (!wrap || !state.statusData) return;
    clearElement(wrap);

    const localNames = (state.statusData.local?.tables || []).map((t) => t.name);
    const prodNames = (state.statusData.prod?.tables || []).map((t) => t.name);
    const allNames = Array.from(new Set([...localNames, ...prodNames])).sort();

    if (state.selectedTables.size === 0) {
      setText('sync-scope-summary', `Todas as ${allNames.length} tabelas`);
    } else {
      setText('sync-scope-summary', `${state.selectedTables.size} tabela(s) selecionada(s)`);
    }

    allNames.forEach((name) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      const isSelected = state.selectedTables.has(name);
      chip.className = `table-chip${isSelected ? ' selected' : ''}`;
      chip.textContent = name;
      chip.addEventListener('click', () => {
        if (state.selectedTables.has(name)) {
          state.selectedTables.delete(name);
        } else {
          state.selectedTables.add(name);
        }
        renderSyncTableChips();
      });
      wrap.appendChild(chip);
    });
  }

  document.getElementById('btn-tables-all')?.addEventListener('click', () => {
    state.selectedTables.clear();
    renderSyncTableChips();
  });

  document.getElementById('btn-tables-none')?.addEventListener('click', () => {
    state.selectedTables.clear();
    renderSyncTableChips();
  });

  document.getElementById('btn-tables-divergent')?.addEventListener('click', () => {
    if (!state.statusData) return;
    const lMap = new Map((state.statusData.local?.tables || []).map((t) => [t.name, t.rows]));
    const pMap = new Map((state.statusData.prod?.tables || []).map((t) => [t.name, t.rows]));
    const allNames = new Set([...lMap.keys(), ...pMap.keys()]);
    state.selectedTables.clear();
    allNames.forEach((name) => {
      if (lMap.get(name) !== pMap.get(name)) state.selectedTables.add(name);
    });
    if (state.selectedTables.size === 0) {
      showToast('Todas as tabelas já estão com a mesma contagem.', 'info');
    } else {
      showToast(`${state.selectedTables.size} tabela(s) divergente(s) selecionada(s).`, 'success');
    }
    renderSyncTableChips();
  });

  const terminalOutput = document.getElementById('terminal-output');
  const btnSyncDryrun = document.getElementById('btn-sync-dryrun');
  const btnSyncExecute = document.getElementById('btn-sync-execute');
  const btnSyncCancel = document.getElementById('btn-sync-cancel');
  const btnHeroDryrun = document.getElementById('hero-btn-dryrun');
  const btnQuickPush = document.getElementById('btn-quick-push');
  const chkNoDelete = document.getElementById('chk-no-delete');

  function resetStepper() {
    for (let i = 1; i <= 5; i++) {
      const el = document.getElementById(`step-${i}`);
      if (el) el.className = 'step-item';
    }
  }

  function setStepState(activeStep, isError = false, isAllDone = false) {
    for (let i = 1; i <= 5; i++) {
      const el = document.getElementById(`step-${i}`);
      if (!el) continue;
      el.className = 'step-item';
      if (isError && i === activeStep) {
        el.classList.add('error');
      } else if (isAllDone || i < activeStep) {
        el.classList.add('done');
      } else if (i === activeStep) {
        el.classList.add('active');
      }
    }
  }

  function classifyLogLine(line) {
    if (line.includes('✅') || line.includes('Sucesso')) return 'log-success';
    if (line.includes('❌') || line.includes('Erro') || line.includes('FALHA')) return 'log-error';
    if (line.includes('⚠️') || line.includes('AVISO') || line.includes('🚫')) return 'log-warn';
    if (line.includes('💾') || line.includes('Backup')) return 'log-backup';
    if (line.includes('📐') || line.includes('📊') || line.includes('🔎')) return 'log-info';
    if (line.startsWith('===') || line.startsWith('---')) return 'log-dim';
    return '';
  }

  function appendTerminal(text) {
    if (!terminalOutput) return;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (idx === lines.length - 1 && line === '') return;
      const div = document.createElement('div');
      const cls = classifyLogLine(line);
      div.className = cls ? `log-line ${cls}` : 'log-line';
      div.textContent = line;
      terminalOutput.appendChild(div);

      if (line.includes('Estrutura:') || line.includes('Dados:')) setStepState(2);
      if (line.includes('Backup das tabelas')) setStepState(3);
      if (line.includes('Aplicando') || line.includes('setval')) setStepState(4);
      if (line.includes('Sincronização concluída') || line.includes('Nada a fazer') || line.includes('Modo --dry-run')) {
        setStepState(5, false, true);
      }
      if (line.includes('❌')) setStepState(4, true, false);
    });
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  document.getElementById('btn-clear-terminal')?.addEventListener('click', () => {
    clearElement(terminalOutput);
    resetStepper();
  });

  document.getElementById('btn-copy-terminal')?.addEventListener('click', async () => {
    if (!terminalOutput) return;
    try {
      await navigator.clipboard.writeText(terminalOutput.innerText);
      showToast('Logs copiados para a área de transferência.', 'success');
    } catch {
      showToast('Não foi possível copiar os logs.', 'error');
    }
  });

  async function startSync(isDryRun = false) {
    if (state.isSyncRunning || !window.api) return;

    state.isSyncRunning = true;
    updateBotMood();
    clearElement(terminalOutput);
    resetStepper();
    setStepState(1);

    const noDelete = Boolean(chkNoDelete?.checked);
    const tablesFilter = getSelectedTablesFilter();
    const led = document.getElementById('terminal-led');
    if (led) led.style.background = '#f59e0b';

    const scopeStr = tablesFilter ? tablesFilter.join(', ') : 'TODAS';
    appendTerminal(`[EcoSync Bot] Direção: ${state.activeDirection.toUpperCase()} | Modo: ${isDryRun ? 'SIMULAÇÃO (DRY-RUN)' : 'TRANSAÇÃO REAL'} | Exclusão: ${noDelete ? 'Desativada (--no-delete)' : 'Conforme .env'} | Escopo: ${scopeStr}`);

    [btnSyncDryrun, btnSyncExecute, btnHeroDryrun, btnQuickPush].forEach((b) => { if (b) b.disabled = true; });
    if (btnSyncCancel) btnSyncCancel.disabled = false;

    window.api.removeSyncListeners();
    window.api.onSyncOutput((data) => appendTerminal(data.text));

    window.api.onSyncDone((data) => {
      state.isSyncRunning = false;
      [btnSyncDryrun, btnSyncExecute, btnHeroDryrun, btnQuickPush].forEach((b) => { if (b) b.disabled = false; });
      if (btnSyncCancel) btnSyncCancel.disabled = true;
      if (led) led.style.background = data.success ? '#10b981' : '#ef4444';

      if (data.success) {
        setStepState(5, false, true);
        showToast(isDryRun ? 'Simulação concluída com sucesso.' : 'Sincronização aplicada com segurança!', 'success');
      } else {
        setStepState(4, true, false);
        showToast('A operação terminou com erro ou cancelamento.', 'error');
      }

      appendTerminal(`\n[Finalizado] Código: ${data.code} | Duração: ${data.durationMs || 0}ms`);
      updateBotMood();
      loadStatus(true);
      loadBackups();
      loadAuditLogs();
    });

    await window.api.runSync({
      direction: state.activeDirection,
      isDryRun,
      noDelete,
      tablesFilter
    });
  }

  btnSyncDryrun?.addEventListener('click', () => startSync(true));

  btnHeroDryrun?.addEventListener('click', () => {
    switchTab('tab-sync');
    startSync(true);
  });

  btnSyncCancel?.addEventListener('click', async () => {
    if (!window.api) return;
    await window.api.cancelSync();
    appendTerminal('\n⚠️ [AVISO] Processo interrompido pelo usuário.');
    showToast('Operação cancelada.', 'warning');
  });

  // ------------------------------------------------------------------------
  // 6. Modal Pre-Flight (Prevenção de Erros de Nielsen #5)
  // ------------------------------------------------------------------------
  const confirmModal = document.getElementById('confirm-modal');
  const btnModalCancel = document.getElementById('btn-modal-cancel');
  const btnModalConfirm = document.getElementById('btn-modal-confirm');
  const modalTargetLabel = document.getElementById('modal-target-label');
  const modalPfStatus = document.getElementById('modal-preflight-status');
  const modalDangerAlert = document.getElementById('modal-danger-alert');
  const modalDangerText = document.getElementById('modal-danger-text');
  const chkSafetyConfirm = document.getElementById('chk-safety-confirm');

  async function openConfirmModal(direction) {
    setDirection(direction);
    const noDelete = Boolean(chkNoDelete?.checked);
    const tablesFilter = getSelectedTablesFilter();

    if (modalTargetLabel) {
      const scopeHint = tablesFilter ? ` • ${tablesFilter.length} tabela(s)` : ' • Todas as tabelas';
      modalTargetLabel.textContent = (direction === 'push'
        ? 'Destino: PRODUÇÃO (Coolify / Remoto)'
        : 'Destino: LOCAL (Seu computador)') + scopeHint;
    }

    setText('pf-inserts', '...');
    setText('pf-updates', '...');
    setText('pf-deletes', '...');
    setText('pf-schema', '...');
    if (modalPfStatus) modalPfStatus.textContent = 'Analisando impacto exato nos bancos antes de confirmar...';
    if (modalDangerAlert) modalDangerAlert.style.display = 'none';
    if (chkSafetyConfirm) chkSafetyConfirm.checked = false;
    if (btnModalConfirm) btnModalConfirm.disabled = true;

    confirmModal?.classList.add('active');

    const res = await window.api.getDiff({ direction, noDelete, tablesFilter });
    if (!res || !res.success) {
      if (modalPfStatus) modalPfStatus.textContent = `❌ Erro no pré-voo: ${res?.error || 'Falha ao conectar.'}`;
      return;
    }

    setText('pf-inserts', `+${res.total_inserts}`);
    setText('pf-updates', `~${res.total_updates}`);
    setText('pf-deletes', `-${res.total_deletes}`);
    setText('pf-schema', String(res.schema_changes_count));

    if (res.total_changes === 0) {
      if (modalPfStatus) modalPfStatus.textContent = '✅ Os bancos já estão idênticos no escopo selecionado. Nenhuma alteração necessária.';
      if (btnModalConfirm) btnModalConfirm.disabled = true;
      return;
    }

    if (modalPfStatus) {
      modalPfStatus.textContent = `Resumo calculado (${res.delete_missing ? 'Modo Espelho' : 'Incremental Seguro'}): um backup JSON será salvo antes da transação.`;
    }

    const requiresExplicitCheck = (res.total_deletes > 0 || res.affects_users);
    if (requiresExplicitCheck && modalDangerAlert && modalDangerText) {
      const reasons = [];
      if (res.total_deletes > 0) reasons.push(`${res.total_deletes} registro(s) serão REMOVIDOS do destino`);
      if (res.affects_users) reasons.push('a tabela de USUÁRIOS/senhas será modificada');
      modalDangerText.textContent = `⚠️ Atenção de Segurança: ${reasons.join(' e ')}.`;
      modalDangerAlert.style.display = 'block';
      if (btnModalConfirm) btnModalConfirm.disabled = true;
    } else {
      if (btnModalConfirm) btnModalConfirm.disabled = false;
    }
  }

  chkSafetyConfirm?.addEventListener('change', () => {
    if (btnModalConfirm) btnModalConfirm.disabled = !chkSafetyConfirm.checked;
  });

  function closeConfirmModal() {
    confirmModal?.classList.remove('active');
  }

  btnSyncExecute?.addEventListener('click', () => openConfirmModal(state.activeDirection));
  btnQuickPush?.addEventListener('click', () => {
    switchTab('tab-sync');
    openConfirmModal('push');
  });
  btnModalCancel?.addEventListener('click', closeConfirmModal);
  btnModalConfirm?.addEventListener('click', () => {
    closeConfirmModal();
    startSync(false);
  });

  // ------------------------------------------------------------------------
  // 7. Comparador Diff Paginado
  // ------------------------------------------------------------------------
  const btnRunDiff = document.getElementById('btn-run-diff-check');

  async function loadDiff(direction = 'push') {
    if (!window.api) return;

    if (btnRunDiff) {
      btnRunDiff.disabled = true;
      btnRunDiff.textContent = 'Comparando...';
    }

    try {
      const res = await window.api.getDiff({
        direction,
        noDelete: Boolean(chkNoDelete?.checked)
      });
      if (!res || !res.success) {
        showToast('Erro ao calcular diferenças: ' + (res?.error || 'Desconhecido'), 'error');
        return;
      }

      state.diffData = res;
      state.pagination.diff.page = 1;
      setText('diff-count-inserts', String(res.total_inserts));
      setText('diff-count-updates', String(res.total_updates));
      setText('diff-count-deletes', String(res.total_deletes));
      setText('diff-count-schema', String(res.schema_changes_count));

      renderDiffTable();
    } catch (err) {
      showToast('Erro ao calcular diff: ' + err.message, 'error');
    } finally {
      if (btnRunDiff) {
        btnRunDiff.disabled = false;
        btnRunDiff.textContent = 'Calcular Diferenças Agora';
      }
    }
  }

  function renderDiffTable() {
    const tbody = document.getElementById('tbody-diff');
    const pagEl = document.getElementById('pagination-diff');
    if (!tbody || !state.diffData) return;

    const search = (document.getElementById('input-search-diff')?.value || '').toLowerCase().trim();
    const filtered = (state.diffData.tables || []).filter((t) => {
      if (state.diffFilter === 'diff' && t.in_sync) return false;
      if (search && !t.table.toLowerCase().includes(search)) return false;
      return true;
    });

    const pageItems = paginateSlice(filtered, state.pagination.diff);
    clearElement(tbody);

    if (filtered.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.style.textAlign = 'center';
      td.style.padding = '20px';
      td.style.color = 'var(--text-dim)';
      td.textContent = 'Nenhuma tabela corresponde ao filtro selecionado.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      pageItems.forEach((t) => {
        const tr = document.createElement('tr');
        if (!t.in_sync && !t.skipped) {
          tr.className = 'clickable-row';
          tr.title = `Clique para ver amostra das diferenças de ${t.table}`;
          tr.addEventListener('click', () => openDiffDetailModal(t.table));
        }

        const tdName = document.createElement('td');
        tdName.style.fontWeight = '600';
        tdName.style.color = '#f8fafc';
        tdName.textContent = t.table;

        const tdIns = document.createElement('td');
        tdIns.style.textAlign = 'right';
        tdIns.style.color = '#34d399';
        tdIns.style.fontFamily = 'var(--font-mono)';
        tdIns.className = 'tabular';
        tdIns.textContent = `+${t.inserts}`;

        const tdUpd = document.createElement('td');
        tdUpd.style.textAlign = 'right';
        tdUpd.style.color = '#fbbf24';
        tdUpd.style.fontFamily = 'var(--font-mono)';
        tdUpd.className = 'tabular';
        tdUpd.textContent = `~${t.updates}`;

        const tdDel = document.createElement('td');
        tdDel.style.textAlign = 'right';
        tdDel.style.color = '#f87171';
        tdDel.style.fontFamily = 'var(--font-mono)';
        tdDel.className = 'tabular';
        tdDel.textContent = `-${t.deletes}`;

        const tdStatus = document.createElement('td');
        tdStatus.style.textAlign = 'center';
        if (t.skipped) {
          tdStatus.appendChild(createBadge(`Ignorada: ${t.skipped}`, 'dim'));
        } else {
          tdStatus.appendChild(createBadge(t.in_sync ? '✓ Em Sincronia' : '⚠ Divergente', t.in_sync ? 'green' : 'amber'));
        }

        tr.append(tdName, tdIns, tdUpd, tdDel, tdStatus);
        tbody.appendChild(tr);
      });
    }

    renderPagination({
      totalItems: filtered.length,
      page: state.pagination.diff.page,
      pageSize: state.pagination.diff.pageSize,
      containerEl: pagEl,
      onPageChange: (p) => {
        state.pagination.diff.page = p;
        renderDiffTable();
      },
      onPageSizeChange: (sz) => {
        state.pagination.diff.pageSize = sz;
        state.pagination.diff.page = 1;
        renderDiffTable();
      }
    });
  }

  const diffDetailModal = document.getElementById('diff-detail-modal');
  const diffDetailBody = document.getElementById('diff-detail-body');

  async function openDiffDetailModal(tableName) {
    if (!window.api || !tableName) return;
    setText('diff-detail-title', `Amostra Diff: ${tableName}`);
    setText('diff-detail-subtitle', `Direção ${state.activeDirection.toUpperCase()} • Até 12 registros por categoria (campos sensíveis mascarados)`);
    clearElement(diffDetailBody);

    const loading = document.createElement('div');
    loading.style.color = 'var(--text-muted)';
    loading.textContent = 'Extraindo diferença linha a linha...';
    diffDetailBody?.appendChild(loading);
    diffDetailModal?.classList.add('active');

    const res = await window.api.getDiffDetail({
      direction: state.activeDirection,
      tableName,
      noDelete: Boolean(chkNoDelete?.checked)
    });
    clearElement(diffDetailBody);

    if (!res?.success) {
      const errEl = document.createElement('div');
      errEl.style.color = 'var(--accent-red)';
      errEl.textContent = res?.error || 'Falha ao carregar amostra.';
      diffDetailBody?.appendChild(errEl);
      return;
    }

    const renderSection = (title, items, builderFn) => {
      const hdr = document.createElement('div');
      hdr.className = 'schema-section-title';
      hdr.textContent = title;
      diffDetailBody?.appendChild(hdr);
      const list = document.createElement('div');
      list.className = 'schema-list';
      if (!items || items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'schema-pill-item';
        empty.textContent = 'Nenhum registro nesta categoria.';
        list.appendChild(empty);
      } else {
        items.forEach((item) => list.appendChild(builderFn(item)));
      }
      diffDetailBody?.appendChild(list);
    };

    renderSection(`Novos Registros (+${res.total_inserts || 0})`, res.inserts, (row) => {
      const div = document.createElement('div');
      div.className = 'schema-pill-item';
      div.style.color = '#6ee7b7';
      div.textContent = JSON.stringify(row);
      return div;
    });

    renderSection(`Alterados (~${res.total_updates || 0})`, res.updates, (upd) => {
      const div = document.createElement('div');
      div.className = 'schema-pill-item';
      const pkHead = document.createElement('div');
      pkHead.style.marginBottom = '4px';
      pkHead.style.color = '#f8fafc';
      pkHead.textContent = `PK: ${JSON.stringify(upd.pk)}`;
      div.appendChild(pkHead);
      (upd.changes || []).forEach((chg) => {
        const chip = document.createElement('span');
        chip.className = 'diff-change-chip';
        chip.textContent = `${chg.field}: ${JSON.stringify(chg.before)} ➜ ${JSON.stringify(chg.after)}`;
        div.appendChild(chip);
      });
      return div;
    });

    renderSection(`Remoções (-${res.total_deletes || 0})`, res.deletes, (row) => {
      const div = document.createElement('div');
      div.className = 'schema-pill-item';
      div.style.color = '#fca5a5';
      div.textContent = JSON.stringify(row);
      return div;
    });
  }

  document.getElementById('btn-diff-detail-close')?.addEventListener('click', () => {
    diffDetailModal?.classList.remove('active');
  });

  btnRunDiff?.addEventListener('click', () => loadDiff(state.activeDirection));
  document.getElementById('input-search-diff')?.addEventListener('input', () => {
    state.pagination.diff.page = 1;
    renderDiffTable();
  });
  document.querySelectorAll('#diff-filters .filter-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#diff-filters .filter-pill').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.diffFilter = btn.getAttribute('data-filter');
      state.pagination.diff.page = 1;
      renderDiffTable();
    });
  });

  // ------------------------------------------------------------------------
  // 8. Robô Autônomo (Agendador Interno & Task Scheduler)
  // ------------------------------------------------------------------------
  function updateCountdownDisplay() {
    const cfg = state.schedulerConfig;
    const banner = document.getElementById('sched-banner');
    const countdownEl = document.getElementById('sched-countdown');
    const statusEl = document.getElementById('sched-last-status');
    const nextEl = document.getElementById('sched-next-time');
    if (!cfg || !banner || !countdownEl) return;

    if (!cfg.enabled || !cfg.nextRunAt) {
      banner.classList.add('paused');
      countdownEl.textContent = '--:--';
      if (statusEl) statusEl.textContent = cfg.lastStatus || 'Agendador desativado';
      if (nextEl) nextEl.textContent = cfg.lastRunAt ? `Último ciclo: ${formatTime(cfg.lastRunAt)}` : 'Nenhum ciclo agendado';
      return;
    }

    banner.classList.remove('paused');
    if (statusEl) statusEl.textContent = cfg.lastStatus || `Ativo (${cfg.direction.toUpperCase()} a cada ${cfg.intervalMinutes} min)`;
    if (nextEl) {
      const nextFormatted = formatTime(cfg.nextRunAt);
      nextEl.textContent = cfg.lastRunAt
        ? `Último: ${formatTime(cfg.lastRunAt)} • Próximo: ${nextFormatted}`
        : `Próximo ciclo previsto: ${nextFormatted}`;
    }

    const diffMs = Math.max(0, new Date(cfg.nextRunAt).getTime() - Date.now());
    const totalSec = Math.floor(diffMs / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    countdownEl.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  async function loadScheduler() {
    if (!window.api) return;
    try {
      const res = await window.api.getScheduler();
      if (!res?.success || !res.config) return;
      state.schedulerConfig = res.config;

      const chkEnabled = document.getElementById('sched-enabled');
      const selInterval = document.getElementById('sched-interval');
      const selDirection = document.getElementById('sched-direction');
      const chkNoDel = document.getElementById('sched-nodelete');
      const chkOnlyChg = document.getElementById('sched-only-changes');
      const inputMaxDel = document.getElementById('sched-max-deletes');
      const chkBlockUsers = document.getElementById('sched-block-users');
      const chkMinTray = document.getElementById('sched-minimize-tray');

      if (chkEnabled) chkEnabled.checked = Boolean(res.config.enabled);
      if (selInterval) selInterval.value = String(res.config.intervalMinutes || 30);
      if (selDirection) selDirection.value = res.config.direction || 'push';
      if (chkNoDel) chkNoDel.checked = Boolean(res.config.noDelete);
      if (chkOnlyChg) chkOnlyChg.checked = Boolean(res.config.onlyIfChanges);
      if (inputMaxDel) inputMaxDel.value = String(res.config.maxDeletesAuto ?? 20);
      if (chkBlockUsers) chkBlockUsers.checked = res.config.blockUsersAuto !== false;
      if (chkMinTray) chkMinTray.checked = res.config.minimizeToTray !== false;

      updateSchedulerCliPreview(res.rootDir || '.');
      updateCountdownDisplay();
      updateBotMood();

      if (!state.countdownTimer) {
        state.countdownTimer = setInterval(updateCountdownDisplay, 1000);
      }
    } catch {}
  }

  function updateSchedulerCliPreview(rootDir) {
    const dir = document.getElementById('sched-direction')?.value || 'push';
    const noDel = document.getElementById('sched-nodelete')?.checked;
    const cmd = `cd /d "${rootDir}" && python sync_prod.py --${dir} --yes${noDel ? ' --no-delete' : ''}`;
    setText('sched-cli-cmd', cmd);
  }

  document.getElementById('sched-direction')?.addEventListener('change', () => loadSchedulerCliOnly());
  document.getElementById('sched-nodelete')?.addEventListener('change', () => loadSchedulerCliOnly());

  async function loadSchedulerCliOnly() {
    if (!window.api) return;
    const res = await window.api.getScheduler();
    updateSchedulerCliPreview(res?.rootDir || '.');
  }

  document.getElementById('btn-save-scheduler')?.addEventListener('click', async () => {
    if (!window.api) return;
    const payload = {
      enabled: Boolean(document.getElementById('sched-enabled')?.checked),
      intervalMinutes: parseInt(document.getElementById('sched-interval')?.value || '30', 10),
      direction: document.getElementById('sched-direction')?.value || 'push',
      noDelete: Boolean(document.getElementById('sched-nodelete')?.checked),
      onlyIfChanges: Boolean(document.getElementById('sched-only-changes')?.checked),
      maxDeletesAuto: parseInt(document.getElementById('sched-max-deletes')?.value || '20', 10),
      blockUsersAuto: Boolean(document.getElementById('sched-block-users')?.checked),
      minimizeToTray: Boolean(document.getElementById('sched-minimize-tray')?.checked)
    };
    const res = await window.api.saveScheduler(payload);
    if (res?.success) {
      state.schedulerConfig = res.config;
      updateCountdownDisplay();
      updateBotMood();
      showToast(payload.enabled ? 'Agendador autônomo ativado!' : 'Agendador pausado.', 'success');
    } else {
      showToast(res?.error || 'Falha ao salvar agendamento.', 'error');
    }
  });

  document.getElementById('btn-copy-sched-cmd')?.addEventListener('click', async () => {
    const cmd = document.getElementById('sched-cli-cmd')?.textContent || '';
    try {
      await navigator.clipboard.writeText(cmd);
      showToast('Comando para Agendador do Windows copiado!', 'success');
    } catch {
      showToast('Não foi possível copiar o comando.', 'error');
    }
  });

  if (window.api?.onSchedulerEvent) {
    window.api.onSchedulerEvent((evt) => {
      if (evt?.config) {
        state.schedulerConfig = evt.config;
        updateCountdownDisplay();
        updateBotMood();
      }
      if (evt?.message) {
        const toastType = (evt.type === 'cycle-error' || evt.type === 'error')
          ? 'error'
          : (evt.type === 'blocked_safety' ? 'warning' : 'info');
        showToast(`[EcoSync Autônomo] ${evt.message}`, toastType);
      }
      if (evt?.type === 'cycle-done' || evt?.type === 'blocked_safety') {
        loadStatus(true);
        loadBackups();
        loadAuditLogs();
      }
    });
  }

  // ------------------------------------------------------------------------
  // 9. Gestor de Backups (Paginado + Retenção) & Auditoria (Paginada)
  // ------------------------------------------------------------------------
  async function loadBackupsSummary() {
    if (!window.api) return;
    try {
      const res = await window.api.getBackups();
      if (res?.success && res.backups) {
        const nProd = res.backups.prod?.length || 0;
        const nLocal = res.backups.local?.length || 0;
        setText('dash-backups-count', String(nProd + nLocal));
        setText('dash-backups-sub', `${nProd} prod • ${nLocal} local`);
      }
    } catch {}
  }

  async function loadBackups() {
    if (!window.api) return;
    try {
      const res = await window.api.getBackups();
      if (!res?.success) return;
      state.backupsData = res.backups;
      renderBackupsPaginated('prod');
      renderBackupsPaginated('local');
    } catch (err) {
      showToast('Erro ao carregar backups: ' + err.message, 'error');
    }
  }

  function renderBackupsPaginated(folderKey) {
    if (!state.backupsData) return;
    const isProd = folderKey === 'prod';
    const tbody = document.getElementById(isProd ? 'tbody-backups-prod' : 'tbody-backups-local');
    const pagEl = document.getElementById(isProd ? 'pagination-backups-prod' : 'pagination-backups-local');
    const pagState = isProd ? state.pagination.backupsProd : state.pagination.backupsLocal;
    const list = (isProd ? state.backupsData.prod : state.backupsData.local) || [];

    if (!tbody) return;
    clearElement(tbody);

    if (list.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.style.textAlign = 'center';
      td.style.color = 'var(--text-dim)';
      td.style.padding = '16px';
      td.textContent = 'Nenhum backup encontrado.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      const pageItems = paginateSlice(list, pagState);
      pageItems.forEach((b) => {
        const tr = document.createElement('tr');

        const tdFile = document.createElement('td');
        tdFile.style.fontFamily = 'var(--font-mono)';
        tdFile.style.color = '#60a5fa';
        tdFile.style.fontWeight = '500';
        tdFile.textContent = b.filename;

        const tdDate = document.createElement('td');
        tdDate.className = 'tabular';
        tdDate.textContent = b.date;

        const tdSize = document.createElement('td');
        tdSize.style.textAlign = 'right';
        tdSize.style.fontFamily = 'var(--font-mono)';
        tdSize.className = 'tabular';
        tdSize.textContent = `${b.size_kb} KB`;

        const tdTables = document.createElement('td');
        tdTables.style.textAlign = 'right';
        tdTables.className = 'tabular';
        tdTables.textContent = `${b.tables_count} tabelas (${b.total_records || 0} reg.)`;

        const tdAction = document.createElement('td');
        tdAction.style.textAlign = 'center';
        const btnPrev = document.createElement('button');
        btnPrev.className = 'btn btn-secondary btn-sm';
        btnPrev.textContent = 'Visualizar';
        btnPrev.addEventListener('click', () => openBackupPreview(folderKey, b.filename));
        tdAction.appendChild(btnPrev);

        tr.append(tdFile, tdDate, tdSize, tdTables, tdAction);
        tbody.appendChild(tr);
      });
    }

    renderPagination({
      totalItems: list.length,
      page: pagState.page,
      pageSize: pagState.pageSize,
      containerEl: pagEl,
      onPageChange: (p) => {
        pagState.page = p;
        renderBackupsPaginated(folderKey);
      },
      onPageSizeChange: (sz) => {
        pagState.pageSize = sz;
        pagState.page = 1;
        renderBackupsPaginated(folderKey);
      }
    });
  }

  document.getElementById('btn-cleanup-backups')?.addEventListener('click', async () => {
    if (!window.api) return;
    const res = await window.api.cleanupBackups(10);
    if (res?.success) {
      if (res.removed_files > 0) {
        showToast(`${res.removed_files} snapshot(s) antigo(s) removido(s) (${res.freed_kb} KB liberados).`, 'success');
      } else {
        showToast('Nenhum snapshot excedente encontrado (retenção de 10 por pasta já cumprida).', 'info');
      }
      loadBackups();
      loadBackupsSummary();
      loadInsights(true);
    } else {
      showToast(res?.error || 'Falha ao limpar backups antigos.', 'error');
    }
  });

  const backupModal = document.getElementById('backup-modal');
  const backupPreviewContent = document.getElementById('backup-preview-content');
  const restoreConfirmBox = document.getElementById('restore-confirm-box');
  const chkRestoreConfirm = document.getElementById('chk-restore-confirm');
  const btnRestoreInit = document.getElementById('btn-restore-backup-init');
  const btnRestoreConfirm = document.getElementById('btn-restore-backup-confirm');

  async function openBackupPreview(folder, filename) {
    if (!window.api) return;
    state.activeBackupPreview = { folder, filename };
    setText('backup-modal-title', `Snapshot: ${filename}`);
    if (backupPreviewContent) backupPreviewContent.textContent = 'Carregando conteúdo mascarado...';
    if (restoreConfirmBox) restoreConfirmBox.style.display = 'none';
    if (chkRestoreConfirm) chkRestoreConfirm.checked = false;
    if (btnRestoreConfirm) {
      btnRestoreConfirm.style.display = 'none';
      btnRestoreConfirm.disabled = true;
    }
    if (btnRestoreInit) {
      btnRestoreInit.style.display = state.currentUser?.perfil === 'ADMIN' ? 'inline-flex' : 'none';
    }
    backupModal?.classList.add('active');

    const res = await window.api.previewBackup({ folder, filename });
    if (!res || !res.success) {
      if (backupPreviewContent) backupPreviewContent.textContent = `Erro: ${res?.error || 'Falha ao ler arquivo.'}`;
      return;
    }

    if (backupPreviewContent) {
      backupPreviewContent.textContent = JSON.stringify(res.tables, null, 2);
    }
  }

  btnRestoreInit?.addEventListener('click', () => {
    if (!state.activeBackupPreview) return;
    const dstLabel = state.activeBackupPreview.folder === 'prod' ? 'PRODUÇÃO (Coolify)' : 'LOCAL';
    setText(
      'restore-confirm-msg',
      `Atenção: restaurar ${state.activeBackupPreview.filename} aplicará os registros no banco ${dstLabel} (um pré-backup automático será salvo antes).`
    );
    if (restoreConfirmBox) restoreConfirmBox.style.display = 'block';
    if (btnRestoreInit) btnRestoreInit.style.display = 'none';
    if (btnRestoreConfirm) btnRestoreConfirm.style.display = 'inline-flex';
  });

  chkRestoreConfirm?.addEventListener('change', () => {
    if (btnRestoreConfirm) btnRestoreConfirm.disabled = !chkRestoreConfirm.checked;
  });

  btnRestoreConfirm?.addEventListener('click', async () => {
    if (!window.api || !state.activeBackupPreview) return;
    btnRestoreConfirm.disabled = true;
    btnRestoreConfirm.textContent = 'Restaurando...';
    try {
      const res = await window.api.restoreBackup(state.activeBackupPreview);
      if (res?.success) {
        showToast(
          `Snapshot restaurado! ${res.restored_rows} registros em ${res.tables_count} tabela(s). Pré-backup: ${res.safety_backup}`,
          'success'
        );
        backupModal?.classList.remove('active');
        loadStatus(true);
        loadBackups();
        loadAuditLogs();
      } else {
        showToast(res?.error || 'Falha ao restaurar snapshot.', 'error');
      }
    } finally {
      btnRestoreConfirm.disabled = false;
      btnRestoreConfirm.textContent = 'Confirmar Restauração';
    }
  });

  document.getElementById('btn-backup-modal-close')?.addEventListener('click', () => {
    backupModal?.classList.remove('active');
  });

  async function loadAuditLogs() {
    if (!window.api) return;
    const res = await window.api.getAuditLogs();
    state.auditLogs = res?.logs || [];
    renderAuditLogsTable();
  }

  function renderAuditLogsTable() {
    const tbody = document.getElementById('tbody-audit');
    const pagEl = document.getElementById('pagination-audit');
    if (!tbody) return;

    const logs = state.auditLogs || [];
    clearElement(tbody);

    if (logs.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.style.textAlign = 'center';
      td.style.color = 'var(--text-dim)';
      td.style.padding = '16px';
      td.textContent = 'Nenhum evento de auditoria registrado ainda.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      const pageItems = paginateSlice(logs, state.pagination.audit);
      pageItems.forEach((log) => {
        const tr = document.createElement('tr');

        const tdTime = document.createElement('td');
        tdTime.className = 'tabular';
        tdTime.textContent = formatTime(log.timestamp);

        const tdAuthor = document.createElement('td');
        tdAuthor.style.fontSize = '11.5px';
        tdAuthor.style.color = 'var(--text-muted)';
        tdAuthor.textContent = log.userEmail || 'AUTONOMO';

        const tdAction = document.createElement('td');
        tdAction.style.fontWeight = '600';
        tdAction.style.color = '#f8fafc';
        tdAction.textContent = log.action || '--';

        const tdMeta = document.createElement('td');
        tdMeta.textContent = [log.direction?.toUpperCase(), log.mode].filter(Boolean).join(' • ') || '-';

        const tdDur = document.createElement('td');
        tdDur.style.textAlign = 'right';
        tdDur.style.fontFamily = 'var(--font-mono)';
        tdDur.className = 'tabular';
        tdDur.textContent = log.durationMs ? `${log.durationMs}ms` : '--';

        const tdRes = document.createElement('td');
        tdRes.style.textAlign = 'center';
        tdRes.appendChild(createBadge(log.success ? '✓ Sucesso' : '✕ Falha', log.success ? 'green' : 'red'));

        tr.append(tdTime, tdAuthor, tdAction, tdMeta, tdDur, tdRes);
        tbody.appendChild(tr);
      });
    }

    renderPagination({
      totalItems: logs.length,
      page: state.pagination.audit.page,
      pageSize: state.pagination.audit.pageSize,
      containerEl: pagEl,
      onPageChange: (p) => {
        state.pagination.audit.page = p;
        renderAuditLogsTable();
      },
      onPageSizeChange: (sz) => {
        state.pagination.audit.pageSize = sz;
        state.pagination.audit.page = 1;
        renderAuditLogsTable();
      }
    });
  }

  document.getElementById('btn-open-backups-prod')?.addEventListener('click', () => window.api.openFolder('backups_prod'));
  document.getElementById('btn-open-backups-local')?.addEventListener('click', () => window.api.openFolder('backups_local'));
  document.getElementById('btn-open-logs-folder')?.addEventListener('click', () => window.api.openFolder('logs'));

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeConfirmModal();
      backupModal?.classList.remove('active');
      schemaModal?.classList.remove('active');
      diffDetailModal?.classList.remove('active');
      document.getElementById('update-modal')?.classList.remove('active');
    }
  });

  // ------------------------------------------------------------------------
  // 10. Configurações (.env) com Mascaramento & Validação
  // ------------------------------------------------------------------------
  document.querySelectorAll('.btn-eye').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const input = document.getElementById(targetId);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  async function loadSettings() {
    if (!window.api) return;
    const res = await window.api.readEnvConfig();
    if (!res || !res.config) return;

    const cfg = res.config;
    const inputLocal = document.getElementById('setting-local-url');
    const inputProd = document.getElementById('setting-prod-url');
    const selectDir = document.getElementById('setting-direction');
    const selectDel = document.getElementById('setting-delete-missing');
    const selectConfirm = document.getElementById('setting-auto-confirm');
    const inputExclude = document.getElementById('setting-exclude-tables');
    const inputUpdateUrl = document.getElementById('setting-update-url');
    const inputUpdateToken = document.getElementById('setting-update-token');

    const isReadOnly = Boolean(res.readOnly);
    if (inputLocal) {
      inputLocal.value = cfg.localUrl || '';
      inputLocal.placeholder = isReadOnly ? cfg.localUrlMasked || 'Restrito ao perfil ADMIN' : '';
      inputLocal.type = 'password';
      inputLocal.disabled = isReadOnly;
    }
    if (inputProd) {
      inputProd.value = cfg.prodUrl || '';
      inputProd.placeholder = isReadOnly ? cfg.prodUrlMasked || 'Restrito ao perfil ADMIN' : '';
      inputProd.type = 'password';
      inputProd.disabled = isReadOnly;
    }
    setText('hint-local-masked', `Visão segura: ${cfg.localUrlMasked || 'não definida'}`);
    setText('hint-prod-masked', `Visão segura: ${cfg.prodUrlMasked || 'usando fallback do sistema'}`);

    if (selectDir) { selectDir.value = cfg.direction; selectDir.disabled = isReadOnly; }
    if (selectDel) { selectDel.value = cfg.deleteMissing ? 'true' : 'false'; selectDel.disabled = isReadOnly; }
    if (selectConfirm) { selectConfirm.value = cfg.autoConfirm ? 'true' : 'false'; selectConfirm.disabled = isReadOnly; }
    if (inputExclude) { inputExclude.value = cfg.excludeTables || ''; inputExclude.disabled = isReadOnly; }
    if (inputUpdateUrl) { inputUpdateUrl.value = cfg.updateUrl || ''; inputUpdateUrl.disabled = isReadOnly; }
    if (inputUpdateToken) {
      inputUpdateToken.value = cfg.updateToken || '';
      inputUpdateToken.type = 'password';
      inputUpdateToken.disabled = isReadOnly;
    }
    const btnSaveEnv = document.getElementById('btn-save-env');
    if (btnSaveEnv) btnSaveEnv.disabled = isReadOnly;
  }

  document.getElementById('btn-save-env')?.addEventListener('click', async () => {
    if (!window.api) return;

    const payload = {
      localUrl: document.getElementById('setting-local-url')?.value.trim() || '',
      prodUrl: document.getElementById('setting-prod-url')?.value.trim() || '',
      direction: document.getElementById('setting-direction')?.value || 'push',
      deleteMissing: document.getElementById('setting-delete-missing')?.value !== 'false',
      autoConfirm: document.getElementById('setting-auto-confirm')?.value === 'true',
      excludeTables: document.getElementById('setting-exclude-tables')?.value.trim() || '',
      updateUrl: document.getElementById('setting-update-url')?.value.trim() || '',
      updateToken: document.getElementById('setting-update-token')?.value.trim() || ''
    };

    const res = await window.api.saveEnvConfig(payload);
    if (res?.success) {
      showToast('Configurações validadas e salvas com backup (.env.bak)!', 'success');
      loadSettings();
      loadStatus(false);
    } else {
      showToast(res?.error || 'Erro ao salvar configurações.', 'error');
    }
  });

  document.getElementById('btn-open-env-file')?.addEventListener('click', () => window.api.openEnvExternal());

  document.getElementById('btn-test-env-conns')?.addEventListener('click', async () => {
    await loadStatus(false);
    showToast('Diagnóstico de rede e conexão atualizado.', 'info');
  });

  // ------------------------------------------------------------------------
  // 11. Sistema de Login, Sessão & Controle de Acesso (RBAC)
  // ------------------------------------------------------------------------
  const loginOverlay = document.getElementById('login-overlay');
  const loginForm = document.getElementById('login-form');
  const loginErrorBox = document.getElementById('login-error-box');
  const btnLoginSubmit = document.getElementById('btn-login-submit');
  const userSessionCard = document.getElementById('user-session-card');

  function showLoginError(msg) {
    if (!loginErrorBox) return;
    if (!msg) {
      loginErrorBox.textContent = '';
      loginErrorBox.classList.remove('visible');
    } else {
      loginErrorBox.textContent = msg;
      loginErrorBox.classList.add('visible');
    }
  }

  function applySessionUI(user) {
    state.currentUser = user;
    const isAdmin = user?.perfil === 'ADMIN';

    if (!user) {
      loginOverlay?.classList.add('active');
      if (userSessionCard) userSessionCard.style.display = 'none';
      setupAutoRefresh();
      return;
    }

    loginOverlay?.classList.remove('active');
    if (userSessionCard) userSessionCard.style.display = 'flex';
    setText('session-user-name', user.nome || user.email);
    setText('session-user-role', `${user.perfil}${user.offlineMode ? ' • Offline' : ''}`);

    const adminControls = [
      'btn-quick-push',
      'btn-sync-execute',
      'btn-cleanup-backups',
      'btn-save-scheduler',
      'btn-save-env',
      'btn-open-env-file',
      'btn-run-analyze'
    ];
    adminControls.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.disabled = !isAdmin;
      el.title = isAdmin ? '' : 'Ação restrita ao perfil ADMIN';
    });

    setupAutoRefresh();
    loadScheduler();
    loadStatus(false);
    if (!state.updateCheckedOnLogin) {
      state.updateCheckedOnLogin = true;
      setTimeout(() => runUpdateCheck(true), 1200);
    }
  }

  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!window.api) return;
    const email = document.getElementById('login-email')?.value.trim() || '';
    const password = document.getElementById('login-password')?.value || '';
    showLoginError('');

    if (btnLoginSubmit) {
      btnLoginSubmit.disabled = true;
      btnLoginSubmit.textContent = 'Autenticando...';
    }

    try {
      const res = await window.api.authLogin({ email, password });
      if (res?.success && res.user) {
        const pwdInput = document.getElementById('login-password');
        if (pwdInput) pwdInput.value = '';
        applySessionUI(res.user);
        showToast(`Bem-vindo, ${res.user.nome || res.user.email} (${res.user.perfil})!`, 'success');
      } else {
        showLoginError(res?.error || 'Falha na autenticação.');
      }
    } catch (err) {
      showLoginError('Erro ao autenticar: ' + err.message);
    } finally {
      if (btnLoginSubmit) {
        btnLoginSubmit.disabled = false;
        btnLoginSubmit.textContent = 'Entrar no Painel Seguro';
      }
    }
  });

  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    if (!window.api) return;
    await window.api.authLogout();
    state.statusData = null;
    state.insightsData = null;
    state.diffData = null;
    applySessionUI(null);
    showToast('Sessão encerrada.', 'info');
  });

  async function initSessionGate() {
    if (!window.api) return;
    const res = await window.api.getAuthSession();
    if (res?.authenticated && res.user) {
      applySessionUI(res.user);
    } else {
      applySessionUI(null);
      document.getElementById('login-email')?.focus();
    }
  }

  // ------------------------------------------------------------------------
  // 12. Sistema de Auto-Atualização Universal (NSIS & Portátil)
  // ------------------------------------------------------------------------
  const updateModal = document.getElementById('update-modal');
  const btnSidebarUpdate = document.getElementById('btn-sidebar-update');
  const btnCheckUpdates = document.getElementById('btn-check-updates');
  const btnUpdateLater = document.getElementById('btn-update-later');
  const btnUpdateDownload = document.getElementById('btn-update-download');
  const btnUpdateInstall = document.getElementById('btn-update-install');
  const updateProgressWrap = document.getElementById('update-progress-wrap');
  const updateProgressFill = document.getElementById('update-progress-fill');

  async function loadAppInfo() {
    if (!window.api?.getAppInfo) return;
    const info = await window.api.getAppInfo();
    if (!info?.success) return;
    state.appInfo = info;
    const shortType = info.exeType === 'portable' ? 'Portátil' : info.exeType === 'nsis' ? 'Instalador' : 'Dev';
    setText('bot-version-tag', `v${info.version} • ${shortType}`);
    setText('badge-exe-mode', info.exeLabel || shortType);
  }

  function openUpdateModal() {
    if (!state.availableUpdate) return;
    const u = state.availableUpdate;
    const curVer = state.appInfo?.version || '1.1.0';
    setText('update-ver-diff', `v${curVer} ➜ v${u.version}`);
    setText('update-exe-badge', state.appInfo?.exeLabel || (u.pickedKind === 'nsis' ? 'Instalador NSIS' : 'Portátil'));
    const sizeMb = u.size ? `${(u.size / (1024 * 1024)).toFixed(1)} MB` : 'tamanho sob demanda';
    setText('update-file-meta', `Arquivo compatível: ${u.fileName} (${sizeMb})${u.sha256 ? ' • SHA-256 verificado' : ''}`);
    setText('update-notes-box', u.notes || `Nova versão v${u.version} pronta para download.`);

    if (updateProgressWrap) {
      updateProgressWrap.style.display = state.updateDownloaded ? 'block' : 'none';
    }
    if (btnUpdateDownload) {
      btnUpdateDownload.style.display = state.updateDownloaded ? 'none' : 'inline-flex';
      btnUpdateDownload.disabled = false;
      btnUpdateDownload.textContent = 'Baixar Nova Versão';
    }
    if (btnUpdateInstall) {
      btnUpdateInstall.style.display = state.updateDownloaded ? 'inline-flex' : 'none';
      btnUpdateInstall.disabled = false;
    }
    updateModal?.classList.add('active');
  }

  async function runUpdateCheck(silent = false) {
    if (!window.api?.checkForUpdates || !state.currentUser) return;
    if (btnCheckUpdates && !silent) {
      btnCheckUpdates.disabled = true;
      btnCheckUpdates.textContent = 'Verificando...';
    }
    try {
      const res = await window.api.checkForUpdates();
      if (!res) return;

      if (res.notConfigured) {
        setText('update-status-hint', 'Configure APP_UPDATE_URL acima para habilitar atualizações automáticas.');
        if (!silent) showToast(res.error || 'Fonte de atualização (APP_UPDATE_URL) não configurada.', 'info');
        return;
      }

      if (!res.success) {
        setText('update-status-hint', `Última verificação: ${res.error || 'falhou'}`);
        if (!silent) showToast(res.error || 'Falha ao consultar atualizações.', 'error');
        return;
      }

      if (res.updateAvailable && res.update) {
        state.availableUpdate = res.update;
        state.updateDownloaded = false;
        setText('sidebar-update-label', `Atualizar para v${res.update.version}`);
        if (btnSidebarUpdate) btnSidebarUpdate.style.display = 'flex';
        setText('update-status-hint', `Nova versão v${res.update.version} disponível (${res.update.fileName})!`);
        openUpdateModal();
      } else if (res.noReleasesYet) {
        state.availableUpdate = null;
        if (btnSidebarUpdate) btnSidebarUpdate.style.display = 'none';
        setText('update-status-hint', res.message || 'Nenhuma Release publicada ainda no GitHub.');
        if (!silent) showToast(res.message || 'Nenhuma Release publicada ainda no GitHub.', 'info');
      } else {
        state.availableUpdate = null;
        if (btnSidebarUpdate) btnSidebarUpdate.style.display = 'none';
        setText('update-status-hint', `Você está na versão mais recente (v${res.currentVersion}).`);
        if (!silent) showToast(`EcoSync Bot já está atualizado (v${res.currentVersion}).`, 'success');
      }
    } finally {
      if (btnCheckUpdates && !silent) {
        btnCheckUpdates.disabled = false;
        btnCheckUpdates.textContent = 'Verificar Atualizações';
      }
    }
  }

  window.api?.onUpdateProgress?.((prog) => {
    if (!updateProgressWrap) return;
    updateProgressWrap.style.display = 'block';
    const pct = prog.percent ?? 0;
    if (updateProgressFill) updateProgressFill.style.width = `${pct}%`;
    setText('update-progress-pct', prog.percent !== null ? `${pct}%` : '--');
    if (prog.phase === 'verifying') {
      setText('update-progress-label', 'Verificando integridade SHA-256...');
    } else {
      const dlMb = ((prog.downloaded || 0) / (1024 * 1024)).toFixed(1);
      const totMb = prog.total ? ` / ${(prog.total / (1024 * 1024)).toFixed(1)} MB` : ' MB';
      setText('update-progress-label', `Baixando nova versão (${dlMb}${totMb})...`);
    }
  });

  btnCheckUpdates?.addEventListener('click', () => runUpdateCheck(false));
  btnSidebarUpdate?.addEventListener('click', () => openUpdateModal());
  btnUpdateLater?.addEventListener('click', () => updateModal?.classList.remove('active'));

  btnUpdateDownload?.addEventListener('click', async () => {
    if (!window.api?.downloadUpdate) return;
    btnUpdateDownload.disabled = true;
    btnUpdateDownload.textContent = 'Baixando...';
    if (btnUpdateLater) btnUpdateLater.disabled = true;
    if (updateProgressWrap) updateProgressWrap.style.display = 'block';
    if (updateProgressFill) updateProgressFill.style.width = '0%';
    setText('update-progress-label', 'Conectando ao servidor de atualização...');
    setText('update-progress-pct', '0%');

    try {
      const res = await window.api.downloadUpdate();
      if (res?.success) {
        state.updateDownloaded = true;
        if (updateProgressFill) updateProgressFill.style.width = '100%';
        setText('update-progress-label', 'Download concluído e verificado! Pronto para aplicar.');
        setText('update-progress-pct', '100%');
        btnUpdateDownload.style.display = 'none';
        if (btnUpdateInstall) btnUpdateInstall.style.display = 'inline-flex';
        showToast('Nova versão baixada com segurança! Clique em "Aplicar e Reiniciar".', 'success');
      } else {
        showToast(res?.error || 'Falha ao baixar atualização.', 'error');
        btnUpdateDownload.disabled = false;
        btnUpdateDownload.textContent = 'Tentar Novamente';
      }
    } finally {
      if (btnUpdateLater) btnUpdateLater.disabled = false;
    }
  });

  btnUpdateInstall?.addEventListener('click', async () => {
    if (!window.api?.installUpdate) return;
    btnUpdateInstall.disabled = true;
    btnUpdateInstall.textContent = 'Aplicando...';
    const res = await window.api.installUpdate();
    if (res?.success) {
      showToast(res.message || 'Atualizando e reiniciando o EcoSync Bot...', 'info');
      if (res.devMode) {
        btnUpdateInstall.disabled = false;
        btnUpdateInstall.textContent = 'Abrir Pasta';
      }
    } else {
      showToast(res?.error || 'Erro ao aplicar atualização.', 'error');
      btnUpdateInstall.disabled = false;
      btnUpdateInstall.textContent = 'Aplicar e Reiniciar';
    }
  });

  loadAppInfo();
  initSessionGate();
});

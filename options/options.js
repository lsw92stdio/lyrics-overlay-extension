document.addEventListener('DOMContentLoaded', async () => {
  if (typeof I18n !== 'undefined') I18n.applyToDOM();

  const tbody = document.getElementById('sitesList');
  const emptyState = document.getElementById('emptyState');
  const btnRefresh = document.getElementById('btnRefresh');

  async function loadData() {
    const { settings = {} } = await chrome.storage.local.get('settings');
    const { siteStates = {} } = await chrome.storage.local.get('siteStates');
    
    const remoteSites = settings.remoteEnabledSites || {};
    
    // Gather all unique hostnames
    const allHosts = new Set([
      ...Object.keys(remoteSites),
      ...Object.keys(siteStates)
    ]);

    tbody.innerHTML = '';
    
    if (allHosts.size === 0) {
      emptyState.classList.remove('hidden');
      return;
    }
    
    emptyState.classList.add('hidden');
    
    const sortedHosts = Array.from(allHosts).sort();

    for (const host of sortedHosts) {
      const isRemoteEnabled = remoteSites[host] === true;
      const state = siteStates[host] || {};
      
      const isPinned = !!state.isPinned;
      const hasCustomDesign = !!state.styleOverrides;
      const hasPosition = state.remotePosition || state.containerAlignX;
      
      // If a site exists but has completely default/false values, we might skip it or show it as empty.
      if (!isRemoteEnabled && !isPinned && !hasCustomDesign && !hasPosition) {
        continue; // skip completely empty artifacts
      }

      const tr = document.createElement('tr');
      
      // Domain
      const tdDomain = document.createElement('td');
      tdDomain.className = 'site-domain';
      tdDomain.textContent = host;
      tr.appendChild(tdDomain);
      
      // Remote State
      const tdRemote = document.createElement('td');
      const badgeRemote = document.createElement('span');
      badgeRemote.className = `badge ${isRemoteEnabled ? 'active' : 'inactive'}`;
      badgeRemote.textContent = isRemoteEnabled ? 'ON' : 'OFF';
      tdRemote.appendChild(badgeRemote);
      tr.appendChild(tdRemote);
      
      // Layout / Position
      const tdLayout = document.createElement('td');
      const layoutInfo = [];
      if (isPinned) layoutInfo.push('📌 ' + I18n.t('opt_pinned', [], 'Pinned'));
      if (state.remotePosition) layoutInfo.push(I18n.t('opt_remote_moved', [], 'Remote moved'));
      if (state.containerAlignX) layoutInfo.push(I18n.t('opt_lyrics_moved', [], 'Lyrics moved'));
      tdLayout.innerHTML = `<div class="info-text">${layoutInfo.length > 0 ? layoutInfo.join('<br>') : '<span style="color:#555">-</span>'}</div>`;
      tr.appendChild(tdLayout);
      
      // Custom Design
      const tdDesign = document.createElement('td');
      const badgeDesign = document.createElement('span');
      badgeDesign.className = `badge ${hasCustomDesign ? 'active' : ''}`;
      badgeDesign.style.background = hasCustomDesign ? 'rgba(0, 210, 106, 0.15)' : 'transparent';
      badgeDesign.style.border = hasCustomDesign ? '1px solid rgba(0, 210, 106, 0.3)' : '1px solid #444';
      badgeDesign.style.color = hasCustomDesign ? '#00d26a' : '#555';
      badgeDesign.textContent = hasCustomDesign ? I18n.t('opt_badge_custom_design', [], 'Custom Design') : I18n.t('opt_badge_global', [], 'Global Default');
      tdDesign.appendChild(badgeDesign);
      tr.appendChild(tdDesign);
      
      // Actions
      const tdActions = document.createElement('td');
      const btnDelete = document.createElement('button');
      btnDelete.className = 'btn-danger';
      btnDelete.textContent = I18n.t('opt_btn_delete', [], 'Reset / Delete');
      btnDelete.onclick = async () => {
        const confirmMsg = I18n.t('opt_confirm_delete', [host]) || `Are you sure you want to delete all custom settings for ${host}?`;
        if (confirm(confirmMsg)) {
          // Delete from settings
          const { settings: currentSettings = {} } = await chrome.storage.local.get('settings');
          if (currentSettings.remoteEnabledSites) {
            delete currentSettings.remoteEnabledSites[host];
          }
          await chrome.storage.local.set({ settings: currentSettings });
          
          // Delete from siteStates
          const { siteStates: currentSiteStates = {} } = await chrome.storage.local.get('siteStates');
          delete currentSiteStates[host];
          await chrome.storage.local.set({ siteStates: currentSiteStates });
          
          loadData();
        }
      };
      tdActions.appendChild(btnDelete);
      tr.appendChild(tdActions);
      
      tbody.appendChild(tr);
    }
    
    // Check again if all valid rows were skipped
    if (tbody.children.length === 0) {
      emptyState.classList.remove('hidden');
    }
  }

  btnRefresh.addEventListener('click', loadData);
  
  loadData();
});

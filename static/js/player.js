// Global player instance
let hlsInstance = null;
let statsInterval = null;
let savedVolume = parseInt(localStorage.getItem("volume")) || 100;
let savedMuted = localStorage.getItem("muted") === "true";
let hasUserInteracted = false;

// Retry tracking for error recovery
let networkRetryCount = 0;
let networkRetryTimeout = null;
const MAX_NETWORK_RETRIES = 10;
const INITIAL_RETRY_DELAY = 1000; // 1 second

// Track user interaction
document.addEventListener("click", () => { hasUserInteracted = true; }, { once: true });
document.addEventListener("keydown", () => { hasUserInteracted = true; }, { once: true });

// Performance stats tracking
const perfStats = {
  loadStartTime: 0,
  timeToFirstFrame: 0,
  segmentLoadTimes: [],
  errors: 0,
  recoveries: 0,
};

// ===========================================
// Virtual Scroller for Channel List
// ===========================================
class VirtualChannelList {
  constructor(container, options = {}) {
    this.container = container;
    this.itemHeight = options.itemHeight || 52;
    this.headerHeight = options.headerHeight || 40;
    this.bufferSize = options.bufferSize || 10;

    this.allChannels = [];
    this.categories = [];
    this.flatItems = [];
    this.filteredItems = [];
    this.collapsedCategories = new Set();
    this.activeStreamId = null;
    this.searchQuery = '';

    this.scrollTop = 0;
    this.containerHeight = 0;

    this.wrapper = null;
    this.content = null;

    this.init();
  }

  init() {
    // Create wrapper structure
    this.container.innerHTML = '';
    this.container.style.overflow = 'auto';
    this.container.style.position = 'relative';

    this.wrapper = document.createElement('div');
    this.wrapper.className = 'virtual-scroll-wrapper';
    this.wrapper.style.position = 'relative';
    this.wrapper.style.width = '100%';

    this.content = document.createElement('div');
    this.content.className = 'virtual-scroll-content';
    this.content.style.position = 'absolute';
    this.content.style.top = '0';
    this.content.style.left = '0';
    this.content.style.right = '0';

    this.wrapper.appendChild(this.content);
    this.container.appendChild(this.wrapper);

    // Throttled scroll handler
    let ticking = false;
    this.container.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          this.onScroll();
          ticking = false;
        });
        ticking = true;
      }
    });

    // Handle resize
    this.resizeObserver = new ResizeObserver(() => {
      this.containerHeight = this.container.clientHeight;
      this.render();
    });
    this.resizeObserver.observe(this.container);
  }

  setData(categories, channels) {
    this.categories = categories;
    this.allChannels = channels;
    this.buildFlatList();
    this.applyFilters();
  }

  buildFlatList() {
    this.flatItems = [];
    const channelsByCategory = new Map();

    // Group channels by category
    for (const ch of this.allChannels) {
      const catId = ch.categoryId || '__uncategorized__';
      if (!channelsByCategory.has(catId)) {
        channelsByCategory.set(catId, []);
      }
      channelsByCategory.get(catId).push(ch);
    }

    // Build flat list with categories
    for (const cat of this.categories) {
      const channels = channelsByCategory.get(cat.id) || [];
      if (channels.length === 0) continue;

      this.flatItems.push({
        type: 'category',
        id: cat.id,
        name: cat.name,
        count: channels.length
      });

      for (const ch of channels) {
        this.flatItems.push({
          type: 'channel',
          categoryId: cat.id,
          ...ch
        });
      }
    }

    // Add uncategorized
    const uncategorized = channelsByCategory.get('__uncategorized__') || [];
    if (uncategorized.length > 0) {
      this.flatItems.push({
        type: 'category',
        id: '__uncategorized__',
        name: 'Uncategorized',
        count: uncategorized.length
      });
      for (const ch of uncategorized) {
        this.flatItems.push({
          type: 'channel',
          categoryId: '__uncategorized__',
          ...ch
        });
      }
    }
  }

  applyFilters() {
    const hiddenCategories = JSON.parse(localStorage.getItem("hiddenCategories") || "[]");
    const showFavoritesOnly = localStorage.getItem("showFavoritesOnly") === "true";
    const favorites = JSON.parse(localStorage.getItem("favoriteChannels") || "[]");
    const query = this.searchQuery.toLowerCase();

    this.filteredItems = [];
    let currentCategoryVisible = true;
    let currentCategoryId = null;
    let pendingCategory = null;

    for (const item of this.flatItems) {
      if (item.type === 'category') {
        // Check if category is hidden by filter
        if (hiddenCategories.includes(item.id)) {
          currentCategoryVisible = false;
          currentCategoryId = item.id;
          pendingCategory = null;
          continue;
        }
        currentCategoryVisible = true;
        currentCategoryId = item.id;
        pendingCategory = item;
        continue;
      }

      // Channel item
      if (!currentCategoryVisible) continue;
      if (this.collapsedCategories.has(item.categoryId)) continue;

      // Search filter
      if (query && !item.name.toLowerCase().includes(query)) continue;

      // Favorites filter
      if (showFavoritesOnly && !favorites.includes(item.streamId)) continue;

      // Add pending category header if we have a visible channel
      if (pendingCategory) {
        this.filteredItems.push(pendingCategory);
        pendingCategory = null;
      }

      this.filteredItems.push(item);
    }

    this.updateWrapperHeight();
    this.render();
  }

  updateWrapperHeight() {
    let height = 0;
    for (const item of this.filteredItems) {
      height += item.type === 'category' ? this.headerHeight : this.itemHeight;
    }
    this.wrapper.style.height = `${height}px`;
  }

  getItemTop(index) {
    let top = 0;
    for (let i = 0; i < index; i++) {
      top += this.filteredItems[i].type === 'category' ? this.headerHeight : this.itemHeight;
    }
    return top;
  }

  getVisibleRange() {
    const scrollTop = this.scrollTop;
    const viewportHeight = this.containerHeight || this.container.clientHeight;

    // Find start index
    let top = 0;
    let startIndex = 0;
    for (let i = 0; i < this.filteredItems.length; i++) {
      const itemHeight = this.filteredItems[i].type === 'category' ? this.headerHeight : this.itemHeight;
      if (top + itemHeight > scrollTop) {
        startIndex = i;
        break;
      }
      top += itemHeight;
    }

    // Find end index
    let endIndex = startIndex;
    let visibleHeight = 0;
    for (let i = startIndex; i < this.filteredItems.length; i++) {
      const itemHeight = this.filteredItems[i].type === 'category' ? this.headerHeight : this.itemHeight;
      visibleHeight += itemHeight;
      endIndex = i;
      if (visibleHeight > viewportHeight) break;
    }

    // Add buffer
    startIndex = Math.max(0, startIndex - this.bufferSize);
    endIndex = Math.min(this.filteredItems.length - 1, endIndex + this.bufferSize);

    return { startIndex, endIndex };
  }

  onScroll() {
    this.scrollTop = this.container.scrollTop;
    this.render();
  }

  render() {
    if (this.filteredItems.length === 0) {
      this.content.innerHTML = '<div class="empty-state"><p>No channels found</p></div>';
      this.content.style.transform = 'translateY(0)';
      return;
    }

    const { startIndex, endIndex } = this.getVisibleRange();
    const offsetTop = this.getItemTop(startIndex);

    const favorites = JSON.parse(localStorage.getItem("favoriteChannels") || "[]");
    const fragment = document.createDocumentFragment();

    for (let i = startIndex; i <= endIndex; i++) {
      const item = this.filteredItems[i];
      if (item.type === 'category') {
        fragment.appendChild(this.renderCategory(item));
      } else {
        fragment.appendChild(this.renderChannel(item, favorites));
      }
    }

    this.content.innerHTML = '';
    this.content.style.transform = `translateY(${offsetTop}px)`;
    this.content.appendChild(fragment);

    // Process HTMX attributes on newly created elements
    if (typeof htmx !== 'undefined') {
      htmx.process(this.content);
    }
  }

  renderCategory(item) {
    const isCollapsed = this.collapsedCategories.has(item.id);
    const div = document.createElement('div');
    div.className = 'category-header';
    div.style.height = `${this.headerHeight}px`;
    div.dataset.categoryId = item.id;
    div.innerHTML = `
      <span class="category-name">${this.escapeHtml(item.name)}</span>
      <span class="category-toggle" style="${isCollapsed ? 'transform: rotate(-90deg)' : ''}">&#9662;</span>
    `;
    div.addEventListener('click', () => this.toggleCategory(item.id));
    return div;
  }

  renderChannel(item, favorites) {
    const isActive = item.streamId === this.activeStreamId;
    const isFavorite = favorites.includes(item.streamId);

    const a = document.createElement('a');
    a.href = `/play/${item.streamId}`;
    a.className = 'channel-item' + (isActive ? ' active' : '') + (isFavorite ? ' is-favorite' : '');
    a.dataset.streamId = item.streamId;
    a.style.height = `${this.itemHeight}px`;

    const iconHtml = item.iconUrl
      ? `<img class="channel-icon" src="${item.iconUrl}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : '<div class="channel-icon-placeholder"></div>';

    a.innerHTML = `
      ${iconHtml}
      <span class="channel-name">${this.escapeHtml(item.name)}</span>
      <button class="favorite-btn" data-stream-id="${item.streamId}" title="Toggle favorite">
        <svg class="heart-icon" viewBox="0 0 24 24" width="14" height="14">
          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
        </svg>
      </button>
    `;

    // HTMX attributes for SPA-like navigation
    a.setAttribute('hx-get', `/play/${item.streamId}`);
    a.setAttribute('hx-target', '#player-container');
    a.setAttribute('hx-push-url', 'true');

    // Store reference to virtual scroller for the click handler
    const self = this;
    a.addEventListener('click', (e) => {
      // Don't interfere with favorite button clicks
      if (e.target.closest('.favorite-btn')) {
        return;
      }
      
      // Prevent default link navigation - let HTMX handle it
      e.preventDefault();
      self.setActive(item.streamId);
      
      // Clean up current player before loading new one
      lastInitUrl = '';
      lastInitTime = 0;
      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }
      stopStatsUpdates();

      // Trigger HTMX request manually
      if (typeof htmx !== 'undefined') {
        htmx.ajax('GET', `/play/${item.streamId}`, {
          target: '#player-container',
          swap: 'innerHTML'
        }).then(() => {
          // Update URL after successful load
          history.pushState({}, '', `/play/${item.streamId}`);
        });
      }
    });

    return a;
  }

  toggleCategory(categoryId) {
    if (this.collapsedCategories.has(categoryId)) {
      this.collapsedCategories.delete(categoryId);
    } else {
      this.collapsedCategories.add(categoryId);
    }
    this.applyFilters();
  }

  setActive(streamId) {
    this.activeStreamId = streamId;
    this.render();
  }

  search(query) {
    this.searchQuery = query;
    this.applyFilters();
  }

  refresh() {
    this.applyFilters();
  }

  scrollToActive() {
    if (!this.activeStreamId) return;

    // First, find the channel in the full list to get its category
    const channel = this.flatItems.find(item => item.streamId === this.activeStreamId);
    if (channel && channel.categoryId) {
      // Expand the category if it's collapsed
      if (this.collapsedCategories.has(channel.categoryId)) {
        this.collapsedCategories.delete(channel.categoryId);
        this.applyFilters();
      }
    }

    // Now find in filtered items and scroll
    const index = this.filteredItems.findIndex(item => item.streamId === this.activeStreamId);
    if (index >= 0) {
      const top = this.getItemTop(index);
      this.container.scrollTo({ top, behavior: 'smooth' });
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Global virtual scroller instance
let virtualChannelList = null;

// Sidebar toggle
function toggleSidebar() {
  const app = document.querySelector(".app");
  if (app) {
    app.classList.toggle("sidebar-hidden");
    localStorage.setItem("sidebarHidden", app.classList.contains("sidebar-hidden"));
  }
}

// Check if we're on mobile
function isMobile() {
  return window.innerWidth <= 768;
}

// Close sidebar on mobile (used after channel selection)
function closeSidebarOnMobile() {
  if (isMobile()) {
    const app = document.querySelector(".app");
    if (app && !app.classList.contains("sidebar-hidden")) {
      app.classList.add("sidebar-hidden");
      localStorage.setItem("sidebarHidden", "true");
    }
  }
}

// Categories popup
function toggleCategoriesPopup() {
  const popup = document.getElementById("categories-popup");
  const overlay = document.getElementById("categories-overlay");
  if (popup) {
    popup.classList.toggle("show");
    if (overlay) overlay.classList.toggle("show");
    if (popup.classList.contains("show")) {
      const searchInput = popup.querySelector(".categories-popup-search input");
      if (searchInput) {
        searchInput.value = "";
        filterCategoryList("");
        searchInput.focus();
      }
    }
  }
}

function filterCategoryList(query) {
  const items = document.querySelectorAll(".category-filter-item");
  const lowerQuery = query.toLowerCase();
  items.forEach(item => {
    const name = item.querySelector("span")?.textContent?.toLowerCase() || "";
    item.style.display = name.includes(lowerQuery) ? "" : "none";
  });
  
  // Update button labels
  const showBtn = document.getElementById("show-all-btn");
  const hideBtn = document.getElementById("hide-all-btn");
  if (showBtn && hideBtn) {
    if (query.trim()) {
      showBtn.textContent = "Show Filtered";
      hideBtn.textContent = "Hide Filtered";
    } else {
      showBtn.textContent = "Show All";
      hideBtn.textContent = "Hide All";
    }
  }
}

function toggleCategory(categoryId) {
  let hidden = JSON.parse(localStorage.getItem("hiddenCategories") || "[]");
  const index = hidden.indexOf(categoryId);
  if (index > -1) {
    hidden.splice(index, 1);
  } else {
    hidden.push(categoryId);
  }
  localStorage.setItem("hiddenCategories", JSON.stringify(hidden));
  applyCategoryFilters();
}

function toggleAllCategories(show) {
  const visibleCheckboxes = Array.from(document.querySelectorAll(".category-filter-item"))
    .filter(item => item.style.display !== "none")
    .map(item => item.querySelector("input[type='checkbox']"))
    .filter(Boolean);
  
  let hidden = JSON.parse(localStorage.getItem("hiddenCategories") || "[]");
  
  visibleCheckboxes.forEach(cb => {
    const catId = cb.dataset.categoryId;
    if (!catId) return;
    
    if (show) {
      cb.checked = true;
      hidden = hidden.filter(id => id !== catId);
    } else {
      cb.checked = false;
      if (!hidden.includes(catId)) {
        hidden.push(catId);
      }
    }
  });
  
  localStorage.setItem("hiddenCategories", JSON.stringify(hidden));
  applyCategoryFilters();
}

function applyCategoryFilters() {
  // Use virtual scroller if available
  if (virtualChannelList) {
    virtualChannelList.refresh();
    return;
  }

  // Fallback for non-virtual mode
  const hidden = JSON.parse(localStorage.getItem("hiddenCategories") || "[]");
  document.querySelectorAll(".category").forEach(cat => {
    const catId = cat.dataset?.categoryId;
    if (catId && hidden.includes(catId)) {
      cat.style.display = "none";
    } else {
      cat.style.display = "";
    }
  });
}

// Secret menu
function toggleSecretMenu() {
  const menu = document.getElementById("secret-menu");
  const overlay = document.getElementById("secret-overlay");
  if (menu) {
    const isShowing = !menu.classList.contains("show");
    menu.classList.toggle("show");
    if (overlay) overlay.classList.toggle("show");
    
    if (isShowing) {
      loadAccountInfo();
    }
  }
}

function loadAccountInfo() {
  const content = document.getElementById("secret-menu-content");
  if (!content) return;
  
  content.innerHTML = '<div class="secret-loading">Loading...</div>';
  
  fetch("/api/account")
    .then(res => res.json())
    .then(data => {
      const user = data.user_info || {};
      const server = data.server_info || {};
      
      const expDate = user.exp_date ? new Date(parseInt(user.exp_date) * 1000).toLocaleDateString() : "N/A";
      const isActive = user.status?.toLowerCase() === "active";
      
      content.innerHTML = `
        <div class="secret-section">
          <div class="secret-section-title">Account</div>
          <div class="secret-info-row">
            <span class="secret-info-label">Username</span>
            <span class="secret-info-value">${user.username || "N/A"}</span>
          </div>
          <div class="secret-info-row">
            <span class="secret-info-label">Status</span>
            <span class="secret-info-value ${isActive ? 'status-active' : 'status-expired'}">${user.status || "N/A"}</span>
          </div>
          <div class="secret-info-row">
            <span class="secret-info-label">Expires</span>
            <span class="secret-info-value">${expDate}</span>
          </div>
          <div class="secret-info-row">
            <span class="secret-info-label">Max Connections</span>
            <span class="secret-info-value">${user.max_connections || "N/A"}</span>
          </div>
          <div class="secret-info-row">
            <span class="secret-info-label">Active Connections</span>
            <span class="secret-info-value">${user.active_cons || "0"}</span>
          </div>
        </div>
        <div class="secret-section">
          <div class="secret-section-title">Server</div>
          <div class="secret-info-row">
            <span class="secret-info-label">URL</span>
            <span class="secret-info-value">${server.url || "N/A"}</span>
          </div>
          <div class="secret-info-row">
            <span class="secret-info-label">Port</span>
            <span class="secret-info-value">${server.port || "N/A"}</span>
          </div>
          <div class="secret-info-row">
            <span class="secret-info-label">Timezone</span>
            <span class="secret-info-value">${server.timezone || "N/A"}</span>
          </div>
        </div>
      `;
    })
    .catch(err => {
      content.innerHTML = '<div class="secret-loading">Failed to load account info</div>';
    });
}

// Favorites management
function getFavorites() {
  return JSON.parse(localStorage.getItem("favoriteChannels") || "[]");
}

function isFavorite(streamId) {
  return getFavorites().includes(streamId);
}

function toggleFavorite(streamId) {
  let favorites = getFavorites();
  const index = favorites.indexOf(streamId);
  if (index > -1) {
    favorites.splice(index, 1);
  } else {
    favorites.push(streamId);
  }
  localStorage.setItem("favoriteChannels", JSON.stringify(favorites));
  applyFavoriteStates();
  applyFavoritesFilter();
}

// Event delegation for favorite buttons
document.addEventListener("click", function(e) {
  const favoriteBtn = e.target.closest(".favorite-btn");
  if (favoriteBtn) {
    e.preventDefault();
    e.stopPropagation();
    const streamId = favoriteBtn.dataset.streamId;
    if (streamId) {
      toggleFavorite(streamId);
    }
  }
});

function applyFavoriteStates() {
  const favorites = getFavorites();
  document.querySelectorAll(".channel-item").forEach(item => {
    const streamId = item.dataset.streamId;
    if (streamId && favorites.includes(streamId)) {
      item.classList.add("is-favorite");
    } else {
      item.classList.remove("is-favorite");
    }
  });
}

function toggleFavoritesFilter() {
  const isActive = localStorage.getItem("showFavoritesOnly") === "true";
  localStorage.setItem("showFavoritesOnly", !isActive);
  applyFavoritesFilter();
  updateFavoritesButton();
}

function applyFavoritesFilter() {
  // Use virtual scroller if available
  if (virtualChannelList) {
    virtualChannelList.refresh();
    return;
  }

  // Fallback for non-virtual mode
  const showFavoritesOnly = localStorage.getItem("showFavoritesOnly") === "true";
  const favorites = getFavorites();

  document.querySelectorAll(".channel-item").forEach(item => {
    const streamId = item.dataset.streamId;
    if (showFavoritesOnly && streamId && !favorites.includes(streamId)) {
      item.style.display = "none";
    } else {
      item.style.display = "";
    }
  });

  // Hide empty categories when filtering
  document.querySelectorAll(".category").forEach(cat => {
    const visibleChannels = cat.querySelectorAll(".channel-item:not([style*='display: none'])");
    if (showFavoritesOnly && visibleChannels.length === 0) {
      cat.classList.add("hidden-by-favorites");
    } else {
      cat.classList.remove("hidden-by-favorites");
    }
  });
}

function updateFavoritesButton() {
  const btn = document.getElementById("favorites-btn");
  if (btn) {
    const isActive = localStorage.getItem("showFavoritesOnly") === "true";
    btn.classList.toggle("active", isActive);
  }
}

// Restore sidebar and category states on load
(function() {
  document.addEventListener("DOMContentLoaded", function() {
    const app = document.querySelector(".app");

    // Restore sidebar state (only applies on desktop/landscape)
    if (localStorage.getItem("sidebarHidden") === "true") {
      if (app) app.classList.add("sidebar-hidden");
    }

    // Restore category checkbox states
    const hidden = JSON.parse(localStorage.getItem("hiddenCategories") || "[]");
    document.querySelectorAll(".category-filter-item input[type='checkbox']").forEach(cb => {
      if (cb.dataset.categoryId && hidden.includes(cb.dataset.categoryId)) {
        cb.checked = false;
      }
    });
    applyCategoryFilters();

    // Restore favorites states
    applyFavoriteStates();
    applyFavoritesFilter();
    updateFavoritesButton();
  });
})();



// Playback control functions
function togglePlay() {
  const video = document.getElementById("video-player");
  if (!video) return;
  
  if (video.paused) {
    video.play().catch(() => {}); // Ignore abort errors
  } else {
    video.pause();
  }
  updatePlayIcon();
}

function updatePlayIcon() {
  const video = document.getElementById("video-player");
  const icon = document.getElementById("play-icon");
  if (!video || !icon) return;
  
  if (video.paused) {
    // Show play icon
    icon.innerHTML = '<path d="M8 5v14l11-7z"/>';
  } else {
    // Show pause icon
    icon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
  }
}

function toggleFullscreen() {
  const video = document.getElementById("video-player");
  if (!video) return;
  
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    video.requestFullscreen();
  }
}

// Picture-in-Picture
let pipRequestPending = false;
let documentPipWindow = null; // For Document PIP API
let pipCloneVideo = null; // Clone video for safe PiP (avoids Chrome GPU crash)

// Check if Document Picture-in-Picture API is available (requires secure context)
function hasDocumentPiP() {
  return 'documentPictureInPicture' in window;
}

// Try Document PIP API first (Chrome 116+)
async function enterDocumentPiP(video) {
  if (!hasDocumentPiP()) {
    return false;
  }

  try {
    documentPipWindow = await window.documentPictureInPicture.requestWindow({
      width: video.videoWidth || 640,
      height: video.videoHeight || 360,
    });

    const style = documentPipWindow.document.createElement('style');
    style.textContent = `
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { background: #000; overflow: hidden; }
      video { width: 100%; height: 100%; object-fit: contain; }
    `;
    documentPipWindow.document.head.appendChild(style);
    documentPipWindow.document.body.appendChild(video);

    documentPipWindow.addEventListener('pagehide', () => {
      const playerWrapper = document.getElementById('player-wrapper');
      if (playerWrapper && video && !playerWrapper.querySelector('video')) {
        playerWrapper.insertBefore(video, playerWrapper.firstChild);
      } else if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
      documentPipWindow = null;
      updatePiPIcon();
    });

    return true;
  } catch (err) {
    console.error("Document PIP failed:", err.message);
    if (documentPipWindow) {
      documentPipWindow.close();
      documentPipWindow = null;
    }
    return false;
  }
}

let pipCanvas = null;
let pipCanvasRAF = null;
let pipPopup = null; // Popup window for PiP (avoids Chrome PiP API crash)

function destroyPipClone() {
  if (pipCanvasRAF) {
    cancelAnimationFrame(pipCanvasRAF);
    pipCanvasRAF = null;
  }
  if (pipPopup && !pipPopup.closed) {
    pipPopup.close();
  }
  pipPopup = null;
  pipCloneVideo = null;
  pipCanvas = null;
}

function togglePiP() {
  const video = document.getElementById("video-player");
  if (!video) return;

  if (!hlsInstance && !documentPipWindow && !pipPopup) {
    return;
  }

  if (pipRequestPending) {
    return;
  }

  // Exit Document PiP
  if (documentPipWindow) {
    documentPipWindow.close();
    documentPipWindow = null;
    updatePiPIcon();
    return;
  }

  // Exit popup PiP
  if (pipPopup && !pipPopup.closed) {
    destroyPipClone();
    updatePiPIcon();
    return;
  }

  // Enter PiP
  if (video.readyState < 1) {
    video.addEventListener("loadedmetadata", function onMeta() {
      video.removeEventListener("loadedmetadata", onMeta);
      requestPiPSafely(video);
    });
    return;
  }

  requestPiPSafely(video);
}

async function requestPiPSafely(video) {
  if (pipRequestPending) return;

  pipRequestPending = true;

  if (!video || video.readyState < 1 || video.videoWidth === 0 || !hlsInstance) {
    pipRequestPending = false;
    return;
  }

  // Try Document PIP first (available over HTTPS/localhost)
  if (hasDocumentPiP()) {
    const success = await enterDocumentPiP(video);
    if (success) {
      pipRequestPending = false;
      updatePiPIcon();
      return;
    }
  }

  // Popup window PiP — avoids Chrome's PiP API entirely which crashes after
  // multiple HLS MediaSource attach/detach cycles
  try {
    destroyPipClone();

    const scale = Math.min(1, 640 / (video.videoWidth || 640));
    const cw = Math.round((video.videoWidth || 640) * scale);
    const ch = Math.round((video.videoHeight || 360) * scale);

    pipPopup = window.open('', 'telecast-pip',
      'width=' + cw + ',height=' + ch +
      ',left=' + (screen.width - cw - 30) +
      ',top=' + (screen.height - ch - 100) +
      ',toolbar=no,menubar=no,location=no,status=no');

    if (!pipPopup) {
      console.error("Popup blocked");
      pipRequestPending = false;
      return;
    }

    pipPopup.document.write('<!DOCTYPE html><html><head><style>*{margin:0;padding:0}body{background:#000;overflow:hidden}canvas{width:100%;height:100%}</style></head><body></body></html>');
    pipPopup.document.close();
    pipPopup.document.title = 'Telecast PiP';

    pipCanvas = pipPopup.document.createElement('canvas');
    pipCanvas.width = cw;
    pipCanvas.height = ch;
    pipPopup.document.body.appendChild(pipCanvas);
    const ctx = pipCanvas.getContext('2d');

    function drawFrame() {
      if (!pipCanvas || !pipPopup || pipPopup.closed) {
        pipCanvasRAF = null;
        destroyPipClone();
        updatePiPIcon();
        return;
      }
      const v = document.getElementById('video-player');
      if (v && v.readyState >= 2) {
        ctx.drawImage(v, 0, 0, cw, ch);
      }
      pipCanvasRAF = requestAnimationFrame(drawFrame);
    }
    drawFrame();

    // Detect manual close
    const closeCheck = setInterval(() => {
      if (!pipPopup || pipPopup.closed) {
        clearInterval(closeCheck);
        pipPopup = null;
        if (pipCanvasRAF) { cancelAnimationFrame(pipCanvasRAF); pipCanvasRAF = null; }
        pipCanvas = null;
        updatePiPIcon();
      }
    }, 500);

    updatePiPIcon();
  } catch (err) {
    console.error("PiP error:", err.message);
    destroyPipClone();
  } finally {
    pipRequestPending = false;
  }
}

let lastInitTime = 0; // Track last initPlayer call time
let lastInitUrl = ''; // Track last stream URL to prevent duplicates

// Reset player state before HTMX swaps so new player can initialize
document.addEventListener('htmx:beforeSwap', function(e) {
  if (e.detail.target && e.detail.target.id === 'player-container') {
    lastInitUrl = '';
    lastInitTime = 0;
    stopStatsUpdates();

    // Pause canvas draw loop but DON'T destroy the PiP — we'll reconnect
    // it to the new video after the swap. Avoiding PiP exit/enter cycles
    // prevents Chrome GPU compositor crashes.
    if (pipCanvasRAF) {
      cancelAnimationFrame(pipCanvasRAF);
      pipCanvasRAF = null;
    }

    if (documentPipWindow) {
      const pipVideo = documentPipWindow.document.querySelector('video');
      if (pipVideo) {
        pipVideo.pause();
        pipVideo.removeAttribute('src');
        pipVideo.load();
      }
      documentPipWindow.close();
      documentPipWindow = null;
    }

    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }
  }
});

function updatePiPIcon() {
  const inPip = !!documentPipWindow || (pipPopup && !pipPopup.closed);
  const btn = document.getElementById("pip-btn");
  const icon = document.getElementById("pip-icon");
  if (!btn || !icon) return;

  if (inPip) {
    btn.classList.add("active");
    // Exit PiP icon
    icon.innerHTML = '<path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zM9 9h6v6H9z"/>';
  } else {
    btn.classList.remove("active");
    // Enter PiP icon
    icon.innerHTML = '<path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z"/>';
  }
}

// Volume control functions
function setVolume(value) {
  const video = document.getElementById("video-player");
  if (!video) return;
  
  const volume = value / 100;
  video.volume = volume;
  video.muted = volume === 0;
  savedVolume = value;
  localStorage.setItem("volume", value);
  updateVolumeIcon();
}

function toggleMute() {
  const video = document.getElementById("video-player");
  const slider = document.getElementById("volume-slider");
  if (!video) return;
  
  video.muted = !video.muted;
  savedMuted = video.muted;
  localStorage.setItem("muted", video.muted);
  if (video.muted) {
    slider.value = 0;
  } else {
    slider.value = savedVolume > 0 ? savedVolume : 100;
    video.volume = slider.value / 100;
  }
  updateVolumeIcon();
}

function updateVolumeIcon() {
  const video = document.getElementById("video-player");
  const btn = document.getElementById("volume-btn");
  const icon = document.getElementById("volume-icon");
  if (!video || !icon) return;
  
  const isMuted = video.muted || video.volume === 0;
  btn.classList.toggle("muted", isMuted);
  
  if (isMuted) {
    icon.innerHTML = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';
  } else if (video.volume < 0.5) {
    icon.innerHTML = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>';
  } else {
    icon.innerHTML = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
  }
}

function initVolumeControl() {
  const video = document.getElementById("video-player");
  const slider = document.getElementById("volume-slider");
  if (!video || !slider) return;
  
  // Restore saved volume
  slider.value = savedVolume;
  video.volume = savedVolume / 100;
  updateVolumeIcon();
}

// Set active channel in sidebar (called on click)
function setActiveChannel(element) {
  document.querySelectorAll(".channel-item.active").forEach((el) => {
    el.classList.remove("active");
  });
  element.classList.add("active");
}

// Highlight active channel by stream ID (called after player loads)
function highlightActiveChannel(streamId) {
  if (!streamId) return;
  document.querySelectorAll(".channel-item.active").forEach((el) => {
    el.classList.remove("active");
  });
  const activeChannel = document.querySelector(
    `.channel-item[data-stream-id="${streamId}"]`
  );
  if (activeChannel) {
    activeChannel.classList.add("active");
    // Scroll to put the active channel at the top of the list
    const channelList = document.getElementById("channel-list");
    if (channelList) {
      const listRect = channelList.getBoundingClientRect();
      const itemRect = activeChannel.getBoundingClientRect();
      const scrollOffset = itemRect.top - listRect.top + channelList.scrollTop;
      channelList.scrollTo({ top: scrollOffset, behavior: "smooth" });
    }
  }
}

// Format bitrate to human readable
function formatBitrate(bps) {
  if (!bps || bps === 0) return "--";
  if (bps >= 1000000) {
    return (bps / 1000000).toFixed(1) + " Mbps";
  }
  return (bps / 1000).toFixed(0) + " Kbps";
}

// Get current HLS level safely
function getCurrentLevel() {
  if (!hlsInstance || !hlsInstance.levels || hlsInstance.levels.length === 0) {
    return null;
  }
  // currentLevel can be -1 (auto), use loadLevel or first available level
  let levelIndex = hlsInstance.currentLevel;
  if (levelIndex < 0) {
    levelIndex = hlsInstance.loadLevel;
  }
  if (levelIndex < 0 || levelIndex >= hlsInstance.levels.length) {
    levelIndex = 0;
  }
  return hlsInstance.levels[levelIndex];
}

// Update stats display in player info bar
function updateStats() {
  const video = document.getElementById("video-player");
  if (!video) return;

  const level = hlsInstance ? getCurrentLevel() : null;

  // Resolution - prefer video element dimensions (actual rendered size)
  const resEl = document.getElementById("stat-resolution");
  if (resEl) {
    if (video.videoWidth && video.videoHeight) {
      resEl.textContent = `${video.videoWidth}x${video.videoHeight}`;
    } else if (level && level.width && level.height) {
      resEl.textContent = `${level.width}x${level.height}`;
    }
  }

  // Bitrate (current level or estimated)
  const bitrateEl = document.getElementById("stat-bitrate");
  if (bitrateEl) {
    if (level && level.bitrate) {
      bitrateEl.textContent = formatBitrate(level.bitrate);
    } else if (hlsInstance && hlsInstance.bandwidthEstimate) {
      // Fallback to bandwidth estimate
      bitrateEl.textContent = formatBitrate(hlsInstance.bandwidthEstimate);
    }
  }

  // Buffer health
  const bufferEl = document.getElementById("stat-buffer");
  if (bufferEl) {
    const buffered = video.buffered;
    if (buffered.length > 0) {
      const bufferEnd = buffered.end(buffered.length - 1);
      const bufferHealth = Math.max(0, bufferEnd - video.currentTime);
      bufferEl.textContent = bufferHealth.toFixed(1) + "s buf";

      // Update parent stat class for color coding
      const statDiv = bufferEl.closest(".stat");
      if (statDiv) {
        statDiv.classList.remove("stat-good", "stat-warn", "stat-bad");
        if (bufferHealth < 2) {
          statDiv.classList.add("stat-bad");
        } else if (bufferHealth < 5) {
          statDiv.classList.add("stat-warn");
        } else {
          statDiv.classList.add("stat-good");
        }
      }
    }
  }

  // Dropped frames
  const droppedEl = document.getElementById("stat-dropped");
  if (droppedEl) {
    const quality = video.getVideoPlaybackQuality
      ? video.getVideoPlaybackQuality()
      : null;
    if (quality) {
      const dropped = quality.droppedVideoFrames;
      droppedEl.textContent = dropped + " drop";

      const statDiv = droppedEl.closest(".stat");
      if (statDiv) {
        statDiv.classList.remove("stat-good", "stat-warn", "stat-bad");
        if (dropped > 100) {
          statDiv.classList.add("stat-bad");
        } else if (dropped > 10) {
          statDiv.classList.add("stat-warn");
        }
      }
    }
  }

}

// Start stats updates
function startStatsUpdates() {
  if (statsInterval) {
    clearInterval(statsInterval);
  }
  statsInterval = setInterval(updateStats, 1000);
  // Initial update
  setTimeout(updateStats, 500);
}

// Stop stats updates
function stopStatsUpdates() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}

async function initPlayer(videoElement, streamUrl) {
  const now = Date.now();
  if (!videoElement || !streamUrl) return;

  // Debounce rapid initPlayer calls (ignore if called within 500ms)
  // Also prevent re-init with the same URL
  if (now - lastInitTime < 500 || (lastInitUrl === streamUrl && hlsInstance)) {
    console.log('[Player] Skipping duplicate init for:', streamUrl);
    return;
  }
  lastInitTime = now;
  lastInitUrl = streamUrl;

  // Don't destroy canvas PiP on channel switch — just reconnect it after the
  // new video loads (see onManifestParsed). Destroying and recreating PiP
  // causes Chrome GPU crashes. Only clean up Document PiP.
  if (documentPipWindow) {
    documentPipWindow.close();
    documentPipWindow = null;
  }

  // Reset stats
  perfStats.loadStartTime = performance.now();
  perfStats.timeToFirstFrame = 0;
  perfStats.segmentLoadTimes = [];
  perfStats.errors = 0;
  perfStats.recoveries = 0;

  // Reset retry tracking
  networkRetryCount = 0;
  if (networkRetryTimeout) {
    clearTimeout(networkRetryTimeout);
    networkRetryTimeout = null;
  }

  // Stop existing stats updates
  stopStatsUpdates();

  // Restore volume and mute state from localStorage
  savedVolume = parseInt(localStorage.getItem("volume")) || 100;
  savedMuted = localStorage.getItem("muted") === "true";
  videoElement.volume = savedVolume / 100;
  videoElement.muted = savedMuted;
  
  // Update volume slider to match
  const slider = document.getElementById("volume-slider");
  if (slider) {
    slider.value = savedMuted ? 0 : savedVolume;
  }
  updateVolumeIcon();

  // Update play icon on state changes (use named functions to avoid duplicates)
  videoElement.onplay = updatePlayIcon;
  videoElement.onpause = function() {
    updatePlayIcon();
    // Debug: log why video paused
    const buffered = videoElement.buffered;
    const bufferHealth = buffered.length > 0 ? (buffered.end(buffered.length - 1) - videoElement.currentTime).toFixed(1) : 0;
    console.warn('[Player] Video paused - buffer:', bufferHealth + 's', 'readyState:', videoElement.readyState, 'networkState:', videoElement.networkState, 'error:', videoElement.error);
  };
  videoElement.onclick = togglePlay;
  videoElement.ondblclick = toggleFullscreen;

  // Debug: catch stall/waiting events
  videoElement.onstalled = function() {
    console.warn('[Player] Video stalled');
  };
  videoElement.onwaiting = function() {
    console.warn('[Player] Video waiting for data');
  };
  videoElement.onerror = function() {
    console.error('[Player] Video error:', videoElement.error);
  };
  
  // Remove any existing PiP listeners before adding new ones to prevent accumulation
  videoElement.removeEventListener("enterpictureinpicture", updatePiPIcon);
  videoElement.removeEventListener("leavepictureinpicture", updatePiPIcon);
  
  // Set up PiP event listeners on the new video element
  videoElement.addEventListener("enterpictureinpicture", updatePiPIcon);
  videoElement.addEventListener("leavepictureinpicture", updatePiPIcon);



  // Check if HLS.js is supported
  if (Hls.isSupported()) {
    // Destroy existing HLS instance to ensure clean state with new video element
    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }
    
    hlsInstance = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        // Larger buffers to survive spotty connections
        backBufferLength: 30,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        maxBufferSize: 60 * 1000 * 1000,
        maxBufferHole: 0.5,
        // Start at auto level for fastest initial load
        startLevel: -1,
        // Conservative ABR — react quickly to drops, slowly to gains
        abrEwmaDefaultEstimate: 500000,
        abrEwmaFastLive: 3,
        abrEwmaSlowLive: 9,
        // Generous timeouts and retries for unreliable connections
        maxLoadingDelay: 4,
        fragLoadingTimeOut: 20000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 1000,
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 4,
        manifestLoadingRetryDelay: 1000,
        levelLoadingTimeOut: 15000,
        levelLoadingMaxRetry: 4,
        levelLoadingRetryDelay: 1000,
        // Start loading immediately
        startFragPrefetch: true,
    });
    
    // Set up event handlers
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, onManifestParsed);
    hlsInstance.on(Hls.Events.FRAG_LOADED, onFragLoaded);
    hlsInstance.on(Hls.Events.ERROR, onHlsError);

    hlsInstance.loadSource(streamUrl);
    hlsInstance.attachMedia(videoElement);

  } else if (videoElement.canPlayType("application/vnd.apple.mpegurl")) {
    // Native HLS support (Safari)
    videoElement.src = streamUrl;
    videoElement.addEventListener("loadedmetadata", function () {
      videoElement.play().catch(() => {});
      updatePlayIcon();
    }, { once: true });
  }
}

function onManifestParsed() {
  hidePlayerError();
  const video = document.getElementById("video-player");
  if (!video) return;

  const userMuted = localStorage.getItem("muted") === "true";

  // If user has interacted, we can play unmuted (if they haven't muted)
  // Otherwise play muted to satisfy autoplay policy
  video.muted = hasUserInteracted ? userMuted : true;
  video.play().then(() => {
    updateVolumeIcon();
  }).catch(() => {});

  // Start stats updates once manifest is parsed
  startStatsUpdates();
  updatePlayIcon();
}

function onFragLoaded(event, data) {
  // Reset retry count on successful load
  networkRetryCount = 0;

  if (data.frag && data.frag.stats) {
    const loadTime = data.frag.stats.loading.end - data.frag.stats.loading.start;
    perfStats.segmentLoadTimes.push(loadTime);
    if (perfStats.segmentLoadTimes.length > 20) {
      perfStats.segmentLoadTimes.shift();
    }
  }
}

function onHlsError(event, data) {
  perfStats.errors++;

  if (data.fatal) {
    switch (data.type) {
      case Hls.ErrorTypes.NETWORK_ERROR:
        // Manifest errors (4xx/5xx) mean the stream URL is broken — fail fast
        if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR) {
          const httpCode = data.response ? data.response.code : 0;
          console.warn("Manifest load failed with HTTP", httpCode);
          hlsInstance.destroy();
          hlsInstance = null;
          notifyStreamStopped();
          if (httpCode >= 400) {
            showPlayerError("Stream unavailable (HTTP " + httpCode + ") — try switching channels");
          } else {
            showPlayerError("Stream unavailable — failed to load");
          }
          return;
        }
        if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT) {
          console.warn("Manifest load timed out");
          hlsInstance.destroy();
          hlsInstance = null;
          notifyStreamStopped();
          showPlayerError("Stream timed out — server not responding");
          return;
        }

        // Check if we've exceeded max retries
        if (networkRetryCount >= MAX_NETWORK_RETRIES) {
          console.warn("Max network retries exceeded, stopping playback");
          hlsInstance.destroy();
          hlsInstance = null;
          notifyStreamStopped();
          showPlayerError("Stream unavailable — connection failed after multiple retries");
          return;
        }

        // Cancel any pending retry
        if (networkRetryTimeout) {
          clearTimeout(networkRetryTimeout);
        }

        // Exponential backoff: 1s, 2s, 4s, 8s, 16s
        const delay = INITIAL_RETRY_DELAY * Math.pow(2, networkRetryCount);
        networkRetryCount++;
        perfStats.recoveries++;

        console.log(`Network error, retrying in ${delay}ms (attempt ${networkRetryCount}/${MAX_NETWORK_RETRIES})`);

        networkRetryTimeout = setTimeout(() => {
          if (hlsInstance) {
            hlsInstance.startLoad();
          }
        }, delay);
        break;

      case Hls.ErrorTypes.MEDIA_ERROR:
        perfStats.recoveries++;
        hlsInstance.recoverMediaError();
        break;

      default:
        // Unrecoverable error
        hlsInstance.destroy();
        hlsInstance = null;
        notifyStreamStopped();
        showPlayerError("Stream error — unable to play this channel");
        break;
    }
  } else if (data.response && data.response.code >= 400) {
    // Non-fatal HTTP errors from upstream (e.g. 405, 403, 404)
    const code = data.response.code;
    let message = "Stream error (" + code + ")";
    if (code === 403) message = "Stream access denied (403)";
    else if (code === 404) message = "Stream not found (404)";
    else if (code === 405) message = "Stream rejected by server (405)";
    else if (code === 410) message = "Stream no longer available (410)";
    else if (code >= 500) message = "Stream server error (" + code + ")";
    console.warn("[Player] Upstream HTTP error:", code, data.details);
  }
}

// Handle HTMX content swaps - reinitialize player
// Note: The inline PlayerScript also calls initPlayer, but the debounce will prevent duplicates
document.addEventListener("htmx:afterSwap", function (event) {
  const playerContainer = document.getElementById("player-container");
  if (playerContainer && playerContainer.contains(event.detail.target)) {
    // The inline PlayerScript in the swapped content will handle initialization
    // We only need to handle volume restoration here
    const video = document.getElementById("video-player");
    const slider = document.getElementById("volume-slider");
    if (video && slider) {
      const savedVol = parseInt(localStorage.getItem("volume")) || 100;
      const wasMuted = localStorage.getItem("muted") === "true";
      slider.value = wasMuted ? 0 : savedVol;
      video.removeAttribute("muted");
    }
    // Close sidebar on mobile after channel selection
    closeSidebarOnMobile();
  }
  
  // Reapply favorite states after channel list updates (e.g., search)
  const channelList = document.getElementById("channel-list");
  if (channelList && channelList.contains(event.detail.target)) {
    applyFavoriteStates();
    applyFavoritesFilter();
  }
});

function showPlayerError(message) {
  const overlay = document.getElementById("player-error");
  const msg = document.getElementById("player-error-message");
  if (overlay && msg) {
    msg.textContent = message;
    overlay.style.display = "flex";
  }
}

function hidePlayerError() {
  const overlay = document.getElementById("player-error");
  if (overlay) {
    overlay.style.display = "none";
  }
}

function retryStream() {
  hidePlayerError();
  const wrapper = document.getElementById("player-wrapper");
  const video = document.getElementById("video-player");
  if (wrapper && video) {
    const url = wrapper.dataset.streamUrl;
    lastInitUrl = null;
    lastInitTime = 0;
    initPlayer(video, url);
  }
}

// Notify server that stream stopped (allows health checks to resume)
function notifyStreamStopped() {
  navigator.sendBeacon("/api/stream/stopped", "");
}

// Cleanup on page unload
window.addEventListener("beforeunload", function () {
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
    notifyStreamStopped();
  }
  stopStatsUpdates();
});

// Keyboard shortcuts
document.addEventListener("keydown", function (e) {
  // Ignore if typing in an input
  if (e.target.tagName === "INPUT") return;

  const video = document.getElementById("video-player");

  switch (e.key) {
    case " ":
    case "k":
      if (!video) return;
      e.preventDefault();
      if (video.paused) {
        video.play().catch(() => {}); // Ignore abort errors
      } else {
        video.pause();
      }
      break;
    case "f":
      if (!video) return;
      e.preventDefault();
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        video.requestFullscreen();
      }
      break;
    case "m":
      if (!video) return;
      e.preventDefault();
      video.muted = !video.muted;
      break;
    case "ArrowUp":
      if (!video) return;
      e.preventDefault();
      video.volume = Math.min(1, video.volume + 0.1);
      break;
    case "ArrowDown":
      if (!video) return;
      e.preventDefault();
      video.volume = Math.max(0, video.volume - 0.1);
      break;
    case "s":
      e.preventDefault();
      toggleSidebar();
      break;
    case "i":
      e.preventDefault();
      toggleSecretMenu();
      break;
    case "p":
      if (!video) return;
      e.preventDefault();
      togglePiP();
      break;
  }
});

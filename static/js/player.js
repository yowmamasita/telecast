// Global player instance
let hlsInstance = null;
let statsInterval = null;
let savedVolume = parseInt(localStorage.getItem("volume")) || 100;
let savedMuted = localStorage.getItem("muted") === "true";
let hasUserInteracted = false;

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

// Sidebar toggle
function toggleSidebar() {
  const app = document.querySelector(".app");
  if (app) {
    app.classList.toggle("sidebar-hidden");
    localStorage.setItem("sidebarHidden", app.classList.contains("sidebar-hidden"));
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

// Restore sidebar and category states on load
(function() {
  document.addEventListener("DOMContentLoaded", function() {
    if (localStorage.getItem("sidebarHidden") === "true") {
      const app = document.querySelector(".app");
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
  });
})();



// Playback control functions
function togglePlay() {
  const video = document.getElementById("video-player");
  if (!video) return;
  
  if (video.paused) {
    video.play();
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
  
  // Scroll to put the active channel at the top of the list
  const channelList = document.getElementById("channel-list");
  if (channelList) {
    const listRect = channelList.getBoundingClientRect();
    const itemRect = element.getBoundingClientRect();
    const scrollOffset = itemRect.top - listRect.top + channelList.scrollTop;
    channelList.scrollTo({ top: scrollOffset, behavior: "smooth" });
  }
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

function initPlayer(videoElement, streamUrl) {
  if (!videoElement || !streamUrl) return;

  // Reset stats
  perfStats.loadStartTime = performance.now();
  perfStats.timeToFirstFrame = 0;
  perfStats.segmentLoadTimes = [];
  perfStats.errors = 0;
  perfStats.recoveries = 0;

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
  videoElement.onpause = updatePlayIcon;
  videoElement.onclick = togglePlay;
  videoElement.ondblclick = toggleFullscreen;

  // Check if HLS.js is supported
  if (Hls.isSupported()) {
    // Reuse existing HLS instance for faster switching
    if (hlsInstance) {
      hlsInstance.stopLoad();
      hlsInstance.detachMedia();
    } else {
      hlsInstance = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        // Smaller buffers for faster channel switching
        backBufferLength: 30,
        maxBufferLength: 10,
        maxMaxBufferLength: 30,
        maxBufferSize: 30 * 1000 * 1000,
        maxBufferHole: 0.5,
        // Start at auto level for fastest initial load
        startLevel: -1,
        // Higher initial estimate = start at higher quality faster
        abrEwmaDefaultEstimate: 1000000,
        abrEwmaFastLive: 3,
        abrEwmaSlowLive: 9,
        // Faster fragment loading
        maxLoadingDelay: 2,
        fragLoadingTimeOut: 10000,
        fragLoadingMaxRetry: 2,
        fragLoadingRetryDelay: 500,
        manifestLoadingTimeOut: 5000,
        manifestLoadingMaxRetry: 2,
        levelLoadingTimeOut: 5000,
        // Start loading immediately
        startFragPrefetch: true,
      });
      
      // Set up event handlers once
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, onManifestParsed);
      hlsInstance.on(Hls.Events.FRAG_LOADED, onFragLoaded);
      hlsInstance.on(Hls.Events.ERROR, onHlsError);
    }

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
        perfStats.recoveries++;
        hlsInstance.startLoad();
        break;
      case Hls.ErrorTypes.MEDIA_ERROR:
        perfStats.recoveries++;
        hlsInstance.recoverMediaError();
        break;
      default:
        hlsInstance.destroy();
        hlsInstance = null;
        break;
    }
  }
}

// Handle HTMX content swaps - reinitialize player
document.addEventListener("htmx:afterSwap", function (event) {
  const playerContainer = document.getElementById("player-container");
  if (playerContainer && playerContainer.contains(event.detail.target)) {
    const video = document.getElementById("video-player");
    const player = document.querySelector(".player");
    if (video && player) {
      const streamUrl = player.dataset.streamUrl;
      if (streamUrl) {
        // User clicked a channel, so we have interaction - can unmute
        // Restore volume/mute from localStorage
        const savedVol = parseInt(localStorage.getItem("volume")) || 100;
        const wasMuted = localStorage.getItem("muted") === "true";
        const slider = document.getElementById("volume-slider");
        if (slider) slider.value = wasMuted ? 0 : savedVol;
        
        // Remove muted attribute since user interacted
        video.removeAttribute("muted");
        
        initPlayer(video, streamUrl);
      }
    }
  }
});

// Cleanup on page unload
window.addEventListener("beforeunload", function () {
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  stopStatsUpdates();
});

// Keyboard shortcuts
document.addEventListener("keydown", function (e) {
  const video = document.getElementById("video-player");
  if (!video) return;

  // Ignore if typing in an input
  if (e.target.tagName === "INPUT") return;

  switch (e.key) {
    case " ":
    case "k":
      e.preventDefault();
      if (video.paused) {
        video.play();
      } else {
        video.pause();
      }
      break;
    case "f":
      e.preventDefault();
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        video.requestFullscreen();
      }
      break;
    case "m":
      e.preventDefault();
      video.muted = !video.muted;
      break;
    case "ArrowUp":
      e.preventDefault();
      video.volume = Math.min(1, video.volume + 0.1);
      break;
    case "ArrowDown":
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
  }
});

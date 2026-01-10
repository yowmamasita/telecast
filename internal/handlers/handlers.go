package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/bensarmiento/telecast/internal/db"
	"github.com/bensarmiento/telecast/internal/proxy"
	"github.com/bensarmiento/telecast/internal/sync"
	"github.com/bensarmiento/telecast/internal/xtream"
	"github.com/bensarmiento/telecast/templates"
)

type Handlers struct {
	db          *db.DB
	client      *xtream.Client
	proxy       *proxy.Proxy
	syncService *sync.Service
	logger      *slog.Logger
}

func New(database *db.DB, client *xtream.Client, proxyService *proxy.Proxy, syncService *sync.Service, logger *slog.Logger) *Handlers {
	return &Handlers{
		db:          database,
		client:      client,
		proxy:       proxyService,
		syncService: syncService,
		logger:      logger,
	}
}

// Index renders the main page
func (h *Handlers) Index(w http.ResponseWriter, r *http.Request) {
	categories, err := h.db.GetCategories()
	if err != nil {
		h.logger.Error("failed to get categories", "error", err)
		http.Error(w, "Failed to load categories", http.StatusInternalServerError)
		return
	}

	channels, err := h.db.GetChannels()
	if err != nil {
		h.logger.Error("failed to get channels", "error", err)
		http.Error(w, "Failed to load channels", http.StatusInternalServerError)
		return
	}

	count, _ := h.db.GetChannelCount()

	data := templates.IndexData{
		Categories:   categories,
		Channels:     channels,
		ChannelCount: count,
	}

	templates.Index(data).Render(r.Context(), w)
}

// Play renders the player for a specific channel
func (h *Handlers) Play(w http.ResponseWriter, r *http.Request) {
	streamID := r.PathValue("streamID")
	if streamID == "" {
		http.Error(w, "Missing stream ID", http.StatusBadRequest)
		return
	}

	channel, err := h.db.GetChannelByStreamID(streamID)
	if err != nil {
		h.logger.Error("failed to get channel", "error", err)
		http.Error(w, "Failed to load channel", http.StatusInternalServerError)
		return
	}
	if channel == nil {
		http.Error(w, "Channel not found", http.StatusNotFound)
		return
	}

	// Clear cache when changing channels to free up connection
	h.proxy.ClearCache()

	// Build the proxied stream URL
	originalURL := h.client.BuildStreamURLString(streamID, "m3u8")
	streamURL := "/api/stream?url=" + originalURL

	// Check if this is an HTMX request
	if r.Header.Get("HX-Request") == "true" {
		// Return just the player component
		templates.Player(channel, streamURL).Render(r.Context(), w)
		return
	}

	// Full page render
	categories, _ := h.db.GetCategories()
	channels, _ := h.db.GetChannels()
	count, _ := h.db.GetChannelCount()

	data := templates.IndexData{
		Categories:     categories,
		Channels:       channels,
		ChannelCount:   count,
		CurrentChannel: channel,
		StreamURL:      streamURL,
	}

	templates.Index(data).Render(r.Context(), w)
}

// SearchChannels handles channel search
func (h *Handlers) SearchChannels(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")

	var channels []*db.Channel
	var err error

	if query == "" {
		// Return full channel list grouped by category
		categories, _ := h.db.GetCategories()
		channels, err = h.db.GetChannels()
		if err != nil {
			h.logger.Error("failed to get channels", "error", err)
			http.Error(w, "Failed to search", http.StatusInternalServerError)
			return
		}
		templates.ChannelList(categories, channels, nil).Render(r.Context(), w)
		return
	}

	// Search channels
	channels, err = h.db.SearchChannels(query)
	if err != nil {
		h.logger.Error("failed to search channels", "error", err)
		http.Error(w, "Failed to search", http.StatusInternalServerError)
		return
	}

	templates.SearchResults(channels, nil).Render(r.Context(), w)
}

// Stream proxies the video stream
func (h *Handlers) Stream(w http.ResponseWriter, r *http.Request) {
	h.proxy.HandleStream(w, r)
}

// Image proxies channel icons
func (h *Handlers) Image(w http.ResponseWriter, r *http.Request) {
	h.proxy.HandleImage(w, r)
}

// APIChannels returns channels as JSON
func (h *Handlers) APIChannels(w http.ResponseWriter, r *http.Request) {
	channels, err := h.db.GetChannels()
	if err != nil {
		h.jsonError(w, "Failed to get channels", http.StatusInternalServerError)
		return
	}
	h.jsonResponse(w, channels)
}

// APICategories returns categories as JSON
func (h *Handlers) APICategories(w http.ResponseWriter, r *http.Request) {
	categories, err := h.db.GetCategories()
	if err != nil {
		h.jsonError(w, "Failed to get categories", http.StatusInternalServerError)
		return
	}
	h.jsonResponse(w, categories)
}

// APISync triggers a manual sync
func (h *Handlers) APISync(w http.ResponseWriter, r *http.Request) {
	go func() {
		if err := h.syncService.Sync(r.Context()); err != nil {
			h.logger.Error("manual sync failed", "error", err)
		}
	}()
	h.jsonResponse(w, map[string]string{"status": "sync started"})
}

// APISyncStatus returns the current sync status
func (h *Handlers) APISyncStatus(w http.ResponseWriter, r *http.Request) {
	lastSync, status, errMsg, err := h.syncService.GetStatus()
	if err != nil {
		h.jsonError(w, "Failed to get sync status", http.StatusInternalServerError)
		return
	}

	h.jsonResponse(w, map[string]interface{}{
		"last_sync": lastSync,
		"status":    status,
		"error":     errMsg,
	})
}

// APIAccountInfo returns IPTV account information
func (h *Handlers) APIAccountInfo(w http.ResponseWriter, r *http.Request) {
	auth, err := h.client.Authenticate()
	if err != nil {
		h.jsonError(w, "Failed to get account info", http.StatusInternalServerError)
		return
	}

	h.jsonResponse(w, map[string]interface{}{
		"user_info":   auth.UserInfo,
		"server_info": auth.ServerInfo,
	})
}

func (h *Handlers) jsonResponse(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func (h *Handlers) jsonError(w http.ResponseWriter, message string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}

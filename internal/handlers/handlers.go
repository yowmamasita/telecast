package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/bensarmiento/telecast/internal/accounts"
	"github.com/bensarmiento/telecast/internal/db"
	"github.com/bensarmiento/telecast/internal/proxy"
	"github.com/bensarmiento/telecast/internal/sync"
	"github.com/bensarmiento/telecast/templates"
)

type Handlers struct {
	db             *db.DB
	accountManager *accounts.Manager
	proxy          *proxy.Proxy
	syncService    *sync.Service
	logger         *slog.Logger
}

func New(database *db.DB, accountManager *accounts.Manager, proxyService *proxy.Proxy, syncService *sync.Service, logger *slog.Logger) *Handlers {
	return &Handlers{
		db:             database,
		accountManager: accountManager,
		proxy:          proxyService,
		syncService:    syncService,
		logger:         logger,
	}
}

// Index renders the main page
func (h *Handlers) Index(w http.ResponseWriter, r *http.Request) {
	count, _ := h.db.GetChannelCount()

	data := templates.IndexData{
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

	// Build the proxied stream URL using the best available account
	originalURL, acc, err := h.accountManager.BuildStreamURL(streamID, "m3u8")
	if err != nil {
		h.logger.Error("failed to get stream URL", "error", err)
		http.Error(w, "No available IPTV accounts", http.StatusServiceUnavailable)
		return
	}
	h.accountManager.SetCurrentStreamAccount(acc)
	streamURL := "/api/stream?url=" + originalURL

	// Check if this is an HTMX request
	if r.Header.Get("HX-Request") == "true" {
		// Return just the player component
		templates.Player(channel, streamURL).Render(r.Context(), w)
		return
	}

	// Full page render
	count, _ := h.db.GetChannelCount()

	data := templates.IndexData{
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

	type channelJSON struct {
		StreamID   string `json:"stream_id"`
		Name       string `json:"name"`
		CategoryID string `json:"category_id,omitempty"`
		IconURL    string `json:"icon_url,omitempty"`
	}

	result := make([]channelJSON, 0, len(channels))
	for _, ch := range channels {
		c := channelJSON{
			StreamID: ch.StreamID,
			Name:     ch.Name,
		}
		if ch.CategoryID.Valid {
			c.CategoryID = ch.CategoryID.String
		}
		if ch.IconURL.Valid {
			c.IconURL = ch.IconURL.String
		}
		result = append(result, c)
	}

	h.jsonResponse(w, result)
}

// APICategories returns categories as JSON
func (h *Handlers) APICategories(w http.ResponseWriter, r *http.Request) {
	categories, err := h.db.GetCategories()
	if err != nil {
		h.jsonError(w, "Failed to get categories", http.StatusInternalServerError)
		return
	}

	type categoryJSON struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}

	result := make([]categoryJSON, 0, len(categories))
	for _, cat := range categories {
		result = append(result, categoryJSON{
			ID:   cat.CategoryID,
			Name: cat.Name,
		})
	}

	h.jsonResponse(w, result)
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

// APIAccountInfo returns IPTV account information for all accounts
func (h *Handlers) APIAccountInfo(w http.ResponseWriter, r *http.Request) {
	allAccounts := h.accountManager.GetAllAccounts()

	type accountInfo struct {
		Name       string `json:"name"`
		Username   string `json:"username"`
		URL        string `json:"url"`
		MaxConn    int    `json:"max_connections"`
		ActiveConn int    `json:"active_connections"`
		LocalConn  int    `json:"local_connections"`
		Available  bool   `json:"available"`
		IsCurrent  bool   `json:"is_current"`
		Error      string `json:"error,omitempty"`
	}

	accounts := make([]accountInfo, 0, len(allAccounts))
	currentAcc := h.accountManager.GetCurrentStreamAccount()

	for _, acc := range allAccounts {
		info := accountInfo{
			Name:       acc.Account.Name,
			Username:   acc.Account.Username,
			URL:        acc.Account.URL,
			MaxConn:    acc.MaxConn,
			ActiveConn: acc.ActiveConn,
			LocalConn:  acc.LocalConn,
			Available:  acc.Available,
			IsCurrent:  currentAcc != nil && acc.Account.Name == currentAcc.Account.Name,
		}
		if acc.LastError != nil {
			info.Error = acc.LastError.Error()
		}
		accounts = append(accounts, info)
	}

	h.jsonResponse(w, map[string]interface{}{
		"accounts":       accounts,
		"total_accounts": len(accounts),
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

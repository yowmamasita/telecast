package accounts

import (
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/bensarmiento/telecast/internal/config"
	"github.com/bensarmiento/telecast/internal/xtream"
)

// AccountStatus holds the current state of an account
type AccountStatus struct {
	Account     config.Account
	Client      *xtream.Client
	MaxConn     int  // Maximum allowed connections
	ActiveConn  int  // Currently active connections from IPTV provider
	LocalConn   int  // Connections initiated by this instance
	Available   bool // Whether the account is available for use
	LastUpdated time.Time
	LastError   error
}

// Manager handles multiple IPTV accounts with load balancing
type Manager struct {
	accounts   []*AccountStatus
	mu         sync.RWMutex
	logger     *slog.Logger
	httpClient *http.Client

	// Track which account is being used for the current stream
	currentAccountIdx int
	currentStreamMu   sync.Mutex
}

// NewManager creates a new account manager from config
func NewManager(cfg []config.Account, logger *slog.Logger) (*Manager, error) {
	if len(cfg) == 0 {
		return nil, fmt.Errorf("no IPTV accounts configured")
	}

	m := &Manager{
		accounts: make([]*AccountStatus, 0, len(cfg)),
		logger:   logger,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		currentAccountIdx: -1,
	}

	for i, acc := range cfg {
		name := acc.Name
		if name == "" {
			name = fmt.Sprintf("account-%d", i+1)
		}

		client := xtream.NewClient(acc.URL, acc.Username, acc.Password)

		status := &AccountStatus{
			Account:   acc,
			Client:    client,
			Available: true,
		}
		status.Account.Name = name

		m.accounts = append(m.accounts, status)
		logger.Info("registered IPTV account", "name", name, "url", acc.URL, "username", acc.Username)
	}

	// Initial status refresh
	m.RefreshAllStatus()

	// Start background status refresh
	go m.backgroundRefresh()

	return m, nil
}

// backgroundRefresh periodically updates account status
func (m *Manager) backgroundRefresh() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		m.RefreshAllStatus()
	}
}

// RefreshAllStatus updates the status of all accounts
func (m *Manager) RefreshAllStatus() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, acc := range m.accounts {
		m.refreshAccountStatus(acc)
	}
}

// refreshAccountStatus updates a single account's status (must hold mu lock)
func (m *Manager) refreshAccountStatus(acc *AccountStatus) {
	auth, err := acc.Client.Authenticate()
	if err != nil {
		acc.Available = false
		acc.LastError = err
		acc.LastUpdated = time.Now()
		m.logger.Warn("failed to refresh account status",
			"account", acc.Account.Name,
			"error", err)
		return
	}

	if auth.UserInfo == nil {
		acc.Available = false
		acc.LastError = fmt.Errorf("invalid credentials")
		acc.LastUpdated = time.Now()
		return
	}

	maxConn, _ := strconv.Atoi(auth.UserInfo.MaxConn)
	activeConn, _ := strconv.Atoi(auth.UserInfo.ActiveConn)

	acc.MaxConn = maxConn
	acc.ActiveConn = activeConn
	acc.Available = auth.UserInfo.Status == "Active"
	acc.LastError = nil
	acc.LastUpdated = time.Now()

	m.logger.Debug("refreshed account status",
		"account", acc.Account.Name,
		"max_conn", maxConn,
		"active_conn", activeConn,
		"available", acc.Available)
}

// GetBestAccount returns the account with the most available connection capacity.
// It uses a load balancing strategy based on (maxConn - activeConn - localConn).
func (m *Manager) GetBestAccount() (*AccountStatus, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var best *AccountStatus
	bestCapacity := -1

	for _, acc := range m.accounts {
		if !acc.Available {
			continue
		}

		// Calculate available capacity
		// maxConn=0 means unlimited
		var capacity int
		if acc.MaxConn == 0 {
			capacity = 1000 // Treat unlimited as very high
		} else {
			capacity = acc.MaxConn - acc.ActiveConn - acc.LocalConn
		}

		if capacity > bestCapacity {
			bestCapacity = capacity
			best = acc
		}
	}

	if best == nil {
		return nil, fmt.Errorf("no available accounts")
	}

	if bestCapacity <= 0 && best.MaxConn > 0 {
		m.logger.Warn("all accounts at capacity, using least loaded",
			"account", best.Account.Name,
			"capacity", bestCapacity)
	}

	return best, nil
}

// GetAccountByName returns a specific account by name
func (m *Manager) GetAccountByName(name string) (*AccountStatus, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for _, acc := range m.accounts {
		if acc.Account.Name == name {
			return acc, nil
		}
	}

	return nil, fmt.Errorf("account not found: %s", name)
}

// GetAllAccounts returns a copy of all account statuses
func (m *Manager) GetAllAccounts() []AccountStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]AccountStatus, len(m.accounts))
	for i, acc := range m.accounts {
		result[i] = *acc
	}
	return result
}

// AcquireConnection marks a connection as in use for an account
func (m *Manager) AcquireConnection(acc *AccountStatus) {
	m.mu.Lock()
	defer m.mu.Unlock()

	acc.LocalConn++
	m.logger.Debug("acquired connection",
		"account", acc.Account.Name,
		"local_conn", acc.LocalConn)
}

// ReleaseConnection marks a connection as released for an account
func (m *Manager) ReleaseConnection(acc *AccountStatus) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if acc.LocalConn > 0 {
		acc.LocalConn--
	}
	m.logger.Debug("released connection",
		"account", acc.Account.Name,
		"local_conn", acc.LocalConn)
}

// GetPrimaryClient returns the client from the first account (for sync operations)
func (m *Manager) GetPrimaryClient() *xtream.Client {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if len(m.accounts) > 0 {
		return m.accounts[0].Client
	}
	return nil
}

// GetCurrentStreamAccount returns the account currently being used for streaming
func (m *Manager) GetCurrentStreamAccount() *AccountStatus {
	m.currentStreamMu.Lock()
	defer m.currentStreamMu.Unlock()

	m.mu.RLock()
	defer m.mu.RUnlock()

	if m.currentAccountIdx >= 0 && m.currentAccountIdx < len(m.accounts) {
		return m.accounts[m.currentAccountIdx]
	}
	return nil
}

// SetCurrentStreamAccount sets which account is being used for the current stream
func (m *Manager) SetCurrentStreamAccount(acc *AccountStatus) {
	m.currentStreamMu.Lock()
	defer m.currentStreamMu.Unlock()

	m.mu.RLock()
	defer m.mu.RUnlock()

	for i, a := range m.accounts {
		if a == acc {
			m.currentAccountIdx = i
			m.logger.Info("switched streaming account",
				"account", acc.Account.Name)
			return
		}
	}
}

// BuildStreamURL builds a stream URL using the best available account
func (m *Manager) BuildStreamURL(streamID string, format string) (string, *AccountStatus, error) {
	acc, err := m.GetBestAccount()
	if err != nil {
		return "", nil, err
	}

	url := acc.Client.BuildStreamURLString(streamID, format)
	return url, acc, nil
}

// AccountCount returns the number of configured accounts
func (m *Manager) AccountCount() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.accounts)
}

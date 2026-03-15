package sync

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/bensarmiento/telecast/internal/db"
	"github.com/bensarmiento/telecast/internal/xtream"
)

type Service struct {
	db       *db.DB
	client   *xtream.Client
	interval time.Duration
	logger   *slog.Logger
}

func NewService(database *db.DB, client *xtream.Client, interval time.Duration, logger *slog.Logger) *Service {
	return &Service{
		db:       database,
		client:   client,
		interval: interval,
		logger:   logger,
	}
}

// Start begins the background sync service
func (s *Service) Start(ctx context.Context) {
	s.logger.Info("starting sync service", "interval", s.interval)

	// Initial sync
	if err := s.Sync(ctx); err != nil {
		s.logger.Error("initial sync failed", "error", err)
	}

	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			s.logger.Info("running scheduled sync")
			if err := s.Sync(ctx); err != nil {
				s.logger.Error("scheduled sync failed", "error", err)
			}
		case <-ctx.Done():
			s.logger.Info("sync service stopped")
			return
		}
	}
}

// Sync performs a full sync of categories and channels
func (s *Service) Sync(ctx context.Context) error {
	s.logger.Info("starting sync")
	s.updateStatus("syncing", "")

	startTime := time.Now()

	// Authenticate first
	auth, err := s.client.Authenticate()
	if err != nil {
		s.updateStatus("error", err.Error())
		return fmt.Errorf("authentication failed: %w", err)
	}
	s.logger.Info("authenticated", "user", auth.UserInfo.Username, "status", auth.UserInfo.Status)

	// Clear stale data before syncing
	if err := s.db.DeleteAllChannels(); err != nil {
		s.logger.Error("failed to clear channels", "error", err)
	}
	if err := s.db.DeleteAllCategories(); err != nil {
		s.logger.Error("failed to clear categories", "error", err)
	}

	// Sync categories
	categories, err := s.client.GetLiveCategories()
	if err != nil {
		s.updateStatus("error", err.Error())
		return fmt.Errorf("failed to get categories: %w", err)
	}

	for _, cat := range categories {
		dbCat := &db.Category{
			CategoryID: cat.CategoryID,
			Name:       cat.CategoryName,
		}
		if cat.ParentID > 0 {
			dbCat.ParentID = sql.NullString{String: strconv.Itoa(cat.ParentID), Valid: true}
		}
		if err := s.db.UpsertCategory(dbCat); err != nil {
			s.logger.Error("failed to upsert category", "id", cat.CategoryID, "error", err)
		}
	}
	s.logger.Info("synced categories", "count", len(categories))

	// Sync all channels in one bulk fetch
	streams, err := s.client.GetLiveStreams()
	if err != nil {
		s.updateStatus("error", err.Error())
		return fmt.Errorf("failed to get live streams: %w", err)
	}

	for _, stream := range streams {
		ch := &db.Channel{
			StreamID: strconv.Itoa(stream.StreamID),
			Name:     stream.Name,
			Num:      stream.Num,
		}
		if stream.CategoryID != "" {
			ch.CategoryID = sql.NullString{String: stream.CategoryID, Valid: true}
		}
		if stream.StreamIcon != "" {
			ch.IconURL = sql.NullString{String: stream.StreamIcon, Valid: true}
		}
		if stream.EPGChannelID != "" {
			ch.EPGChannelID = sql.NullString{String: stream.EPGChannelID, Valid: true}
		}
		if err := s.db.UpsertChannel(ch); err != nil {
			s.logger.Error("failed to upsert channel", "id", stream.StreamID, "error", err)
		}
	}
	totalChannels := len(streams)

	duration := time.Since(startTime)
	s.logger.Info("sync completed", "channels", totalChannels, "categories", len(categories), "duration", duration)
	s.updateStatus("success", "")

	return nil
}

func (s *Service) updateStatus(status, errMsg string) {
	_, err := s.db.WriteExec(`
		UPDATE sync_status 
		SET last_sync = CURRENT_TIMESTAMP, status = ?, error = ?
		WHERE id = 1
	`, status, errMsg)
	if err != nil {
		s.logger.Error("failed to update sync status", "error", err)
	}
}

// GetStatus returns the current sync status
func (s *Service) GetStatus() (lastSync time.Time, status, errMsg string, err error) {
	var lastSyncPtr *time.Time
	var errMsgPtr *string

	err = s.db.QueryRow(`
		SELECT last_sync, status, error FROM sync_status WHERE id = 1
	`).Scan(&lastSyncPtr, &status, &errMsgPtr)

	if lastSyncPtr != nil {
		lastSync = *lastSyncPtr
	}
	if errMsgPtr != nil {
		errMsg = *errMsgPtr
	}

	return
}

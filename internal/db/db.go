package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

type DB struct {
	*sql.DB
}

func New(path string) (*DB, error) {
	// Ensure directory exists
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create database directory: %w", err)
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Enable WAL mode for better concurrent access
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		return nil, fmt.Errorf("failed to enable WAL mode: %w", err)
	}

	// Enable foreign keys
	if _, err := db.Exec("PRAGMA foreign_keys=ON"); err != nil {
		return nil, fmt.Errorf("failed to enable foreign keys: %w", err)
	}

	d := &DB{DB: db}
	if err := d.migrate(); err != nil {
		return nil, fmt.Errorf("failed to run migrations: %w", err)
	}

	return d, nil
}

func (d *DB) migrate() error {
	schema := `
	CREATE TABLE IF NOT EXISTS categories (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		category_id TEXT NOT NULL UNIQUE,
		name TEXT NOT NULL,
		parent_id TEXT,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);

	CREATE TABLE IF NOT EXISTS channels (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		stream_id TEXT NOT NULL UNIQUE,
		name TEXT NOT NULL,
		category_id TEXT,
		icon_url TEXT,
		epg_channel_id TEXT,
		num INTEGER,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE SET NULL
	);

	CREATE INDEX IF NOT EXISTS idx_channels_category ON channels(category_id);
	CREATE INDEX IF NOT EXISTS idx_channels_name ON channels(name COLLATE NOCASE);

	CREATE TABLE IF NOT EXISTS epg_programs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		channel_id TEXT NOT NULL,
		title TEXT NOT NULL,
		description TEXT,
		start_time INTEGER NOT NULL,
		end_time INTEGER NOT NULL
	);

	CREATE INDEX IF NOT EXISTS idx_epg_channel_time ON epg_programs(channel_id, start_time, end_time);

	CREATE TABLE IF NOT EXISTS sync_status (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		last_sync DATETIME,
		status TEXT,
		error TEXT
	);

	INSERT OR IGNORE INTO sync_status (id, status) VALUES (1, 'pending');
	`

	_, err := d.Exec(schema)
	return err
}

func (d *DB) Close() error {
	return d.DB.Close()
}

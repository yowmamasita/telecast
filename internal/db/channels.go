package db

import (
	"database/sql"
	"errors"
)

type Channel struct {
	ID           int64
	StreamID     string
	Name         string
	CategoryID   sql.NullString
	IconURL      sql.NullString
	EPGChannelID sql.NullString
	Num          int
}

func (d *DB) UpsertChannel(ch *Channel) error {
	_, err := d.WriteExec(`
		INSERT INTO channels (stream_id, name, category_id, icon_url, epg_channel_id, num, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(stream_id) DO UPDATE SET
			name = excluded.name,
			category_id = excluded.category_id,
			icon_url = excluded.icon_url,
			epg_channel_id = excluded.epg_channel_id,
			num = excluded.num,
			updated_at = CURRENT_TIMESTAMP
	`, ch.StreamID, ch.Name, ch.CategoryID, ch.IconURL, ch.EPGChannelID, ch.Num)
	return err
}

func (d *DB) GetChannels() ([]*Channel, error) {
	rows, err := d.Query(`
		SELECT id, stream_id, name, category_id, icon_url, epg_channel_id, num
		FROM channels
		ORDER BY name COLLATE NOCASE
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var channels []*Channel
	for rows.Next() {
		var ch Channel
		if err := rows.Scan(&ch.ID, &ch.StreamID, &ch.Name, &ch.CategoryID, &ch.IconURL, &ch.EPGChannelID, &ch.Num); err != nil {
			return nil, err
		}
		channels = append(channels, &ch)
	}
	return channels, rows.Err()
}

func (d *DB) GetChannelsByCategory(categoryID string) ([]*Channel, error) {
	rows, err := d.Query(`
		SELECT id, stream_id, name, category_id, icon_url, epg_channel_id, num
		FROM channels
		WHERE category_id = ?
		ORDER BY name COLLATE NOCASE
	`, categoryID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var channels []*Channel
	for rows.Next() {
		var ch Channel
		if err := rows.Scan(&ch.ID, &ch.StreamID, &ch.Name, &ch.CategoryID, &ch.IconURL, &ch.EPGChannelID, &ch.Num); err != nil {
			return nil, err
		}
		channels = append(channels, &ch)
	}
	return channels, rows.Err()
}

func (d *DB) GetChannelByStreamID(streamID string) (*Channel, error) {
	var ch Channel
	err := d.QueryRow(`
		SELECT id, stream_id, name, category_id, icon_url, epg_channel_id, num
		FROM channels
		WHERE stream_id = ?
	`, streamID).Scan(&ch.ID, &ch.StreamID, &ch.Name, &ch.CategoryID, &ch.IconURL, &ch.EPGChannelID, &ch.Num)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &ch, err
}

func (d *DB) SearchChannels(query string) ([]*Channel, error) {
	rows, err := d.Query(`
		SELECT id, stream_id, name, category_id, icon_url, epg_channel_id, num
		FROM channels
		WHERE name LIKE ?
		ORDER BY name COLLATE NOCASE
		LIMIT 100
	`, "%"+query+"%")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var channels []*Channel
	for rows.Next() {
		var ch Channel
		if err := rows.Scan(&ch.ID, &ch.StreamID, &ch.Name, &ch.CategoryID, &ch.IconURL, &ch.EPGChannelID, &ch.Num); err != nil {
			return nil, err
		}
		channels = append(channels, &ch)
	}
	return channels, rows.Err()
}

func (d *DB) GetChannelCount() (int, error) {
	var count int
	err := d.QueryRow("SELECT COUNT(*) FROM channels").Scan(&count)
	return count, err
}

func (d *DB) DeleteAllChannels() error {
	_, err := d.WriteExec("DELETE FROM channels")
	return err
}

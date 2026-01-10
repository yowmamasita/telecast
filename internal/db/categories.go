package db

import (
	"database/sql"
	"errors"
)

type Category struct {
	ID         int64
	CategoryID string
	Name       string
	ParentID   sql.NullString
}

func (d *DB) UpsertCategory(cat *Category) error {
	_, err := d.WriteExec(`
		INSERT INTO categories (category_id, name, parent_id)
		VALUES (?, ?, ?)
		ON CONFLICT(category_id) DO UPDATE SET
			name = excluded.name,
			parent_id = excluded.parent_id
	`, cat.CategoryID, cat.Name, cat.ParentID)
	return err
}

func (d *DB) GetCategories() ([]*Category, error) {
	rows, err := d.Query(`
		SELECT id, category_id, name, parent_id
		FROM categories
		ORDER BY name COLLATE NOCASE
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var categories []*Category
	for rows.Next() {
		var cat Category
		if err := rows.Scan(&cat.ID, &cat.CategoryID, &cat.Name, &cat.ParentID); err != nil {
			return nil, err
		}
		categories = append(categories, &cat)
	}
	return categories, rows.Err()
}

func (d *DB) GetCategoryByID(categoryID string) (*Category, error) {
	var cat Category
	err := d.QueryRow(`
		SELECT id, category_id, name, parent_id
		FROM categories
		WHERE category_id = ?
	`, categoryID).Scan(&cat.ID, &cat.CategoryID, &cat.Name, &cat.ParentID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &cat, err
}

func (d *DB) DeleteAllCategories() error {
	_, err := d.WriteExec("DELETE FROM categories")
	return err
}

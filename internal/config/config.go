package config

import (
	"fmt"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server   ServerConfig   `yaml:"server"`
	IPTV     IPTVConfig     `yaml:"iptv"`
	Sync     SyncConfig     `yaml:"sync"`
	Database DatabaseConfig `yaml:"database"`
}

// Account represents a single IPTV account with credentials
type Account struct {
	Name     string `yaml:"name"`     // Optional friendly name for the account
	URL      string `yaml:"url"`      // IPTV server URL
	Username string `yaml:"username"` // Account username
	Password string `yaml:"password"` // Account password
}

type ServerConfig struct {
	Host string `yaml:"host"`
	Port int    `yaml:"port"`
}

func (s ServerConfig) Addr() string {
	return fmt.Sprintf("%s:%d", s.Host, s.Port)
}

type IPTVConfig struct {
	// Single account config (legacy, still supported)
	URL      string `yaml:"url"`
	Username string `yaml:"username"`
	Password string `yaml:"password"`

	// Multiple accounts config (takes precedence if present)
	Accounts []Account `yaml:"accounts"`
}

// GetAccounts returns all configured accounts.
// If accounts array is defined, use that. Otherwise, create a single account from legacy config.
func (c *IPTVConfig) GetAccounts() []Account {
	if len(c.Accounts) > 0 {
		return c.Accounts
	}
	// Fallback to single account for backward compatibility
	if c.URL != "" && c.Username != "" && c.Password != "" {
		return []Account{
			{
				Name:     "default",
				URL:      c.URL,
				Username: c.Username,
				Password: c.Password,
			},
		}
	}
	return nil
}

type SyncConfig struct {
	Interval string `yaml:"interval"`
}

func (s SyncConfig) IntervalDuration() time.Duration {
	d, err := time.ParseDuration(s.Interval)
	if err != nil {
		return 15 * time.Minute // default
	}
	return d
}

type DatabaseConfig struct {
	Path string `yaml:"path"`
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file: %w", err)
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("failed to parse config: %w", err)
	}

	// Set defaults
	if cfg.Server.Host == "" {
		cfg.Server.Host = "0.0.0.0"
	}
	if cfg.Server.Port == 0 {
		cfg.Server.Port = 8080
	}
	if cfg.Sync.Interval == "" {
		cfg.Sync.Interval = "15m"
	}
	if cfg.Database.Path == "" {
		cfg.Database.Path = "./data/telecast.db"
	}

	return &cfg, nil
}

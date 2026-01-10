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

type ServerConfig struct {
	Host string `yaml:"host"`
	Port int    `yaml:"port"`
}

func (s ServerConfig) Addr() string {
	return fmt.Sprintf("%s:%d", s.Host, s.Port)
}

type IPTVConfig struct {
	URL      string `yaml:"url"`
	Username string `yaml:"username"`
	Password string `yaml:"password"`
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

package xtream

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

type Client struct {
	baseURL    string
	username   string
	password   string
	httpClient *http.Client
}

func NewClient(baseURL, username, password string) *Client {
	return &Client{
		baseURL:  baseURL,
		username: username,
		password: password,
		httpClient: &http.Client{
			Timeout: 120 * time.Second,
		},
	}
}

// AuthResponse represents the authentication response from Xtream API
type AuthResponse struct {
	UserInfo   *UserInfo   `json:"user_info"`
	ServerInfo *ServerInfo `json:"server_info"`
}

type UserInfo struct {
	Username   string `json:"username"`
	Password   string `json:"password"`
	Status     string `json:"status"`
	ExpDate    string `json:"exp_date"`
	MaxConn    string `json:"max_connections"`
	ActiveConn string `json:"active_cons"`
}

type ServerInfo struct {
	URL          string `json:"url"`
	Port         string `json:"port"`
	HTTPSPort    string `json:"https_port"`
	Protocol     string `json:"server_protocol"`
	Timezone     string `json:"timezone"`
	TimestampNow int64  `json:"timestamp_now"`
}

// Category represents a channel category
type Category struct {
	CategoryID   string `json:"category_id"`
	CategoryName string `json:"category_name"`
	ParentID     int    `json:"parent_id"`
}

// LiveStream represents a live TV channel
type LiveStream struct {
	Num          int    `json:"num"`
	Name         string `json:"name"`
	StreamType   string `json:"stream_type"`
	StreamID     int    `json:"stream_id"`
	StreamIcon   string `json:"stream_icon"`
	EPGChannelID string `json:"epg_channel_id"`
	Added        string `json:"added"`
	CategoryID   string `json:"category_id"`
	TVArchive    int    `json:"tv_archive"`
}

func (c *Client) buildAPIURL(action string, params map[string]string) string {
	u, _ := url.Parse(c.baseURL)
	u.Path = "/player_api.php"

	q := u.Query()
	q.Set("username", c.username)
	q.Set("password", c.password)
	if action != "" {
		q.Set("action", action)
	}
	for k, v := range params {
		q.Set(k, v)
	}
	u.RawQuery = q.Encode()

	return u.String()
}

func (c *Client) request(action string, params map[string]string, result interface{}) error {
	reqURL := c.buildAPIURL(action, params)

	resp, err := c.httpClient.Get(reqURL)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("request failed with status %d: %s", resp.StatusCode, string(body))
	}

	if err := json.NewDecoder(resp.Body).Decode(result); err != nil {
		return fmt.Errorf("failed to decode response: %w", err)
	}

	return nil
}

// Authenticate verifies credentials and returns server info
func (c *Client) Authenticate() (*AuthResponse, error) {
	var auth AuthResponse
	if err := c.request("", nil, &auth); err != nil {
		return nil, err
	}
	if auth.UserInfo == nil {
		return nil, fmt.Errorf("invalid credentials")
	}
	return &auth, nil
}

// GetLiveCategories returns all live TV categories
func (c *Client) GetLiveCategories() ([]Category, error) {
	var categories []Category
	if err := c.request("get_live_categories", nil, &categories); err != nil {
		return nil, err
	}
	return categories, nil
}

// GetLiveStreams returns all live TV channels
func (c *Client) GetLiveStreams() ([]LiveStream, error) {
	var streams []LiveStream
	if err := c.request("get_live_streams", nil, &streams); err != nil {
		return nil, err
	}
	return streams, nil
}

// GetLiveStreamsByCategory returns live TV channels for a specific category
func (c *Client) GetLiveStreamsByCategory(categoryID string) ([]LiveStream, error) {
	var streams []LiveStream
	params := map[string]string{"category_id": categoryID}
	if err := c.request("get_live_streams", params, &streams); err != nil {
		return nil, err
	}
	return streams, nil
}

// BuildStreamURL constructs the stream URL for a given stream ID
func (c *Client) BuildStreamURL(streamID int, format string) string {
	if format == "" {
		format = "m3u8"
	}
	return fmt.Sprintf("%s/live/%s/%s/%d.%s", c.baseURL, c.username, c.password, streamID, format)
}

// BuildStreamURLString constructs the stream URL for a given stream ID as string
func (c *Client) BuildStreamURLString(streamID string, format string) string {
	if format == "" {
		format = "m3u8"
	}
	return fmt.Sprintf("%s/live/%s/%s/%s.%s", c.baseURL, c.username, c.password, streamID, format)
}

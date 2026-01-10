package proxy

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// cacheEntry holds cached content with expiration
type cacheEntry struct {
	data        []byte
	contentType string
	expiry      time.Time
}

type Proxy struct {
	client    *http.Client
	userAgent string

	// Cache for segments and manifests (cleared on channel change)
	streamCache   map[string]*cacheEntry
	streamCacheMu sync.RWMutex

	// Separate cache for images (persists across channel changes)
	imageCache   map[string]*cacheEntry
	imageCacheMu sync.RWMutex

	// Semaphore to limit concurrent connections to IPTV server
	connSem chan struct{}

	// Track the current stream URL to detect channel changes
	currentStream   string
	currentStreamMu sync.Mutex
}

func New() *Proxy {
	// Custom transport with connection reuse optimized for single connection
	transport := &http.Transport{
		MaxIdleConns:        1,
		MaxIdleConnsPerHost: 1,
		MaxConnsPerHost:     1,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  false,
		ForceAttemptHTTP2:   false, // Stick to HTTP/1.1 for better compatibility
	}

	p := &Proxy{
		client: &http.Client{
			Transport: transport,
			Timeout:   0, // No timeout for streaming
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		userAgent:   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		streamCache: make(map[string]*cacheEntry),
		imageCache:  make(map[string]*cacheEntry),
		connSem:     make(chan struct{}, 1), // Allow only 1 concurrent connection
	}

	// Start cache cleanup goroutine
	go p.cleanupCache()

	return p
}

// cleanupCache removes expired entries periodically from both caches
func (p *Proxy) cleanupCache() {
	ticker := time.NewTicker(30 * time.Second)
	for range ticker.C {
		now := time.Now()

		// Clean stream cache
		p.streamCacheMu.Lock()
		for key, entry := range p.streamCache {
			if now.After(entry.expiry) {
				delete(p.streamCache, key)
			}
		}
		p.streamCacheMu.Unlock()

		// Clean image cache
		p.imageCacheMu.Lock()
		for key, entry := range p.imageCache {
			if now.After(entry.expiry) {
				delete(p.imageCache, key)
			}
		}
		p.imageCacheMu.Unlock()
	}
}

// getFromStreamCache returns cached stream content if available and not expired
func (p *Proxy) getFromStreamCache(key string) (*cacheEntry, bool) {
	p.streamCacheMu.RLock()
	defer p.streamCacheMu.RUnlock()

	entry, ok := p.streamCache[key]
	if !ok || time.Now().After(entry.expiry) {
		return nil, false
	}
	return entry, true
}

// setStreamCache stores stream content in cache
func (p *Proxy) setStreamCache(key string, data []byte, contentType string, ttl time.Duration) {
	p.streamCacheMu.Lock()
	defer p.streamCacheMu.Unlock()

	p.streamCache[key] = &cacheEntry{
		data:        data,
		contentType: contentType,
		expiry:      time.Now().Add(ttl),
	}
}

// getFromImageCache returns cached image content if available and not expired
func (p *Proxy) getFromImageCache(key string) (*cacheEntry, bool) {
	p.imageCacheMu.RLock()
	defer p.imageCacheMu.RUnlock()

	entry, ok := p.imageCache[key]
	if !ok || time.Now().After(entry.expiry) {
		return nil, false
	}
	return entry, true
}

// setImageCache stores image content in cache
func (p *Proxy) setImageCache(key string, data []byte, contentType string, ttl time.Duration) {
	p.imageCacheMu.Lock()
	defer p.imageCacheMu.Unlock()

	p.imageCache[key] = &cacheEntry{
		data:        data,
		contentType: contentType,
		expiry:      time.Now().Add(ttl),
	}
}

// acquireConnection acquires the connection semaphore
func (p *Proxy) acquireConnection() {
	p.connSem <- struct{}{}
}

// releaseConnection releases the connection semaphore
func (p *Proxy) releaseConnection() {
	<-p.connSem
}

// isIPTVServer checks if the URL is to the IPTV server (needs connection limiting)
func (p *Proxy) isIPTVServer(urlStr string) bool {
	// Limit connections only to the main IPTV server, not CDN/segment servers
	return strings.Contains(urlStr, "cdn-akm.me") ||
		strings.Contains(urlStr, "/live/") ||
		strings.Contains(urlStr, "/movie/") ||
		strings.Contains(urlStr, "/series/")
}

// HandleStream proxies a stream request, rewriting HLS manifests
func (p *Proxy) HandleStream(w http.ResponseWriter, r *http.Request) {
	streamURL := r.URL.Query().Get("url")
	if streamURL == "" {
		http.Error(w, "Missing url parameter", http.StatusBadRequest)
		return
	}

	// Check cache first for segments
	if entry, ok := p.getFromStreamCache(streamURL); ok {
		w.Header().Set("Content-Type", entry.contentType)
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("X-Cache", "HIT")
		w.Write(entry.data)
		return
	}

	// Acquire connection semaphore for IPTV server requests
	needsSem := p.isIPTVServer(streamURL)
	if needsSem {
		p.acquireConnection()
		defer p.releaseConnection()
	}

	// Create request to upstream
	req, err := http.NewRequestWithContext(r.Context(), "GET", streamURL, nil)
	if err != nil {
		http.Error(w, "Invalid URL", http.StatusBadRequest)
		return
	}

	// Set headers
	req.Header.Set("User-Agent", p.userAgent)
	req.Header.Set("Connection", "keep-alive")
	parsedURL, _ := url.Parse(streamURL)
	if parsedURL != nil {
		req.Header.Set("Origin", fmt.Sprintf("%s://%s", parsedURL.Scheme, parsedURL.Host))
		req.Header.Set("Referer", fmt.Sprintf("%s://%s/", parsedURL.Scheme, parsedURL.Host))
	}

	// Forward Range header for seeking
	if rangeHeader := r.Header.Get("Range"); rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}

	// Make request
	resp, err := p.client.Do(req)
	if err != nil {
		http.Error(w, fmt.Sprintf("Upstream error: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Handle redirects
	if resp.StatusCode == http.StatusMovedPermanently || resp.StatusCode == http.StatusFound ||
		resp.StatusCode == http.StatusSeeOther || resp.StatusCode == http.StatusTemporaryRedirect {
		location := resp.Header.Get("Location")
		if location != "" {
			newURL := fmt.Sprintf("/api/stream?url=%s", url.QueryEscape(location))
			http.Redirect(w, r, newURL, resp.StatusCode)
			return
		}
	}

	// Set CORS headers
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Range")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range")
	w.Header().Set("X-Cache", "MISS")

	// Check if this is an HLS manifest
	contentType := resp.Header.Get("Content-Type")
	isHLS := strings.Contains(contentType, "mpegurl") ||
		strings.Contains(contentType, "m3u") ||
		strings.HasSuffix(strings.ToLower(streamURL), ".m3u8") ||
		strings.HasSuffix(strings.ToLower(streamURL), ".m3u")

	if isHLS {
		p.handleHLSManifest(w, resp, streamURL)
		return
	}

	// Check if this is a segment (cache it)
	isSegment := strings.HasSuffix(strings.ToLower(streamURL), ".ts") ||
		strings.HasSuffix(strings.ToLower(streamURL), ".m4s") ||
		strings.HasSuffix(strings.ToLower(streamURL), ".mp4")

	if isSegment && resp.ContentLength > 0 && resp.ContentLength < 10*1024*1024 {
		// Cache segments up to 10MB for 60 seconds
		data, err := io.ReadAll(resp.Body)
		if err == nil {
			ct := contentType
			if ct == "" {
				ct = "video/mp2t"
			}
			p.setStreamCache(streamURL, data, ct, 60*time.Second)

			w.Header().Set("Content-Type", ct)
			w.Header().Set("Content-Length", fmt.Sprintf("%d", len(data)))
			w.WriteHeader(resp.StatusCode)
			w.Write(data)
			return
		}
	}

	// Forward headers for non-cached content
	for k, v := range resp.Header {
		if k != "Access-Control-Allow-Origin" {
			for _, vv := range v {
				w.Header().Add(k, vv)
			}
		}
	}
	w.WriteHeader(resp.StatusCode)

	// Stream the response with buffering
	buf := make([]byte, 32*1024) // 32KB buffer
	io.CopyBuffer(w, resp.Body, buf)
}

func (p *Proxy) handleHLSManifest(w http.ResponseWriter, resp *http.Response, originalURL string) {
	baseURL, _ := url.Parse(originalURL)

	// Read the entire manifest
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		http.Error(w, "Failed to read manifest", http.StatusBadGateway)
		return
	}

	// Process and rewrite the manifest
	var output bytes.Buffer
	scanner := bufio.NewScanner(bytes.NewReader(body))
	for scanner.Scan() {
		line := scanner.Text()

		// Rewrite URLs in the manifest
		if !strings.HasPrefix(line, "#") && strings.TrimSpace(line) != "" {
			segmentURL := resolveURL(baseURL, line)
			line = "/api/stream?url=" + url.QueryEscape(segmentURL)
		} else if strings.HasPrefix(line, "#EXT-X-KEY") && strings.Contains(line, "URI=") {
			line = p.rewriteKeyURI(line, baseURL)
		} else if strings.HasPrefix(line, "#EXT-X-MAP") && strings.Contains(line, "URI=") {
			line = p.rewriteMapURI(line, baseURL)
		}

		output.WriteString(line)
		output.WriteString("\n")
	}

	// Cache manifest for 2 seconds (HLS typically updates every few seconds)
	manifestData := output.Bytes()
	p.setStreamCache(originalURL, manifestData, "application/vnd.apple.mpegurl", 2*time.Second)

	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	w.Write(manifestData)
}

func (p *Proxy) rewriteKeyURI(line string, baseURL *url.URL) string {
	return p.rewriteURIAttribute(line, baseURL, `URI="`)
}

func (p *Proxy) rewriteMapURI(line string, baseURL *url.URL) string {
	return p.rewriteURIAttribute(line, baseURL, `URI="`)
}

func (p *Proxy) rewriteURIAttribute(line string, baseURL *url.URL, prefix string) string {
	start := strings.Index(line, prefix)
	if start == -1 {
		return line
	}
	start += len(prefix)

	end := strings.Index(line[start:], `"`)
	if end == -1 {
		return line
	}

	uri := line[start : start+end]
	absoluteURI := resolveURL(baseURL, uri)
	proxyURI := "/api/stream?url=" + url.QueryEscape(absoluteURI)

	return line[:start] + proxyURI + line[start+end:]
}

func resolveURL(base *url.URL, ref string) string {
	refURL, err := url.Parse(ref)
	if err != nil {
		return ref
	}

	if refURL.IsAbs() {
		return ref
	}

	return base.ResolveReference(refURL).String()
}

// HandleImage proxies image requests (for channel icons)
func (p *Proxy) HandleImage(w http.ResponseWriter, r *http.Request) {
	imageURL := r.URL.Query().Get("url")
	if imageURL == "" {
		http.Error(w, "Missing url parameter", http.StatusBadRequest)
		return
	}

	// Check image cache first
	if entry, ok := p.getFromImageCache(imageURL); ok {
		w.Header().Set("Content-Type", entry.contentType)
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("X-Cache", "HIT")
		w.Write(entry.data)
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), "GET", imageURL, nil)
	if err != nil {
		http.Error(w, "Invalid URL", http.StatusBadRequest)
		return
	}

	req.Header.Set("User-Agent", p.userAgent)

	resp, err := p.client.Do(req)
	if err != nil {
		http.Error(w, "Failed to fetch image", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Read and cache the image
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		http.Error(w, "Failed to read image", http.StatusBadGateway)
		return
	}

	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "image/jpeg"
	}

	// Cache images for 24 hours
	p.setImageCache(imageURL, data, contentType, 24*time.Hour)

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("X-Cache", "MISS")
	w.WriteHeader(resp.StatusCode)
	w.Write(data)
}

// ClearCache clears stream cache only (images are preserved)
func (p *Proxy) ClearCache() {
	p.streamCacheMu.Lock()
	defer p.streamCacheMu.Unlock()
	p.streamCache = make(map[string]*cacheEntry)
}
